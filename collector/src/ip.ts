// Address parsing and CIDR matching, for one purpose only: deciding whether
// the peer that opened this connection is one of the operator's own proxies.
//
// Nothing here is used for storage, logging or identity. Parsed addresses live
// for the duration of a comparison and are discarded.
//
// IPv4-mapped IPv6 (`::ffff:203.0.113.9`, which is what a dual-stack listener
// commonly reports for an IPv4 peer) normalizes to its 4-byte IPv4 form, so an
// operator writing `203.0.113.0/24` matches regardless of how the socket
// reported the peer. Comparisons only ever happen between addresses of the
// same family.

/** A parsed address, plus how many leading bits of it are significant. */
export interface CidrPattern {
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

const MAX_TEXT_LEN = 64;

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part === undefined || !/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

/**
 * Append the hextet values of `groups` to `out`; false on anything malformed.
 *
 * `embeddedV4Index` is the ONLY position at which a dotted IPv4 literal is
 * permitted (-1 for none). RFC 4291 allows an embedded IPv4 only at the very
 * end of the address, and accepting it anywhere else means text like
 * `2001:db8:192.0.2.1::` parses to a perfectly valid-looking address that is
 * not the one written. In a gate that decides whether to trust a header, "this
 * parsed to the wrong bytes" is worse than "this failed to parse".
 */
function pushHextets(groups: string[], out: number[], embeddedV4Index: number): boolean {
  for (const [index, group] of groups.entries()) {
    if (group.includes('.')) {
      if (index !== embeddedV4Index) return false;
      const v4 = parseIpv4(group);
      if (!v4) return false;
      out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
      out.push(Number.parseInt(group, 16));
    }
  }
  return true;
}

function isV4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * Parse a textual address into its bytes: 4 for IPv4, 16 for IPv6. Returns
 * null for anything it does not fully understand — a partial parse would be
 * worse than a refusal here, since the result gates whether a header is
 * trusted.
 */
export function parseIp(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LEN) return null;
  if (!trimmed.includes(':')) return parseIpv4(trimmed);

  // An IPv6 zone id names a local interface, not the address, so it is dropped
  // — but it is VALIDATED first. Silently truncating at the first '%' would
  // accept `fe80::1%a%b` and `fe80::1%` as the same address as `fe80::1`.
  let noZone = trimmed;
  const percent = trimmed.indexOf('%');
  if (percent >= 0) {
    const zone = trimmed.slice(percent + 1);
    if (zone.length === 0 || !/^[0-9A-Za-z._-]+$/.test(zone)) return null;
    noZone = trimmed.slice(0, percent);
  }
  if (noZone.length === 0) return null;

  const doubleColon = noZone.indexOf('::');
  let head: string[] = [];
  let tail: string[] = [];
  if (doubleColon >= 0) {
    if (noZone.indexOf('::', doubleColon + 1) !== -1) return null; // only one '::'
    const headText = noZone.slice(0, doubleColon);
    const tailText = noZone.slice(doubleColon + 2);
    if (headText.endsWith(':') || tailText.startsWith(':')) return null;
    head = headText.length > 0 ? headText.split(':') : [];
    tail = tailText.length > 0 ? tailText.split(':') : [];
  } else {
    head = noZone.split(':');
  }

  // An embedded IPv4 literal is legal only as the final group of the whole
  // address — which means the tail's last group when '::' is present (nothing
  // follows the tail), and the head's last group when it is not.
  const headV4Index = doubleColon >= 0 ? -1 : head.length - 1;
  const tailV4Index = doubleColon >= 0 ? tail.length - 1 : -1;

  const headValues: number[] = [];
  const tailValues: number[] = [];
  if (!pushHextets(head, headValues, headV4Index) || !pushHextets(tail, tailValues, tailV4Index)) return null;

  let hextets: number[];
  if (doubleColon >= 0) {
    const fill = 8 - headValues.length - tailValues.length;
    if (fill < 0) return null;
    hextets = [...headValues, ...new Array<number>(fill).fill(0), ...tailValues];
  } else {
    hextets = headValues;
  }
  if (hextets.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const h = hextets[i] ?? 0;
    bytes[i * 2] = (h >> 8) & 0xff;
    bytes[i * 2 + 1] = h & 0xff;
  }
  return isV4Mapped(bytes) ? bytes.slice(12) : bytes;
}

/**
 * Parse `address` or `address/prefix`. A bare address is treated as a host
 * route (full-length prefix). Returns null for anything malformed.
 */
export function parseCidr(text: string): CidrPattern | null {
  const trimmed = text.trim();
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) {
    const bytes = parseIp(trimmed);
    return bytes ? { bytes, prefix: bytes.length * 8 } : null;
  }
  const bytes = parseIp(trimmed.slice(0, slash));
  if (!bytes) return null;
  const prefixText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > bytes.length * 8) return null;
  return { bytes, prefix };
}

/** Does `ip` fall inside `pattern`? False across address families. */
export function ipInCidr(ip: Uint8Array, pattern: CidrPattern): boolean {
  if (ip.length !== pattern.bytes.length) return false;
  let remaining = pattern.prefix;
  for (let i = 0; i < ip.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((((ip[i] ?? 0) ^ (pattern.bytes[i] ?? 0)) & mask) !== 0) return false;
    remaining -= take;
  }
  return true;
}

/**
 * Parse an operator-supplied trusted-proxy list.
 *
 * THROWS on an unparseable entry rather than skipping it. A silently dropped
 * entry means the proxy is not recognised, the header is ignored, and the
 * whole population shares one throttle bucket — an outage that looks like a
 * capacity problem. Failing at boot with the offending text is far kinder.
 */
export function parseTrustedProxies(entries: readonly string[]): CidrPattern[] {
  const out: CidrPattern[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const parsed = parseCidr(trimmed);
    if (!parsed) throw new Error(`not a valid address or CIDR in the trusted-proxy list: "${entry}"`);
    out.push(parsed);
  }
  return out;
}

/**
 * A canonical throttle-bucket key for an address, or null if it is not one.
 *
 * Canonical because the key must not be attacker-shapeable: `10.0.0.1`,
 * ` 10.0.0.1 `, `::ffff:10.0.0.1` and `::ffff:0a00:0001` are ONE source, and
 * anything that is not an address gets no key at all. Deriving the key from a
 * "looks address-ish" text test instead would let a caller mint unlimited
 * distinct buckets out of near-miss strings.
 */
export function addressKey(text: string): string | null {
  const bytes = parseIp(text);
  if (!bytes) return null;
  return `${bytes.length === 4 ? 'v4' : 'v6'}:${Buffer.from(bytes).toString('hex')}`;
}

/** Is this peer one of the operator's proxies? */
export function isTrustedPeer(peer: string, patterns: readonly CidrPattern[]): boolean {
  if (patterns.length === 0) return false;
  const bytes = parseIp(peer);
  if (!bytes) return false;
  return patterns.some((pattern) => ipInCidr(bytes, pattern));
}
