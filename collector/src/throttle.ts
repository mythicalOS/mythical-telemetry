// Per-source throttling, and the trusted-proxy model that decides what "source"
// means (plan §5).
//
// THE TRUSTED-PROXY DECISION, STATED PLAINLY: `X-Forwarded-For` is NEVER
// trusted by default. `trustedProxyHops` defaults to 0, and at 0 the source is
// the peer address of the TCP connection — the only value in the request an
// attacker cannot choose.
//
// This matters in both directions and neither is safe to guess:
//
//   • Trust XFF when nothing sets it, and every attacker picks their own
//     throttle bucket. The per-source limiter becomes decoration.
//   • Ignore XFF behind a load balancer, and every request appears to come
//     from the balancer. The limiter then throttles the entire population as
//     one source — a self-inflicted outage the first time traffic is normal.
//
// So the operator states TWO things, and both are required together:
//
//   1. WHICH PEERS are their proxies (`trustedProxies`, addresses or CIDRs).
//      A hop count alone is not enough: it would honour the header from
//      whoever connected, so anyone with a direct route to the listener —
//      a sibling container, a misconfigured security group, a leaked internal
//      port — could hand themselves any bucket they liked. The header is read
//      only when the PEER is on this list.
//   2. HOW MANY of those proxies are in the chain (`trustedProxyHops`). The
//      rightmost N entries were appended by that infrastructure, so the client
//      address sits N from the right end. Anything an attacker prepends is to
//      the LEFT of that position and is ignored.
//
// `trustedProxies` MUST NAME EVERY PROXY IN THE CHAIN, not just the one that
// connects to this service. The declared hops are verified, not assumed: the
// entries to the right of the selected one are addresses the operator's own
// infrastructure appended, so each must itself be on the list. Verifying only
// the immediate peer made a chain of two or more exploitable by anyone able to
// reach an inner proxy directly — see `resolveSourceKey`.
//
// Every failure mode falls back to the peer address, never to a header value:
// an untrusted peer, a chain shorter than the declared hop count, a declared
// hop that is not one of the operator's proxies, or an implausible value all
// mean the request did not arrive the way the operator described.

import { addressKey, isTrustedPeer, type CidrPattern } from './ip';

export interface ServerLike {
  requestIP?: (req: Request) => { address: string } | null;
}

/**
 * Fall-back key for a peer the address parser does not understand — a unix
 * socket, or the "unknown" a server without `requestIP` yields. It is bounded
 * and comes from the runtime, never from the request.
 */
function opaquePeerKey(peer: string): string {
  return `peer:${peer.slice(0, 64)}`;
}

/**
 * Resolve the throttling key for a request.
 *
 * `trustedProxyHops` is how many of the operator's proxies are in the chain;
 * `trustedProxies` is which peers those are. Both are required before any
 * header is read — see the header comment.
 */
export function resolveSourceKey(
  req: Request,
  server: ServerLike | undefined,
  trustedProxyHops: number,
  trustedProxies: readonly CidrPattern[] = [],
): string {
  const peer = server?.requestIP?.(req)?.address ?? 'unknown';
  const peerKey = addressKey(peer) ?? opaquePeerKey(peer);
  if (trustedProxyHops <= 0) return peerKey;
  // The peer must be one of the operator's own proxies. A direct connection
  // never gets to choose its own bucket.
  if (!isTrustedPeer(peer, trustedProxies)) return peerKey;

  const header = req.headers.get('x-forwarded-for');
  if (!header) return peerKey;

  const parts = header.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const index = parts.length - trustedProxyHops;
  if (index < 0 || index >= parts.length) return peerKey;

  const candidate = parts[index];
  if (candidate === undefined) return peerKey;

  // EVERY ENTRY TO THE RIGHT OF THE SELECTED ONE MUST ALSO BE A TRUSTED PROXY.
  //
  // Those positions hold the addresses the operator's own infrastructure
  // appended as the request moved inward, so in the chain the operator
  // described they are, by definition, the operator's own proxies. Checking
  // only the immediate peer left the rest of the declared chain unverified,
  // and at `trustedProxyHops >= 2` that is a bypass rather than a nicety: an
  // attacker who can reach an INNER proxy directly — skipping an outer one, the
  // sibling-container / leaked-internal-port case this file already worries
  // about for the peer — supplies the entries that land in those positions
  // himself. The entry selected above is then one he wrote, so he picks his own
  // throttle bucket and can rotate it per request, which defeats the ingest
  // limiter, the read limiter and the new-identity limiter simultaneously. (At
  // one hop there is nothing to the right of the selected entry and the model
  // was always sound; this is what makes deeper chains sound too.)
  //
  // Consequence for configuration, and it is deliberate: `trustedProxies` must
  // list EVERY proxy in the chain, not merely the one that connects here. A
  // hop that is not on the list means the request did not arrive the way the
  // operator described, and — like every other mismatch in this function — that
  // falls back to the peer address rather than to a value from the header.
  for (let i = index + 1; i < parts.length; i += 1) {
    if (!isTrustedPeer(parts[i]!, trustedProxies)) return peerKey;
  }

  // The selected entry must PARSE as an address, and the key is derived from
  // its canonical bytes. A "looks address-ish" text test would let a caller
  // behind a misconfigured hop count mint unlimited near-miss buckets, and
  // would treat `10.0.0.1` and `::ffff:10.0.0.1` as two sources.
  return addressKey(candidate) ?? peerKey;
}

/**
 * In-memory token bucket, keyed by source.
 *
 * Explicitly NOT retention: process-lifetime only, never written to the
 * database, and holding nothing but a float and a timestamp per key.
 *
 * Memory is bounded in two stages. A sweep drops idle keys; if the map is
 * still over the hard ceiling after that, the oldest keys are evicted until it
 * is not. Eviction is a documented residual — a distributed flood from more
 * sources than the ceiling degrades the per-source limiter, which is why the
 * README names a WAF/edge rate-limit tier as the mitigation for that shape and
 * does not pretend this class handles it.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly limitPerWindow: number,
    private readonly windowMs: number,
    private readonly nowMs: () => number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Consume one token. Returns false when the source is over its limit. */
  allow(key: string): boolean {
    if (this.limitPerWindow <= 0) return true;
    const now = this.nowMs();
    if (this.buckets.size >= this.maxKeys) this.reclaim(now);

    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.limitPerWindow, last: now };
      this.buckets.set(key, b);
    } else {
      const refill = ((now - b.last) / this.windowMs) * this.limitPerWindow;
      if (refill > 0) {
        b.tokens = Math.min(this.limitPerWindow, b.tokens + refill);
        b.last = now;
      }
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Test/monitoring hook. */
  size(): number {
    return this.buckets.size;
  }

  private reclaim(now: number): void {
    // Stage 1: drop anything idle long enough to have fully refilled anyway —
    // its bucket carries no information.
    const idleMs = this.windowMs * 10;
    for (const [key, b] of this.buckets) {
      if (now - b.last > idleMs) this.buckets.delete(key);
    }
    if (this.buckets.size < this.maxKeys) return;

    // Stage 2: evict least-recently-seen down to half the ceiling.
    const entries = [...this.buckets.entries()].sort((a, b) => a[1].last - b[1].last);
    const target = Math.floor(this.maxKeys / 2);
    for (const [key] of entries) {
      if (this.buckets.size <= target) break;
      this.buckets.delete(key);
    }
  }
}
