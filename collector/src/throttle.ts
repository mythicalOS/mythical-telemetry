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
// So the operator states the number of proxies they run. With N trusted hops
// the rightmost N entries of the chain were appended by infrastructure the
// operator controls, and the client address is the (N)th from the right end of
// the list. Anything an attacker prepends sits to the LEFT of that position and
// is ignored.
//
// Every failure mode falls back to the peer address, never to a header value:
// a chain shorter than the declared hop count means the request did not come
// through the expected path, and an implausible address means the header is
// not what the operator thinks it is.

export interface ServerLike {
  requestIP?: (req: Request) => { address: string } | null;
}

/** Longest plausible textual address: 45 for IPv4-mapped IPv6, plus a zone id. */
const MAX_ADDRESS_LEN = 64;
/**
 * Address-ish characters only: hex digits and dots/colons, plus the letters,
 * digits, `-` and `_` an IPv6 zone id (an interface name) may carry.
 *
 * This is defence in depth, not the control. With N trusted hops the selected
 * position was written by the operator's own proxy, so an attacker cannot
 * choose it at all; the check bounds the damage of a MISCONFIGURED hop count,
 * where an attacker-supplied entry could be selected and would otherwise let
 * them mint unlimited distinct bucket keys.
 */
const PLAUSIBLE_ADDRESS_RE = /^[0-9a-zA-Z.:%_-]+$/;

function isPlausibleAddress(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ADDRESS_LEN) return false;
  if (!PLAUSIBLE_ADDRESS_RE.test(value)) return false;
  // Must look like an address of some family, not a bare number: an attacker
  // choosing arbitrary short strings would otherwise mint unlimited buckets.
  return value.includes('.') || value.includes(':');
}

/**
 * Resolve the throttling key for a request.
 *
 * `trustedProxyHops` is the number of reverse proxies the operator runs in
 * front of the collector. 0 (the default) means "trust nothing in the request".
 */
export function resolveSourceKey(req: Request, server: ServerLike | undefined, trustedProxyHops: number): string {
  const peer = server?.requestIP?.(req)?.address ?? 'unknown';
  if (trustedProxyHops <= 0) return peer;

  const header = req.headers.get('x-forwarded-for');
  if (!header) return peer;

  const parts = header.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const index = parts.length - trustedProxyHops;
  if (index < 0 || index >= parts.length) return peer;

  const candidate = parts[index];
  if (candidate === undefined || !isPlausibleAddress(candidate)) return peer;
  return candidate;
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
