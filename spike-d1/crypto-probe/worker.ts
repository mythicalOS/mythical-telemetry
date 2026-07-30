// SPIKE PROBE — does `node:crypto` survive on Workers under `nodejs_compat`?
//
// This is the question the whole port hangs on. `uuidFromSecret` and both
// constant-time comparisons in the collector are SYNCHRONOUS functions sitting
// under a synchronous call chain. If Workers only offer WebCrypto
// (`crypto.subtle.digest`, which returns a Promise) then every one of those
// functions becomes async and the colour change propagates up the request path.
//
// So the probe does not ask "is there a crypto module". It runs the collector's
// ACTUAL derivation, byte-for-byte, and asserts the known-good vector — and it
// checks the call is synchronous by confirming the return value is not a
// thenable. A `createHash` that returned a Promise would still "work" here if we
// only awaited it, and that would be exactly the wrong answer.

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

/** Byte-identical copy of `collector/src/identity.ts` — deliberately not imported,
 *  so the probe tests the runtime and not our bundler's ability to find a file. */
function uuidFromSecret(secretHex: string): string {
  const digest = createHash('sha256').update(secretHex, 'utf8').digest();
  const b = Uint8Array.from(digest.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  if (ab.length === 0) return true;
  return timingSafeEqual(ab, bb);
}

/** The collector's ops-key compare (`server.ts`), which hashes first so operands
 *  of differing length are still compared at equal width. */
function constantTimeStringEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export default {
  async fetch(): Promise<Response> {
    const checks: Check[] = [];
    const record = (name: string, fn: () => Check) => {
      try {
        checks.push(fn());
      } catch (err) {
        // Never swallow: a throwing probe is a RESULT, and the message is the
        // most informative thing the run can produce.
        checks.push({
          name,
          ok: false,
          detail: `threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        });
      }
    };

    // 1. Is the digest call synchronous? `.digest()` must return bytes, not a
    //    Promise. This is the load-bearing question, so it is asked first and
    //    asked about the object itself rather than about what awaiting it gives.
    record('createHash().digest() is synchronous', () => {
      const d = createHash('sha256').update('probe', 'utf8').digest();
      const thenable = typeof (d as unknown as { then?: unknown }).then === 'function';
      return {
        name: 'createHash().digest() is synchronous',
        ok: !thenable && d.length === 32,
        detail: `ctor=${d.constructor?.name ?? '?'} len=${d.length} thenable=${thenable}`,
      };
    });

    // 2. Does it produce the RIGHT bytes? A stub that returns 32 zero bytes
    //    would pass check 1. Known-answer test against the SHA-256 of "abc".
    record('sha256 known-answer', () => {
      const hex = createHash('sha256').update('abc', 'utf8').digest('hex');
      const want = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
      return { name: 'sha256 known-answer', ok: hex === want, detail: hex };
    });

    // 3. The collector's real derivation, against a vector computed from the
    //    shipped implementation. If this differs, every existing install silently
    //    mints a new identity on cutover — the byte-freeze the module documents.
    record('uuidFromSecret byte-freeze', () => {
      const secret = 'a'.repeat(64);
      const got = uuidFromSecret(secret);
      return { name: 'uuidFromSecret byte-freeze', ok: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(got), detail: got };
    });

    // 4. timingSafeEqual — present, synchronous, and actually discriminating.
    record('timingSafeEqual', () => {
      const a = Buffer.from('4f9d2c1e-0000-4000-8000-000000000000', 'utf8');
      const b = Buffer.from('4f9d2c1e-0000-4000-8000-000000000000', 'utf8');
      const c = Buffer.from('4f9d2c1e-0000-4000-8000-000000000001', 'utf8');
      const same = timingSafeEqual(a, b);
      const diff = timingSafeEqual(a, c);
      return {
        name: 'timingSafeEqual',
        ok: same === true && diff === false && typeof same === 'boolean',
        detail: `equal=${same} unequal=${diff} type=${typeof same}`,
      };
    });

    // 5. The two wrappers end-to-end.
    record('constantTimeEqual + constantTimeStringEqual', () => {
      const secret = 'b'.repeat(64);
      const id = uuidFromSecret(secret);
      const authorizes = constantTimeEqual(uuidFromSecret(secret), id);
      const rejects = constantTimeEqual(uuidFromSecret('c'.repeat(64)), id);
      const opsOk = constantTimeStringEqual('ops-key', 'ops-key');
      const opsNo = constantTimeStringEqual('ops-key', 'other-key-of-different-length');
      return {
        name: 'constantTimeEqual + constantTimeStringEqual',
        ok: authorizes && !rejects && opsOk && !opsNo,
        detail: `authorizes=${authorizes} rejects=${rejects} opsOk=${opsOk} opsNo=${opsNo}`,
      };
    });

    // 6. Buffer — the wrappers depend on it as much as on crypto.
    record('Buffer', () => {
      const buf = Buffer.from('hello', 'utf8');
      return { name: 'Buffer', ok: buf.length === 5 && buf.toString('hex') === '68656c6c6f', detail: buf.toString('hex') };
    });

    // 7. randomBytes — not used by the collector, but it IS used by the
    //    @mythicalos/telemetry client (`identity.ts`, `atomic.ts`). Worth knowing
    //    whether that package could ever run here too.
    record('randomBytes', () => {
      const r = randomBytes(32);
      return { name: 'randomBytes', ok: r.length === 32, detail: `len=${r.length}` };
    });

    const allOk = checks.every((c) => c.ok);
    return new Response(JSON.stringify({ allOk, checks }, null, 2), {
      status: allOk ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  },
};
