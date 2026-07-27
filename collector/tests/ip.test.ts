// Address parsing and CIDR matching. This decides whether a peer is one of
// the operator's proxies, and therefore whether X-Forwarded-For is believed —
// so a lenient parse here is a spoofing bug, and a strict one that rejects a
// real proxy is an outage.

import { describe, expect, test } from 'bun:test';
import { ipInCidr, isTrustedPeer, parseCidr, parseIp, parseTrustedProxies } from '../src/ip';

const hex = (bytes: Uint8Array | null) => (bytes ? Buffer.from(bytes).toString('hex') : null);

describe('parseIp', () => {
  test('IPv4', () => {
    expect(hex(parseIp('0.0.0.0'))).toBe('00000000');
    expect(hex(parseIp('10.0.0.1'))).toBe('0a000001');
    expect(hex(parseIp('255.255.255.255'))).toBe('ffffffff');
  });

  test('IPv6, including compressed forms', () => {
    expect(hex(parseIp('::'))).toBe('0'.repeat(32));
    expect(hex(parseIp('::1'))).toBe(`${'0'.repeat(31)}1`);
    expect(hex(parseIp('2001:db8::1'))).toBe('20010db8000000000000000000000001');
    expect(hex(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001'))).toBe('20010db8000000000000000000000001');
    expect(hex(parseIp('fe80::1%eth0'))).toBe('fe800000000000000000000000000001');
  });

  test('an IPv4-mapped IPv6 normalizes to its 4-byte IPv4 form', () => {
    // A dual-stack listener reports IPv4 peers this way; an operator writing
    // an IPv4 CIDR must still match.
    expect(hex(parseIp('::ffff:10.0.0.1'))).toBe('0a000001');
    expect(hex(parseIp('::ffff:0a00:0001'))).toBe('0a000001');
  });

  test('rejects everything malformed rather than half-parsing it', () => {
    for (const bad of [
      '', '   ', 'not an address', '1.2.3', '1.2.3.4.5', '256.0.0.1', '1.2.3.-1', '01.2.3.4444',
      '999', 'localhost', '<script>', '2001:db8::1::2', '2001:db8:::1', '2001:db8:zzzz::1',
      '2001:db8:0:0:0:0:0:0:1', ':::', '1:2:3:4:5:6:7', 'x'.repeat(200),
    ]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  test('trims surrounding whitespace', () => {
    expect(hex(parseIp('  10.0.0.1  '))).toBe('0a000001');
  });
});

describe('parseCidr / ipInCidr', () => {
  test('a bare address is a host route', () => {
    const p = parseCidr('10.0.0.1')!;
    expect(p.prefix).toBe(32);
    expect(ipInCidr(parseIp('10.0.0.1')!, p)).toBe(true);
    expect(ipInCidr(parseIp('10.0.0.2')!, p)).toBe(false);
  });

  test('IPv4 prefixes match on the significant bits only', () => {
    const p = parseCidr('10.0.0.0/8')!;
    expect(ipInCidr(parseIp('10.255.255.255')!, p)).toBe(true);
    expect(ipInCidr(parseIp('10.0.0.0')!, p)).toBe(true);
    expect(ipInCidr(parseIp('11.0.0.1')!, p)).toBe(false);

    const partial = parseCidr('192.168.4.0/22')!;
    expect(ipInCidr(parseIp('192.168.7.255')!, partial)).toBe(true);
    expect(ipInCidr(parseIp('192.168.8.0')!, partial)).toBe(false);
  });

  test('a /0 matches everything of the same family, and nothing of the other', () => {
    const all = parseCidr('0.0.0.0/0')!;
    expect(ipInCidr(parseIp('203.0.113.9')!, all)).toBe(true);
    expect(ipInCidr(parseIp('2001:db8::1')!, all)).toBe(false);
  });

  test('IPv6 prefixes', () => {
    const p = parseCidr('2001:db8:1::/48')!;
    expect(ipInCidr(parseIp('2001:db8:1::5')!, p)).toBe(true);
    expect(ipInCidr(parseIp('2001:db8:1:ffff::1')!, p)).toBe(true);
    expect(ipInCidr(parseIp('2001:db8:2::5')!, p)).toBe(false);
  });

  test('families never match across each other', () => {
    expect(ipInCidr(parseIp('10.0.0.1')!, parseCidr('::/0')!)).toBe(false);
    expect(ipInCidr(parseIp('2001:db8::1')!, parseCidr('10.0.0.0/8')!)).toBe(false);
  });

  test('rejects malformed prefixes rather than clamping them', () => {
    for (const bad of ['10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/x', '10.0.0.0/', '2001:db8::/129', '/8', 'x/8']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });
});

describe('parseTrustedProxies', () => {
  test('parses a list and skips blank entries', () => {
    expect(parseTrustedProxies(['10.0.0.0/8', '  ', '203.0.113.9'])).toHaveLength(2);
    expect(parseTrustedProxies([])).toEqual([]);
  });

  test('THROWS on a malformed entry rather than silently dropping it', () => {
    // A silently dropped proxy means the header is ignored and the whole
    // population shares one bucket — an outage that looks like a capacity
    // problem. Failing at boot with the offending text is far kinder.
    expect(() => parseTrustedProxies(['10.0.0.0/8', 'not-an-ip'])).toThrow(/not-an-ip/);
    expect(() => parseTrustedProxies(['10.0.0.0/99'])).toThrow(/trusted-proxy list/);
  });
});

describe('isTrustedPeer', () => {
  const proxies = parseTrustedProxies(['10.0.0.0/8', '2001:db8:1::/48']);

  test('matches inside any configured range', () => {
    expect(isTrustedPeer('10.4.5.6', proxies)).toBe(true);
    expect(isTrustedPeer('2001:db8:1::9', proxies)).toBe(true);
    expect(isTrustedPeer('::ffff:10.4.5.6', proxies)).toBe(true);
  });

  test('an empty allowlist trusts nobody', () => {
    expect(isTrustedPeer('10.4.5.6', [])).toBe(false);
  });

  test('an unparseable peer is never trusted', () => {
    expect(isTrustedPeer('unknown', proxies)).toBe(false);
    expect(isTrustedPeer('', proxies)).toBe(false);
    expect(isTrustedPeer('10.0.0.0/8', proxies)).toBe(false); // a CIDR is not a peer
  });

  test('addresses outside every range are not trusted', () => {
    expect(isTrustedPeer('203.0.113.9', proxies)).toBe(false);
    expect(isTrustedPeer('2001:db8:9::1', proxies)).toBe(false);
  });
});
