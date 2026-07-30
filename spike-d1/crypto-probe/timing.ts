// SPIKE PROBE — can CPU time per request be MEASURED from inside a Worker?
//
// The free plan is documented as having a per-request CPU-time limit, and the
// collector's ingest path does real synchronous work (JSON.parse of up to 32 KB,
// the canonical validator, a sha256, a constant-time compare). The question is
// whether that work is anywhere near the limit — and the first question behind
// that one is whether a number can be obtained at all.
//
// Workers deliberately clamp timers as a side-channel mitigation: `Date.now()`
// and `performance.now()` are expected to advance only when I/O happens, not
// during synchronous execution. If that holds, a Worker cannot time its own CPU
// and any "measurement" taken this way is not evidence.
//
// So this probe does two things: it reports whether the clock moved across a
// deliberately expensive synchronous loop, and it runs the collector's actual
// per-request CPU work a fixed number of times so the same work can be timed
// OUTSIDE the Worker, where the clock is real.

import { createHash, timingSafeEqual } from 'node:crypto';
import { validateHeartbeat } from '../../packages/telemetry/src/envelope';

function uuidFromSecret(secretHex: string): string {
  const digest = createHash('sha256').update(secretHex, 'utf8').digest();
  const b = Uint8Array.from(digest.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const iterations = Number(url.searchParams.get('n') ?? '1');
    const bodyText = await req.text();

    // (a) Does the clock move across pure synchronous work at all?
    const t0 = Date.now();
    const p0 = performance.now();
    let sink = 0;
    for (let i = 0; i < 5_000_000; i += 1) sink += i % 7;
    const t1 = Date.now();
    const p1 = performance.now();

    // (b) The collector's real per-request CPU work, N times. No I/O, no D1.
    const secret = 'a'.repeat(64);
    let accepted = 0;
    const t2 = Date.now();
    const p2 = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const parsed = JSON.parse(bodyText) as unknown;
      const v = validateHeartbeat(parsed);
      if (!v.ok) continue;
      const derived = uuidFromSecret(secret);
      const a = Buffer.from(derived, 'utf8');
      const b = Buffer.from((v.value as { instance_id: string }).instance_id, 'utf8');
      if (a.length === b.length && timingSafeEqual(a, b)) accepted += 1;
      // The store also re-serialises the validated document before writing it.
      sink += JSON.stringify(v.value).length;
    }
    const t3 = Date.now();
    const p3 = performance.now();

    return new Response(
      JSON.stringify(
        {
          iterations,
          accepted,
          busyLoop: { dateDeltaMs: t1 - t0, perfDeltaMs: p1 - p0 },
          ingestWork: { dateDeltaMs: t3 - t2, perfDeltaMs: p3 - p2 },
          // If both deltas are 0 across five million iterations, the clock is
          // clamped and no in-Worker timing is possible.
          clockAdvancesDuringSyncWork: t1 - t0 > 0 || p1 - p0 > 0,
          sink,
        },
        null,
        2,
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  },
};
