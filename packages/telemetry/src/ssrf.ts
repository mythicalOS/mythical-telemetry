// Operator-endpoint isolation. THE COPY DESTINATION IS ATTACKER-CONTROLLED INPUT.
//
// An operator (or anyone who can write the product's config) supplies a URL that this process then
// fetches, from inside the deployment, with whatever network reach the container has. That is a
// textbook SSRF primitive: a compose-internal admin API, a cloud metadata endpoint, a database
// admin port — all reachable, none of them public.
//
// What this module enforces:
//   1. https only. http is permitted ONLY with an explicit opt-in AND only to a loopback address,
//      because "let me point it at my laptop" is a real development need and nothing else is.
//   2. NO REDIRECT FOLLOWING. node's http/https clients do not follow redirects, which is the
//      behaviour we want; a 3xx is surfaced as a failure. A follower would re-resolve a new host
//      after validation and undo every check below.
//   3. Resolve-and-block: loopback, link-local, RFC1918, CGNAT, ULA, IPv4-mapped IPv6, multicast
//      and reserved space are refused. EVERY address the name resolves to must pass, not just the
//      one we would have used — a round-robin name that answers with one public and one private
//      address is rejected outright.
//   4. THE CONNECTION IS PINNED TO THE VALIDATED ADDRESS. Validate-then-fetch leaves a
//      DNS-rebinding TOCTOU gap: validation sees a public address, the TTL expires, and the
//      connection resolves to 127.0.0.1. We resolve once, validate, then hand the socket layer a
//      `lookup` that can only return that exact address — there is no second resolution to race.
//      SNI and certificate verification still use the original hostname, so pinning does not
//      weaken TLS.
//   5. Hard per-attempt deadline enforced on the socket AND on the whole exchange, plus a bounded
//      response read. A slow-loris endpoint that accepts and dribbles bytes forever must not hold
//      a socket or a timer past the deadline.
//   6. Sockets are never pooled (`keepAlive: false`, one socket per attempt, destroyed on every
//      exit path) so a hostile endpoint cannot accumulate them.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";

export interface EndpointPolicy {
  /** Permit `http://` — ONLY honoured when the resolved address is loopback. Default false. */
  allowInsecureLoopback?: boolean;
  /**
   * Permit private/loopback/link-local destinations. Default false. This exists for tests and for
   * an operator running a collector on the same host who has decided that is what they want; it
   * is never a default and never inferred.
   */
  allowPrivateAddresses?: boolean;
  /** DNS resolver seam (tests). Defaults to `dns.promises.lookup`. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /**
   * Hard deadline on NAME RESOLUTION. Without it a hostile or broken resolver hangs the attempt
   * before `postPinned` ever arms its own timeout, so neither the per-attempt deadline nor the
   * fan-out budget applies and the single-flight slot is held forever. Default 5s.
   */
  resolveTimeoutMs?: number;
  /**
   * Cancels resolution. The opt-out fence and the overall budget must be able to reach a request
   * that is still waiting on DNS, not only one that has reached the socket.
   */
  signal?: AbortSignal;
}

const DEFAULT_RESOLVE_TIMEOUT_MS = 5_000;

export class EndpointRejected extends Error {
  constructor(
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "EndpointRejected";
  }
}

// ── address classification ─────────────────────────────────────────────────────────────────

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    bytes.push(n);
  }
  return bytes;
}

/** Parse an IPv6 literal (with `::` compression and an optional embedded IPv4 tail) to 16 bytes. */
function parseIPv6(text: string): number[] | undefined {
  let input = text;
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone); // a scoped literal is link-local; the zone is not an address
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon < 0) return undefined;
    const v4 = parseIPv4(input.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : undefined;

  const toBytes = (groups: string[]): number[] | undefined => {
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      const n = Number.parseInt(g, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };

  const headBytes = toBytes(head);
  if (headBytes === undefined) return undefined;
  if (tail === undefined) return headBytes.length === 16 ? headBytes : undefined;
  const tailBytes = toBytes(tail);
  if (tailBytes === undefined) return undefined;
  const fill = 16 - headBytes.length - tailBytes.length;
  if (fill < 0) return undefined;
  return [...headBytes, ...Array.from({ length: fill }, () => 0), ...tailBytes];
}

function blockedIPv4(b: number[]): string | undefined {
  const [a, second] = [b[0]!, b[1]!];
  if (a === 0) return "unspecified/this-network (0.0.0.0/8)";
  if (a === 10) return "private (10.0.0.0/8)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 100 && second >= 64 && second <= 127) return "carrier-grade NAT (100.64.0.0/10)";
  if (a === 169 && second === 254) return "link-local, incl. cloud metadata (169.254.0.0/16)";
  if (a === 172 && second >= 16 && second <= 31) return "private (172.16.0.0/12)";
  if (a === 192 && second === 0 && b[2] === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (a === 192 && second === 0 && b[2] === 2) return "documentation (192.0.2.0/24)";
  if (a === 192 && second === 88 && b[2] === 99) return "6to4 relay anycast (192.88.99.0/24)";
  if (a === 192 && second === 168) return "private (192.168.0.0/16)";
  if (a === 198 && (second === 18 || second === 19)) return "benchmarking (198.18.0.0/15)";
  if (a === 198 && second === 51 && b[2] === 100) return "documentation (198.51.100.0/24)";
  if (a === 203 && second === 0 && b[2] === 113) return "documentation (203.0.113.0/24)";
  if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
  if (a >= 240) return "reserved / broadcast (240.0.0.0/4)";
  return undefined;
}

function blockedIPv6(b: number[]): string | undefined {
  const allZero = b.every((x) => x === 0);
  if (allZero) return "unspecified (::)";
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return "loopback (::1)";

  // IPv4-mapped ::ffff:a.b.c.d and the deprecated IPv4-compatible ::a.b.c.d — both carry an
  // embedded IPv4 address that must be judged by the IPv4 rules, or ::ffff:127.0.0.1 walks in.
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  if (first10Zero && b[10] === 0xff && b[11] === 0xff) {
    const reason = blockedIPv4(b.slice(12));
    return reason === undefined ? undefined : `IPv4-mapped ${reason}`;
  }
  if (first10Zero && b[10] === 0 && b[11] === 0) {
    return "IPv4-compatible IPv6 (deprecated, ::a.b.c.d)";
  }
  // NAT64 well-known prefix 64:ff9b::/96 — another embedded-IPv4 path to an internal address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    const reason = blockedIPv4(b.slice(12));
    return reason === undefined ? undefined : `NAT64-embedded ${reason}`;
  }
  // 6to4 2002::/16 embeds an IPv4 address in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) {
    const reason = blockedIPv4(b.slice(2, 6));
    return reason === undefined ? undefined : `6to4-embedded ${reason}`;
  }

  if ((b[0]! & 0xfe) === 0xfc) return "unique local address (fc00::/7)";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link-local (fe80::/10)";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return "site-local (fec0::/10, deprecated)";
  if (b[0] === 0xff) return "multicast (ff00::/8)";
  if (b[0] === 0x01 && b.slice(1, 8).every((x) => x === 0)) return "discard-only (100::/64)";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation (2001:db8::/32)";
  return undefined;
}

/** The reason an address is refused, or undefined if it is a routable public address. */
export function blockedAddressReason(address: string): string | undefined {
  const v4 = parseIPv4(address);
  if (v4 !== undefined) return blockedIPv4(v4);
  const v6 = parseIPv6(address);
  if (v6 !== undefined) return blockedIPv6(v6);
  return "unparseable address";
}

/** True iff the address is loopback (the only address `allowInsecureLoopback` may unlock). */
export function isLoopbackAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== undefined) return v4[0] === 127;
  const v6 = parseIPv6(address);
  if (v6 === undefined) return false;
  if (v6.slice(0, 15).every((x) => x === 0) && v6[15] === 1) return true;
  const mapped = v6.slice(0, 10).every((x) => x === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped && v6[12] === 127;
}

// ── endpoint validation ────────────────────────────────────────────────────────────────────

export interface PinnedEndpoint {
  url: URL;
  /** The single address the connection is pinned to. There is no second resolution. */
  address: string;
  family: 4 | 6;
  /** True when the URL host was already an IP literal — SNI is then omitted. */
  literal: boolean;
}

const DENIED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa"];

/**
 * Parse, policy-check, resolve and pin an endpoint. Throws `EndpointRejected` with a machine-
 * readable `reason` — the caller surfaces it on the delivery status, so a misconfigured operator
 * endpoint produces an actionable message instead of silence.
 */
export async function resolveAndPin(rawUrl: string, policy: EndpointPolicy = {}): Promise<PinnedEndpoint> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EndpointRejected("invalid_url", "endpoint is not a valid absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EndpointRejected("scheme_not_allowed", `scheme ${url.protocol} is not http(s)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new EndpointRejected("credentials_in_url", "endpoint must not carry credentials in the URL");
  }
  if (url.protocol === "http:" && policy.allowInsecureLoopback !== true) {
    throw new EndpointRejected("https_required", "http is only permitted with an explicit loopback opt-in");
  }

  const host = url.hostname.toLowerCase();
  if (host === "") throw new EndpointRejected("invalid_url", "endpoint has no host");

  const literalHost = host.startsWith("[") ? host.slice(1, -1) : host;
  const isLiteral = net.isIP(literalHost) !== 0;

  if (!isLiteral) {
    if (host === "localhost" || DENIED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
      if (policy.allowPrivateAddresses !== true) {
        throw new EndpointRejected("host_not_routable", `host ${host} names a local/internal namespace`);
      }
    }
  }

  const resolved: Array<{ address: string; family: number }> = isLiteral
    ? [{ address: literalHost, family: net.isIP(literalHost) }]
    : await resolveAll(host, policy);

  if (resolved.length === 0) throw new EndpointRejected("dns_empty", `${host} resolved to no addresses`);

  if (policy.allowPrivateAddresses !== true) {
    // EVERY answer must pass. Checking only the one we would use lets a round-robin name that
    // answers {public, 127.0.0.1} through on the lucky draw.
    for (const entry of resolved) {
      const reason = blockedAddressReason(entry.address);
      if (reason !== undefined) {
        throw new EndpointRejected("address_blocked", `${host} resolves to a blocked address: ${reason}`);
      }
    }
  }

  const chosen = resolved[0]!;

  // http was unlocked by `allowInsecureLoopback`; that unlock is ONLY valid for loopback.
  if (url.protocol === "http:" && !isLoopbackAddress(chosen.address)) {
    throw new EndpointRejected("https_required", "http is permitted only to a loopback address");
  }

  const family = net.isIP(chosen.address) === 6 ? 6 : 4;
  return { url, address: chosen.address, family, literal: isLiteral };
}

async function resolveAll(host: string, policy: EndpointPolicy): Promise<Array<{ address: string; family: number }>> {
  const lookup =
    policy.lookup ??
    (async (h: string): Promise<Array<{ address: string; family: number }>> => {
      const results = await dns.promises.lookup(h, { all: true, verbatim: true });
      return results.map((r) => ({ address: r.address, family: r.family }));
    });

  // Checked BEFORE the lookup starts, not only raced against it: an already-settled lookup wins a
  // Promise.race against a synchronously-rejecting arm, so a pre-aborted attempt would still
  // resolve and go on to send.
  if (policy.signal?.aborted === true) throw new EndpointRejected("aborted", "resolution aborted before it started");

  // Resolution gets its own deadline and its own abort hook. Without them a resolver that never
  // answers hangs BEFORE postPinned arms anything, so neither the per-attempt timeout nor the
  // fan-out budget applies — and the caller's single-flight slot is held indefinitely, so every
  // later tick joins the stuck promise instead of retrying.
  const timeoutMs = policy.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      lookup(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EndpointRejected("dns_timeout", `resolving ${host} exceeded ${timeoutMs}ms`)), timeoutMs);
        if (policy.signal !== undefined) {
          if (policy.signal.aborted) {
            reject(new EndpointRejected("aborted", "resolution aborted"));
            return;
          }
          onAbort = (): void => reject(new EndpointRejected("aborted", "resolution aborted"));
          policy.signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } catch (err) {
    if (err instanceof EndpointRejected) throw err;
    throw new EndpointRejected("dns_failed", `could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) policy.signal?.removeEventListener("abort", onAbort);
  }
}

// ── the pinned request ─────────────────────────────────────────────────────────────────────

export interface PostResult {
  status: number;
  ok: boolean;
  /** A bounded, sanitised excerpt of a non-2xx body — the actionable half of a rejection. */
  detail: string | undefined;
}

export interface PostOptions {
  endpoint: PinnedEndpoint;
  body: string;
  headers: Record<string, string>;
  /** Hard deadline for the whole attempt: connect, write, read. */
  timeoutMs: number;
  /** Cap on the response bytes read. Anything beyond is discarded and the socket destroyed. */
  maxResponseBytes?: number;
  /**
   * Values to redact from any surfaced response excerpt. Pass every secret the request carried —
   * a hostile endpoint can echo the write key back in its error body, and the excerpt is persisted.
   */
  redactFromDetail?: readonly string[];
  /** Aborts the attempt from outside (opt-out fence, overall budget). */
  signal?: AbortSignal;
  /** TLS trust seam for tests; production uses the system trust store. */
  ca?: string | Buffer;
}

const DEFAULT_MAX_RESPONSE_BYTES = 4096;

/**
 * Strip a response excerpt to a short printable-ASCII status detail — AND redact anything that
 * looks like key material.
 *
 * The endpoint is attacker-controlled, so it can echo the write key it just received back in an
 * error body. Without this, that key would be written into the durable delivery state and shown
 * on the status surface: a secret that was header-only on the wire would end up at rest on disk.
 * Any long hex run is redacted, so this holds even for a secret the caller did not name.
 */
function sanitizeDetail(text: string, redact: readonly string[] = []): string | undefined {
  let cleaned = text.replace(/[^\x20-\x7e]+/g, " ");
  for (const secret of redact) {
    if (secret.length >= 8) cleaned = cleaned.split(secret).join("[redacted]");
  }
  cleaned = cleaned
    .replace(/[0-9a-fA-F]{32,}/g, "[redacted]")
    .trim()
    .slice(0, 200);
  return cleaned === "" ? undefined : cleaned;
}

/**
 * POST to a PINNED endpoint. One socket, no pooling, no redirects, hard deadline, bounded read.
 *
 * The `lookup` handed to the socket layer can only ever return the address `resolveAndPin`
 * validated, so there is no window in which DNS can be re-answered with a different address.
 * `servername` keeps SNI and certificate verification on the ORIGINAL hostname, so pinning buys
 * TOCTOU safety without costing TLS identity.
 */
export function postPinned(opts: PostOptions): Promise<PostResult> {
  const { endpoint } = opts;
  const isHttps = endpoint.url.protocol === "https:";
  const transport = isHttps ? https : http;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return new Promise<PostResult>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let request: http.ClientRequest | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      // Destroy unconditionally: a slow-loris endpoint must not keep the socket after we are done.
      try {
        request?.destroy();
      } catch {
        /* already gone */
      }
      fn();
    };

    const failWith = (reason: string, message: string): void => {
      finish(() => reject(new EndpointRejected(reason, message)));
    };

    function onAbort(): void {
      failWith("aborted", "attempt aborted");
    }

    if (opts.signal?.aborted === true) {
      reject(new EndpointRejected("aborted", "attempt aborted before it started"));
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const port = endpoint.url.port !== "" ? Number(endpoint.url.port) : isHttps ? 443 : 80;
    const agent = new transport.Agent({ keepAlive: false, maxSockets: 1 });

    const pinnedLookup = (
      _hostname: string,
      options: dns.LookupOneOptions | dns.LookupAllOptions | number,
      callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
    ): void => {
      const wantsAll = typeof options === "object" && options !== null && (options as dns.LookupAllOptions).all === true;
      if (wantsAll) callback(null, [{ address: endpoint.address, family: endpoint.family }]);
      else callback(null, endpoint.address, endpoint.family);
    };

    const requestOptions: https.RequestOptions = {
      host: endpoint.url.hostname,
      port,
      path: `${endpoint.url.pathname}${endpoint.url.search}`,
      method: "POST",
      agent,
      // The pin. There is no second resolution for a rebind to win.
      lookup: pinnedLookup as unknown as https.RequestOptions["lookup"],
      headers: {
        ...opts.headers,
        "content-length": String(Buffer.byteLength(opts.body, "utf8")),
        connection: "close",
      },
    };
    if (isHttps && !endpoint.literal) {
      // SNI + certificate identity stay on the hostname the operator configured.
      (requestOptions as https.RequestOptions).servername = endpoint.url.hostname;
    }
    if (opts.ca !== undefined) (requestOptions as https.RequestOptions).ca = opts.ca;

    deadline = setTimeout(() => failWith("timeout", `attempt exceeded ${opts.timeoutMs}ms`), opts.timeoutMs);

    try {
      request = transport.request(requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        // Redirects are NOT followed: a 3xx would re-target the request at a host that never
        // passed validation. Surface it as the configuration error it is.
        if (status >= 300 && status < 400) {
          res.destroy();
          failWith("redirect_not_followed", `endpoint answered ${status} — redirects are not followed`);
          return;
        }
        const chunks: Buffer[] = [];
        let read = 0;
        res.on("data", (chunk: Buffer) => {
          // Keep only what fits, then stop reading. Dropping an over-sized chunk WHOLE would
          // throw away the actionable first line of a large error body — the one thing an
          // operator needs — while still doing all the work of receiving it.
          if (read < maxBytes) {
            const room = maxBytes - read;
            chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
          }
          read += chunk.length;
          if (read >= maxBytes) res.destroy(); // bounded read: stop consuming a hostile body
        });
        res.on("aborted", () => {
          // Truncated by our own cap after a usable status line — that is a complete answer.
          finish(() =>
            resolve({ status, ok: status >= 200 && status < 300, detail: sanitizeDetail(Buffer.concat(chunks).toString("utf8"), opts.redactFromDetail) }),
          );
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          finish(() => resolve({ status, ok: status >= 200 && status < 300, detail: status >= 200 && status < 300 ? undefined : sanitizeDetail(text, opts.redactFromDetail) }));
        });
        res.on("error", (err) => failWith("response_error", err.message));
      });
    } catch (err) {
      failWith("request_failed", err instanceof Error ? err.message : String(err));
      return;
    }

    // Socket-level idle timeout in addition to the whole-attempt deadline: a peer that accepts and
    // then says nothing is killed by the earlier of the two.
    request.setTimeout(opts.timeoutMs, () => failWith("timeout", `socket idle for ${opts.timeoutMs}ms`));
    request.on("error", (err) => failWith("request_failed", err.message));
    request.end(opts.body);
  });
}
