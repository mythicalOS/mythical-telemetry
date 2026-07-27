// POST /v1/ingest — write integrity (derived identity, stateless,
// constant-time), the v1 + v2 matrix, strict rejection, body cap, day window,
// upsert idempotency, and the observability of every rejection.

import { describe, expect, test } from 'bun:test';
import { ingestReq, legacyIngestReq, makeHarness, statsReq } from './helpers';
import {
  AlwaysOkValidator,
  INSTANCE_A,
  INSTANCE_B,
  makeV1,
  makeV2,
  SECRET_A,
  SECRET_B,
  ThrowingValidator,
} from './fixtures';

describe('ingest: write integrity', () => {
  test('the owning secret => 202 {ok:true}', async () => {
    const { handler } = makeHarness();
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true });
  });

  test('absent secret => 403 write_key_mismatch, nothing stored', async () => {
    const { handler, db } = makeHarness();
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A)));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: 'write_key_mismatch' });
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
  });

  test('an empty secret header is treated as absent', async () => {
    const { handler } = makeHarness();
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A), ''));
    expect(r.status).toBe(403);
  });

  test('a wrong secret => 403, including for a FRESH never-seen id (no first-writer claim)', async () => {
    const { handler, db } = makeHarness();
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_B));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: 'write_key_mismatch' });
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
  });

  test('a secret for X cannot write a payload claiming id Y', async () => {
    const { handler } = makeHarness();
    expect((await handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);
    expect((await handler(ingestReq(makeV2('brokkr', INSTANCE_B), SECRET_A))).status).toBe(403);
  });

  test('presenting the instance id as if it were the secret does not authorize', async () => {
    const { handler } = makeHarness();
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A), INSTANCE_A));
    expect(r.status).toBe(403);
  });

  test('the historical header name is still accepted (v1 clients keep working)', async () => {
    const { handler } = makeHarness();
    const r = await handler(legacyIngestReq(makeV1(INSTANCE_A), SECRET_A));
    expect(r.status).toBe(202);
  });

  test('when both header names are present the canonical one wins', async () => {
    const { handler } = makeHarness();
    const ok = await handler(
      ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A, { 'x-mythical-write-key': SECRET_B }),
    );
    expect(ok.status).toBe(202);
    const bad = await handler(
      ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_B, { 'x-mythical-write-key': SECRET_A }),
    );
    expect(bad.status).toBe(403);
  });
});

describe('ingest: the v1 + v2 matrix', () => {
  test('a v2 payload is stored as sent', async () => {
    const { handler, db } = makeHarness();
    const hb = makeV2('brokkr', INSTANCE_A);
    expect((await handler(ingestReq(hb, SECRET_A))).status).toBe(202);
    const row = db.getHeartbeats(INSTANCE_A, 'brokkr')[0]!;
    expect(row.schema_version).toBe(2);
    expect(JSON.parse(row.payload).metrics).toEqual(hb['metrics']);
  });

  test('a v1 payload is accepted and normalized; the wire version is recorded', async () => {
    const { handler, db, counters } = makeHarness();
    expect((await handler(ingestReq(makeV1(INSTANCE_A), SECRET_A))).status).toBe(202);
    const row = db.getHeartbeats(INSTANCE_A, 'brokkr')[0]!;
    expect(row.schema_version).toBe(1); // arrived as v1
    const doc = JSON.parse(row.payload);
    expect(doc.schema_version).toBe(2); // stored as v2
    expect(doc.product).toEqual({ name: 'brokkr', version: '0.1.0' });
    expect(doc.metrics.sessions).toEqual({ count: 12, minutes: 340, failed: 1 });
    expect(counters.get('ingest_accepted_wire_v1')).toBe(1);
    expect(counters.get('ingest_accepted_wire_v2')).toBe(0);
  });

  test('v1 and v2 for the same day are one row: the later write wins', async () => {
    const { handler, db } = makeHarness();
    await handler(ingestReq(makeV1(INSTANCE_A, '2026-07-09'), SECRET_A));
    await handler(ingestReq(makeV2('brokkr', INSTANCE_A, '2026-07-09'), SECRET_A));
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(1);
    expect(db.getHeartbeats(INSTANCE_A, 'brokkr')[0]!.schema_version).toBe(2);
  });

  test('a v1 payload carrying an undeclared section is STILL rejected after normalization', async () => {
    // The laundering test: the move must not turn a rejectable payload into an
    // acceptable one.
    const { handler, counters } = makeHarness();
    const v1 = makeV1(INSTANCE_A);
    v1['repo_name'] = 'someone/private';
    const r = await handler(ingestReq(v1, SECRET_A));
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain('someone');
    expect(counters.get('ingest_rejected_schema_invalid')).toBe(1);
  });

  test('v1 can be refused once the compatibility window closes', async () => {
    const { handler, counters } = makeHarness({ acceptWireV1: false });
    const r = await handler(ingestReq(makeV1(INSTANCE_A), SECRET_A));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(counters.get('ingest_rejected_v1_window_closed')).toBe(1);
    // ...while v2 is unaffected.
    expect((await handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);
  });

  test('an unknown schema_version is rejected and counted separately', async () => {
    const { handler, counters } = makeHarness();
    const hb = makeV2('brokkr', INSTANCE_A);
    hb['schema_version'] = 3;
    expect((await handler(ingestReq(hb, SECRET_A))).status).toBe(400);
    expect(counters.get('ingest_rejected_unsupported_schema_version')).toBe(1);
  });

  test('all three products ingest, each into its own partition', async () => {
    const { handler, db } = makeHarness();
    for (const product of ['brokkr', 'saga', 'skuld'] as const) {
      const r = await handler(ingestReq(makeV2(product, INSTANCE_A), SECRET_A));
      expect(r.status).toBe(202);
      expect(db.countHeartbeats(INSTANCE_A, product)).toBe(1);
    }
    expect(db.countInstances()).toBe(3);
  });
});

describe('ingest: rejection is delegated to the ONE validator, and observed', () => {
  test('whatever the validator refuses, the collector refuses — without echoing the body', async () => {
    const cases: Array<[string, (hb: any) => void]> = [
      ['unknown top-level field', (h) => { h.secret_path = '/Users/acme/repo'; }],
      ['unknown field inside metrics', (h) => { h.metrics.acme_internal = 1; }],
      ['non-UUID instance_id', (h) => { h.instance_id = 'not-a-uuid'; }],
      ['free-string version probe', (h) => { h.product.version = 'acme-build-77'; }],
      ['off-enum platform', (h) => { h.platform.os = 'acme-os'; }],
      ['legacy daemon_version on a v2 payload', (h) => { h.product.daemon_version = h.product.version; }],
      ['missing metrics section', (h) => { delete h.metrics.spine; }],
    ];
    for (const [name, mutate] of cases) {
      const { handler } = makeHarness();
      const hb = makeV2('brokkr', INSTANCE_A);
      mutate(hb);
      const r = await handler(ingestReq(hb, SECRET_A));
      expect(r.status, name).toBe(400);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: 'invalid_payload' });
      expect(text).not.toContain('acme');
      expect(text).not.toContain('instance_id');
    }
  });

  test('a non-JSON body => 400, counted as malformed JSON', async () => {
    const { handler, counters } = makeHarness();
    const r = await handler(ingestReq('this is not json{{{', SECRET_A));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(counters.get('ingest_rejected_malformed_json')).toBe(1);
  });

  test('a validator that throws becomes a rejection, never a 500', async () => {
    const { handler, counters } = makeHarness({ validator: new ThrowingValidator() });
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_validator_error')).toBe(1);
    expect(counters.get('internal_error')).toBe(0);
  });

  test('a product outside the storable set cannot create a partition, even if the validator allows it', async () => {
    const { handler, counters, db } = makeHarness({
      validator: new AlwaysOkValidator({
        schema_version: 2,
        instance_id: INSTANCE_A,
        day: '2026-07-09',
        product: { name: 'newthing', version: '1.0.0' },
        platform: { os: 'linux', arch: 'x64' },
        metrics: {},
      }),
    });
    const r = await handler(ingestReq({ schema_version: 2 }, SECRET_A));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_unknown_product')).toBe(1);
    expect(db.countInstances()).toBe(0);
  });

  test('every rejection increments both the total and its own reason', async () => {
    const { handler, counters } = makeHarness();
    await handler(ingestReq(makeV2('brokkr', INSTANCE_A)));          // no secret
    await handler(ingestReq('{{{', SECRET_A));                        // malformed
    await handler(ingestReq({ schema_version: 9 }, SECRET_A));        // bad version
    expect(counters.get('ingest_rejected_total')).toBe(3);
    expect(counters.get('ingest_rejected_missing_secret')).toBe(1);
    expect(counters.get('ingest_rejected_malformed_json')).toBe(1);
    expect(counters.get('ingest_rejected_unsupported_schema_version')).toBe(1);
    // Never-fired reasons are still present as zeros, not missing keys.
    expect(counters.snapshot()).toHaveProperty('ingest_rejected_instance_capacity', 0);
  });
});

describe('ingest: body cap', () => {
  test('an oversize body => 413', async () => {
    const { handler, counters } = makeHarness({ maxBodyBytes: 256 });
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A));
    expect(r.status).toBe(413);
    expect(counters.get('ingest_rejected_body_too_large')).toBe(1);
  });

  test('the default cap is 32768 bytes: oversize junk rejected, a real payload fits', async () => {
    const { handler } = makeHarness();
    expect((await handler(ingestReq('x'.repeat(32769), SECRET_A))).status).toBe(413);
    expect((await handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);
  });

  test('a streaming body with NO content-length over the cap => 413 without draining the stream', async () => {
    const { handler } = makeHarness({ maxBodyBytes: 1024 });
    const chunk = new TextEncoder().encode('x'.repeat(512));
    const totalChunks = 64;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= totalChunks) { controller.close(); return; }
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const req = new Request('http://telemetry.local/v1/ingest', {
      method: 'POST',
      headers: { 'x-mythical-instance-secret': SECRET_A },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull(); // the attack shape
    const r = await handler(req);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ ok: false, error: 'payload_too_large' });
    expect(pulls).toBeLessThan(totalChunks / 2);
  });

  test('a declared over-cap content-length => 413 without reading the body at all', async () => {
    const { handler } = makeHarness({ maxBodyBytes: 1024 });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(512)); },
    });
    const req = new Request('http://telemetry.local/v1/ingest', {
      method: 'POST',
      headers: { 'x-mythical-instance-secret': SECRET_A, 'content-length': '999999' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect((await handler(req)).status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(1);
  });
});

describe('ingest: day window (day ≤ today UTC and ≥ today−30)', () => {
  const attempts: Array<[string, number]> = [
    ['2026-07-09', 202], // today
    ['2026-06-09', 202], // today−30, inclusive
    ['2026-06-08', 400], // today−31
    ['2026-07-10', 400], // tomorrow
  ];
  for (const [day, status] of attempts) {
    test(`day ${day} => ${status}`, async () => {
      const { handler } = makeHarness({ today: '2026-07-09' });
      const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A, day), SECRET_A));
      expect(r.status).toBe(status);
      if (status === 400) expect(await r.json()).toEqual({ ok: false, error: 'invalid_payload' });
    });
  }

  test('a regex-passing non-calendar day (2026-02-30) => 400', async () => {
    const { handler, counters } = makeHarness({ today: '2026-03-05' });
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A, '2026-02-30'), SECRET_A));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_day_out_of_window')).toBe(1);
  });

  test('the day window is checked BEFORE identity, so it is not an identity oracle', async () => {
    const { handler, counters } = makeHarness({ today: '2026-07-09' });
    // Wrong secret AND an out-of-window day: the answer must be the day one,
    // so a caller cannot probe identities by watching which guard fires.
    const r = await handler(ingestReq(makeV2('brokkr', INSTANCE_A, '2026-01-01'), SECRET_B));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_day_out_of_window')).toBe(1);
    expect(counters.get('ingest_rejected_identity_mismatch')).toBe(0);
  });
});

describe('ingest: upsert idempotency', () => {
  test('re-POSTing the same (id, product, day) replaces; days_reported stays 1', async () => {
    const { handler } = makeHarness();
    expect((await handler(ingestReq(makeV2('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);

    const hb2 = makeV2('brokkr', INSTANCE_A);
    hb2['metrics'].sessions = { count: 99, minutes: 500, failed: 0 };
    expect((await handler(ingestReq(hb2, SECRET_A))).status).toBe(202);

    const stats = await (await handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A }))).json() as any;
    expect(stats.instance.days_reported).toBe(1);
    expect(stats.days.length).toBe(1);
    expect(stats.days[0].metrics.sessions.count).toBe(99);
  });
});
