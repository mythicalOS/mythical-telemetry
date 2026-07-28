// POST /v1/ingest — write integrity (derived identity, stateless,
// constant-time), strict rejection of anything that is not THE heartbeat shape
// (including the retired legacy one), body cap, day window, upsert idempotency,
// and the observability of every rejection.

import { describe, expect, test } from 'bun:test';
import { ingestReq, legacyIngestReq, makeHarness, statsReq } from './helpers';
import { loadCanonicalValidator } from '../src/validator';
import {
  AlwaysOkValidator,
  INSTANCE_A,
  INSTANCE_B,
  makeHeartbeat,
  makeLegacyShape,
  SECRET_A,
  SECRET_B,
  ThrowingValidator,
} from './fixtures';

describe('ingest: write integrity', () => {
  test('the owning secret => 202 {ok:true}', async () => {
    const { handler } = makeHarness();
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true });
  });

  test('absent secret => 403 write_key_mismatch, nothing stored', async () => {
    const { handler, db } = makeHarness();
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A)));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: 'write_key_mismatch' });
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
  });

  test('an empty secret header is treated as absent', async () => {
    const { handler } = makeHarness();
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), ''));
    expect(r.status).toBe(403);
  });

  test('a wrong secret => 403, including for a FRESH never-seen id (no first-writer claim)', async () => {
    const { handler, db } = makeHarness();
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_B));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: 'write_key_mismatch' });
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
  });

  test('a secret for X cannot write a payload claiming id Y', async () => {
    const { handler } = makeHarness();
    expect((await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);
    expect((await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_B), SECRET_A))).status).toBe(403);
  });

  test('presenting the instance id as if it were the secret does not authorize', async () => {
    const { handler } = makeHarness();
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), INSTANCE_A));
    expect(r.status).toBe(403);
  });

  test('the historical header name is still accepted (older clients keep working)', async () => {
    const { handler } = makeHarness();
    const r = await handler(legacyIngestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    expect(r.status).toBe(202);
  });

  test('when both header names are present the canonical one wins', async () => {
    const { handler } = makeHarness();
    const ok = await handler(
      ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A, { 'x-mythical-write-key': SECRET_B }),
    );
    expect(ok.status).toBe(202);
    const bad = await handler(
      ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_B, { 'x-mythical-write-key': SECRET_A }),
    );
    expect(bad.status).toBe(403);
  });
});

describe('ingest: there is exactly ONE shape', () => {
  test('a payload is stored exactly as sent, under the one schema version', async () => {
    const { handler, db } = makeHarness();
    const hb = makeHeartbeat('brokkr', INSTANCE_A);
    expect((await handler(ingestReq(hb, SECRET_A))).status).toBe(202);
    const row = db.getHeartbeats(INSTANCE_A, 'brokkr')[0]!;
    expect(row.schema_version).toBe(1);
    // Stored as accepted: no normalization, no rewrite, no invented fields.
    const stored = JSON.parse(row.payload);
    expect(stored).toEqual(hb);
  });

  test('any other schema_version is rejected by the validator, not by a pre-check', async () => {
    for (const version of [0, 2, 3, '1', null]) {
      const { handler, counters } = makeHarness();
      const hb = makeHeartbeat('brokkr', INSTANCE_A);
      hb['schema_version'] = version;
      expect((await handler(ingestReq(hb, SECRET_A))).status, String(version)).toBe(400);
      expect(counters.get('ingest_rejected_schema_invalid'), String(version)).toBe(1);
    }
  });

  test('a JSON body that is not an object at all is rejected the same way', async () => {
    const { handler, counters } = makeHarness();
    for (const body of ['[1,2,3]', '42', '"nope"', 'null']) {
      expect((await handler(ingestReq(body, SECRET_A))).status, body).toBe(400);
    }
    expect(counters.get('ingest_rejected_schema_invalid')).toBe(4);
  });

  test('all three products ingest, each into its own partition', async () => {
    const { handler, db } = makeHarness();
    for (const product of ['brokkr', 'saga', 'skuld'] as const) {
      const r = await handler(ingestReq(makeHeartbeat(product, INSTANCE_A), SECRET_A));
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
      ['legacy daemon_version alongside version', (h) => { h.product.daemon_version = h.product.version; }],
      ['missing metrics section', (h) => { delete h.metrics.spine; }],
    ];
    for (const [name, mutate] of cases) {
      const { handler } = makeHarness();
      const hb = makeHeartbeat('brokkr', INSTANCE_A);
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
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_validator_error')).toBe(1);
    expect(counters.get('internal_error')).toBe(0);
  });

  test('a product outside the storable set cannot create a partition, even if the validator allows it', async () => {
    const { handler, counters, db } = makeHarness({
      validator: new AlwaysOkValidator({
        schema_version: 1,
        instance_id: INSTANCE_A,
        day: '2026-07-09',
        product: { name: 'newthing', version: '1.0.0' },
        platform: { os: 'linux', arch: 'x64' },
        metrics: {},
      }),
    });
    const r = await handler(ingestReq({ schema_version: 1 }, SECRET_A));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_unknown_product')).toBe(1);
    expect(db.countInstances()).toBe(0);
  });

  test('every rejection increments both the total and its own reason', async () => {
    const { handler, counters } = makeHarness();
    await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A)));    // no secret
    await handler(ingestReq('{{{', SECRET_A));                        // malformed
    await handler(ingestReq({ schema_version: 9 }, SECRET_A));        // not the one shape
    expect(counters.get('ingest_rejected_total')).toBe(3);
    expect(counters.get('ingest_rejected_missing_secret')).toBe(1);
    expect(counters.get('ingest_rejected_malformed_json')).toBe(1);
    expect(counters.get('ingest_rejected_schema_invalid')).toBe(1);
    // Never-fired reasons are still present as zeros, not missing keys.
    expect(counters.snapshot()).toHaveProperty('ingest_rejected_instance_capacity', 0);
  });
});

describe('ingest: body cap', () => {
  test('an oversize body => 413', async () => {
    const { handler, counters } = makeHarness({ maxBodyBytes: 256 });
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A));
    expect(r.status).toBe(413);
    expect(counters.get('ingest_rejected_body_too_large')).toBe(1);
  });

  test('the default cap is 32768 bytes: oversize junk rejected, a real payload fits', async () => {
    const { handler } = makeHarness();
    expect((await handler(ingestReq('x'.repeat(32769), SECRET_A))).status).toBe(413);
    expect((await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);
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
      const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, day), SECRET_A));
      expect(r.status).toBe(status);
      if (status === 400) expect(await r.json()).toEqual({ ok: false, error: 'invalid_payload' });
    });
  }

  test('a regex-passing non-calendar day (2026-02-30) => 400', async () => {
    const { handler, counters } = makeHarness({ today: '2026-03-05' });
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-02-30'), SECRET_A));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_day_out_of_window')).toBe(1);
  });

  test('the day window is checked BEFORE identity, so it is not an identity oracle', async () => {
    const { handler, counters } = makeHarness({ today: '2026-07-09' });
    // Wrong secret AND an out-of-window day: the answer must be the day one,
    // so a caller cannot probe identities by watching which guard fires.
    const r = await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A, '2026-01-01'), SECRET_B));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_day_out_of_window')).toBe(1);
    expect(counters.get('ingest_rejected_identity_mismatch')).toBe(0);
  });
});

describe('ingest: upsert idempotency', () => {
  test('re-POSTing the same (id, product, day) replaces; days_reported stays 1', async () => {
    const { handler } = makeHarness();
    expect((await handler(ingestReq(makeHeartbeat('brokkr', INSTANCE_A), SECRET_A))).status).toBe(202);

    const hb2 = makeHeartbeat('brokkr', INSTANCE_A);
    hb2['metrics'].sessions = { count: 99, minutes: 500, failed: 0 };
    expect((await handler(ingestReq(hb2, SECRET_A))).status).toBe(202);

    const stats = await (await handler(statsReq(INSTANCE_A, 'brokkr', { secret: SECRET_A }))).json() as any;
    expect(stats.instance.days_reported).toBe(1);
    expect(stats.days.length).toBe(1);
    expect(stats.days[0].metrics.sessions.count).toBe(99);
  });
});

// ── the retired LEGACY shape ────────────────────────────────────────────────
//
// A product build that predates the schema collapse would put the legacy shape
// on the wire: the ten body sections at the TOP level, no `metrics`, and
// `product.daemon_version`. It must FAIL CLEANLY. There is no compatibility
// path and no normalization — the point of the collapse is that exactly one
// shape exists.
//
// The trap this guards is that the legacy shape ALSO declared
// `schema_version: 1`, which is the current version number. So the
// discriminator agrees, and nothing may rely on it to tell the two apart. What
// rejects the document is its SHAPE: `metrics` is required and absent, and
// every top-level section is undeclared under `additionalProperties: false`.
describe('ingest: the retired legacy shape is refused, never misread', () => {
  test('its schema_version is the CURRENT one — the version cannot be what rejects it', () => {
    expect(makeLegacyShape(INSTANCE_A)['schema_version']).toBe(
      makeHeartbeat('brokkr', INSTANCE_A)['schema_version'],
    );
  });

  test('it is 400 invalid_payload, counted as schema-invalid, and NOTHING is stored', async () => {
    const { handler, db, counters } = makeHarness();
    const r = await handler(ingestReq(makeLegacyShape(INSTANCE_A), SECRET_A));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(counters.get('ingest_rejected_schema_invalid')).toBe(1);
    expect(counters.get('ingest_accepted_total')).toBe(0);
    // The silent failure this forbids: accepted with an empty body, so the
    // installation reports zeros forever and looks alive.
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
    expect(db.countInstances()).toBe(0);
  });

  test('the identity is not created either — a refused shape leaves no trace', async () => {
    const { handler, db } = makeHarness();
    await handler(ingestReq(makeLegacyShape(INSTANCE_A), SECRET_A));
    expect(db.isKnownInstance(INSTANCE_A, 'brokkr')).toBe(false);
    expect(db.getInstance(INSTANCE_A, 'brokkr')).toBeNull();
  });

  test('presenting it under the historical header name does not help', async () => {
    const { handler, db } = makeHarness();
    const r = await handler(legacyIngestReq(makeLegacyShape(INSTANCE_A), SECRET_A));
    expect(r.status).toBe(400);
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
  });

  test('a legacy body smuggled UNDER `metrics` is still refused on its envelope', async () => {
    // The near-miss worth pinning: someone "fixes" an old client by wrapping the
    // sections without renaming daemon_version. Still one shape, still refused.
    const legacy = makeLegacyShape(INSTANCE_A);
    const { schema_version, instance_id, day, product, platform, ...sections } = legacy;
    const wrapped = { schema_version, instance_id, day, product, platform, metrics: sections };
    const { handler, db } = makeHarness();
    expect((await handler(ingestReq(wrapped, SECRET_A))).status).toBe(400);
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
  });

  test('the rejection body never echoes anything from the payload', async () => {
    const { handler } = makeHarness();
    const legacy = makeLegacyShape(INSTANCE_A);
    legacy['repo_name'] = 'someone/private';
    const text = await (await handler(ingestReq(legacy, SECRET_A))).text();
    expect(text).not.toContain('someone');
    expect(text).not.toContain('repo_name');
    expect(text).not.toContain('daemon_version');
  });

  // Every test above runs against the injected StubValidator, which proves the
  // ROUTE behaves — but would keep passing if the canonical validator in the
  // client package started accepting the retired shape, because the stub is
  // this repository's own approximation. This one closes that gap end to end:
  // the REAL validator, wired the way production wires it, through the real
  // handler. The positive control is what makes the rejection mean something —
  // without it, a validator that refused everything would look identical.
  test('the CANONICAL validator, wired as production wires it, refuses it too', async () => {
    const validator = await loadCanonicalValidator();
    const { handler, db } = makeHarness({ validator });

    // Positive control: the current shape is accepted by the real validator.
    const current = makeHeartbeat('brokkr', INSTANCE_A);
    expect((await handler(ingestReq(current, SECRET_A))).status).toBe(202);
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(1);

    // Proof this really is the CANONICAL validator and not the stub, which
    // would make the rejection below prove nothing about the shipped package:
    // the stub only checks that a body carries the right SECTION NAMES, so it
    // accepts this skuld fixture, while the canonical validator refuses it on
    // `events.deferrals` (a leaf that does not exist) and on `detection_state`
    // being outside its closed enum.
    const stubWouldAccept = makeHeartbeat('skuld', INSTANCE_A);
    expect((await handler(ingestReq(stubWouldAccept, SECRET_A))).status).toBe(400);
    expect(db.countHeartbeats(INSTANCE_A, 'skuld')).toBe(0);

    // ...and the retired shape, carrying the SAME schema_version, is not.
    const legacy = makeLegacyShape(INSTANCE_B);
    expect(legacy['schema_version']).toBe(current['schema_version']);
    const r = await handler(ingestReq(legacy, SECRET_B));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'invalid_payload' });
    expect(db.countHeartbeats(INSTANCE_B, 'brokkr')).toBe(0);
    expect(db.countInstances()).toBe(1); // only the accepted one
  });
});

describe('ingest: `__proto__` cannot launder an undeclared section past the validator', () => {
  test('an own `__proto__` section is refused, not silently swallowed', async () => {
    // Built as raw JSON text on purpose: an object literal would not reproduce
    // the own-property `__proto__` that JSON.parse creates. A validator that
    // walked the document with plain property assignment would lose the key and
    // accept what is left.
    const { handler, db, counters } = makeHarness();
    const hb = makeHeartbeat('brokkr', INSTANCE_A);
    const body = JSON.stringify(hb).replace(/^\{/, '{"__proto__":{"secret_path":"/Users/someone"},');
    const r = await handler(ingestReq(body, SECRET_A));
    expect(r.status).toBe(400);
    expect(counters.get('ingest_rejected_schema_invalid')).toBe(1);
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
    expect(({} as Record<string, unknown>)['secret_path']).toBeUndefined();
  });

  test('the same trick inside `product` is rejected too', async () => {
    const { handler, db } = makeHarness();
    const hb = makeHeartbeat('brokkr', INSTANCE_A);
    const body = JSON.stringify(hb).replace('"product":{', '"product":{"__proto__":{"x":1},');
    expect((await handler(ingestReq(body, SECRET_A))).status).toBe(400);
    expect(db.countHeartbeats(INSTANCE_A, 'brokkr')).toBe(0);
  });
});
