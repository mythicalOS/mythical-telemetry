// v1 → v2 normalization: a structural move that must be faithful, total, and
// — the security property — incapable of laundering an undeclared section into
// an acceptable payload.

import { describe, expect, test } from 'bun:test';
import { detectWireVersion, normalizeToV2, v1ToV2 } from '../src/normalize';
import { brokkrMetrics, INSTANCE_A, makeV1, makeV2 } from './fixtures';

describe('detectWireVersion', () => {
  test('accepts exactly the literals 1 and 2', () => {
    expect(detectWireVersion({ schema_version: 1 })).toBe(1);
    expect(detectWireVersion({ schema_version: 2 })).toBe(2);
  });
  test('rejects everything else, including near-misses', () => {
    for (const v of ['1', '2', 1.0000001, 0, 3, null, undefined, true, [1], { v: 1 }]) {
      expect(detectWireVersion({ schema_version: v })).toBeNull();
    }
    expect(detectWireVersion(null)).toBeNull();
    expect(detectWireVersion([])).toBeNull();
    expect(detectWireVersion('nope')).toBeNull();
    expect(detectWireVersion({})).toBeNull();
  });
});

describe('normalizeToV2', () => {
  test('a v2 document passes through untouched, by identity', () => {
    const doc = makeV2('saga');
    const result = normalizeToV2(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wireVersion).toBe(2);
    expect(result.value).toBe(doc);
  });

  test('a non-object is refused', () => {
    for (const raw of [null, 42, 'x', [], true]) {
      const result = normalizeToV2(raw);
      expect(result.ok).toBe(false);
    }
  });

  test('an unknown schema_version is refused rather than guessed at', () => {
    const result = normalizeToV2({ schema_version: 3, instance_id: INSTANCE_A });
    expect(result).toEqual({ ok: false, reason: 'unsupported_schema_version' });
  });
});

describe('v1 → v2 fidelity', () => {
  test('the envelope is preserved and the sections move under metrics', () => {
    const v1 = makeV1(INSTANCE_A, '2026-07-09');
    const result = normalizeToV2(v1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wireVersion).toBe(1);

    const out = result.value as Record<string, any>;
    expect(Object.keys(out).sort()).toEqual(
      ['day', 'instance_id', 'metrics', 'platform', 'product', 'schema_version'].sort(),
    );
    expect(out['schema_version']).toBe(2);
    expect(out['instance_id']).toBe(INSTANCE_A);
    expect(out['day']).toBe('2026-07-09');
    expect(out['platform']).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(out['product']).toEqual({ name: 'brokkr', version: '0.1.0' });
    // Every v1 section, verbatim, in order-independent equality.
    expect(out['metrics']).toEqual(brokkrMetrics());
  });

  test('normalization does not mutate its input', () => {
    const v1 = makeV1();
    const before = JSON.stringify(v1);
    v1ToV2(v1);
    expect(JSON.stringify(v1)).toBe(before);
  });

  test('daemon_version → version, and nothing else in product is disturbed', () => {
    const out = v1ToV2({ schema_version: 1, product: { name: 'brokkr', daemon_version: 'other' } });
    expect(out['product']).toEqual({ name: 'brokkr', version: 'other' });
  });

  test('an UNDECLARED v1 section is moved, never dropped — it must stay rejectable', () => {
    // The laundering hazard: copying a known list of sections across would
    // silently discard this and turn a rejectable payload into a valid one.
    const v1 = makeV1();
    v1['secret_paths'] = ['/Users/someone/work'];
    const out = v1ToV2(v1);
    expect((out['metrics'] as Record<string, unknown>)['secret_paths']).toEqual(['/Users/someone/work']);
  });

  test('a v1 document already carrying `metrics` nests it, so it stays undeclared', () => {
    const v1 = makeV1();
    v1['metrics'] = { smuggled: true };
    const out = v1ToV2(v1);
    expect((out['metrics'] as Record<string, unknown>)['metrics']).toEqual({ smuggled: true });
  });

  test('BOTH daemon_version and version present: neither is dropped, so the payload stays rejectable', () => {
    const out = v1ToV2({
      schema_version: 1,
      product: { name: 'brokkr', daemon_version: '1.0.0', version: '2.0.0' },
    });
    expect(out['product']).toEqual({ name: 'brokkr', daemon_version: '1.0.0', version: '2.0.0' });
  });

  test('a non-object product is passed through exactly as it arrived', () => {
    expect(v1ToV2({ schema_version: 1, product: 'brokkr' })['product']).toBe('brokkr');
    expect(v1ToV2({ schema_version: 1, product: null })['product']).toBeNull();
    expect(v1ToV2({ schema_version: 1 })['product']).toBeUndefined();
  });

  test('a product without daemon_version is left alone', () => {
    const out = v1ToV2({ schema_version: 1, product: { name: 'brokkr', version: '1.0.0' } });
    expect(out['product']).toEqual({ name: 'brokkr', version: '1.0.0' });
  });

  test('metrics is always present, even for an otherwise empty document', () => {
    expect(v1ToV2({ schema_version: 1 })).toEqual({ schema_version: 2, metrics: {} });
  });
});

describe('`__proto__` cannot be used to launder a field past the move', () => {
  // `JSON.parse` creates a genuine OWN `__proto__` property, but assigning it
  // back with `target[key] = value` invokes the inherited setter instead — the
  // field would vanish from the normalized document and leave something the
  // validator accepts. These payloads are built with JSON.parse precisely
  // because an object literal would NOT reproduce the hazard.

  test('a top-level `__proto__` section survives the move as an own property', () => {
    const v1 = JSON.parse('{"schema_version":1,"__proto__":{"polluted":true}}');
    const out = v1ToV2(v1);
    const metrics = out['metrics'] as Record<string, unknown>;
    expect(Object.hasOwn(metrics, '__proto__')).toBe(true);
    expect(Object.keys(metrics)).toContain('__proto__');
    // ...and it round-trips through JSON, which is how it reaches the validator.
    expect(JSON.parse(JSON.stringify(out)).metrics.__proto__).toEqual({ polluted: true });
  });

  test('nothing is polluted along the way', () => {
    const v1 = JSON.parse('{"schema_version":1,"__proto__":{"polluted":true}}');
    const out = v1ToV2(v1);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out['metrics'] as object)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('a `__proto__` inside product survives both the rename path and the pass-through path', () => {
    const renamed = v1ToV2(
      JSON.parse('{"schema_version":1,"product":{"name":"brokkr","daemon_version":"1.0.0","__proto__":{"x":1}}}'),
    );
    expect(Object.keys(renamed['product'] as object).sort()).toEqual(['__proto__', 'name', 'version']);

    const passedThrough = v1ToV2(
      JSON.parse('{"schema_version":1,"product":{"name":"brokkr","version":"1.0.0","__proto__":{"x":1}}}'),
    );
    expect(Object.keys(passedThrough['product'] as object).sort()).toEqual(['__proto__', 'name', 'version']);
  });

  test('a `constructor` key is likewise carried, not swallowed', () => {
    const out = v1ToV2(JSON.parse('{"schema_version":1,"constructor":{"nope":1}}'));
    expect((out['metrics'] as Record<string, unknown>)['constructor']).toEqual({ nope: 1 });
  });
});
