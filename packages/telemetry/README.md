# @mythicalos/telemetry

The shared **heartbeat client** for the mythicalOS product family: one frozen envelope, three
per-product bodies, one runtime validator, one identity derivation, one consent model, one
transport.

**Why one package:** the privacy rules must exist exactly once. Three hand-maintained copies of
"counts and buckets only, nothing nameable" is three chances to leak, and a client and a collector
that each keep their own validator will drift — a broader client gets its payloads rejected, a
narrower one loses real data. Keeping the schema, the emitter and the validator together is what
lets a single lockstep test span all three.

## What is collected

The complete field list — every leaf, its producer, its value class and its temporal class — is in
[`docs/FIELDS.md`](../../docs/FIELDS.md) at the repository root. Nothing outside that list is sent,
and the schema rejects undeclared fields structurally at every level.

The payload carries **no** names, paths, hostnames, emails, prompts, source, SQL, job names or
database identifiers.

### It is pseudonymous, not anonymous — and we say so

The instance id is **stable across days**, so the daily records form a longitudinal series, and a
rare combination of version, OS/arch and metric mix can single out a small installation. Do not
describe this payload as "anonymous" in UI copy, a README, or a privacy notice.

### Scope

This package covers the **heartbeat channel**. A product may have other outbound channels with
their own consent story. Do not write "telemetry carries no identifiers" over a product whose other
channels say otherwise — scope the claim to usage telemetry and describe the rest separately.

## Identity — derived, stateless, no shared secret

```
instance_secret  32 random bytes, hex. NEVER serialized on any HTTP route.
instance_id      uuidv4Format(sha256(instance_secret)[0..16])
```

Ingest authorization is the collector recomputing that derivation from the header secret and
constant-time comparing it to the payload's claimed id. No registration, no stored key material, no
first-writer race, and **no shared or baked write key** — one install cannot impersonate another,
and there is no credential to leak. Do not introduce one.

> ⚠ The derivation hashes the **UTF-8 bytes of the 64-character hex string**, not the decoded 32
> bytes. Changing that silently mints a new id for every existing install, orphaning its history
> and its delete capability. `identity.test.ts` pins known secret → id vectors for exactly this
> reason.

### Destination-scoped copy identities

A copy destination gets its **own** secret and its **own** derived id. The central secret is never
sent to a copy — an operator holding it could authenticate as that install at central and delete
its data. Changing the copy URL **rotates** that identity and destroys the retired one; a secret is
never carried to a new destination.

## Consent

```ts
{ enabled: boolean, source: "unset" | "default-on" | "user", decided_at: string }
```

Only `source: "unset"` may be flipped on by a migration. `source: "user"` is never overwritten —
by a migration or by anything else. `source: "unset"` never sends, whatever `enabled` says.

Provenance prevents *future* ambiguity; it cannot reconstruct what a pre-existing bare `false`
meant. `fromLegacyBoolean` defaults to the conservative reading (treat it as a user opt-out) and
the choice is overridable and documented, not silent.

## Dual-send

Always central; optionally **also** an operator copy. A copy supplements central and never replaces
it — **copy-without-central is not a valid configuration and is rejected.**

Delivery is not atomic and is deliberately **not coupled**: a flaky operator endpoint must not
suppress central, and a central outage must not suppress the copy. Each `(day, destination)` keeps
its own durable record — attempt count, last attempt, next attempt, terminal status — because a
single per-day marker is wrong the moment there are two destinations: mark on first success and the
copy never retries; leave it unmarked and central is re-sent on every copy retry.

Retries are bounded and jittered (a fleet-wide fixed retry after an outage is a thundering herd),
single-flight per `(day, destination)`, and carry an idempotency key so an operator collector can
dedupe.

**Opt-out is a hard fence.** Disabling telemetry, or changing an endpoint or credential, cancels
queued retries and purges pending state. The fence is **per destination**: changing only the copy
URL does not cancel an unresolved central delivery whose consent and configuration are unchanged.
Only a global opt-out fences both.

Partial state is exposed, not hidden — "central delivered, copy unresolved" is a real state and
`SendReport.partial` reports it.

## Operator-endpoint isolation

The copy destination is attacker-controlled input, fetched from inside the deployment. `src/ssrf.ts`
enforces: `https` only (with an explicit opt-in for `http` to loopback), **no redirect following**,
resolve-and-block of loopback / link-local / RFC1918 / CGNAT / ULA / IPv4-mapped / NAT64 / 6to4 /
multicast / reserved space with **every** resolved address required to pass, a hard per-attempt
deadline plus an overall fan-out budget, a bounded response read, bounded concurrency, and a
circuit breaker.

**The connection is pinned to the validated address.** Validate-then-fetch leaves a DNS-rebinding
window in which validation sees a public address and the connection resolves to `127.0.0.1`; the
socket layer is handed a resolver that can only return the address already validated, so there is
no second resolution to race. SNI and certificate verification stay on the original hostname, so
pinning costs nothing in TLS identity.

## Disclosure

`emitter.disclosure()` returns the exact wire bytes **per destination, as a collection** — with
dual-send the central and copy bodies differ (different `instance_id`), so a single response would
be exact for at most one of them. It works while telemetry is **off**, which is the one moment
someone most wants to look.

## Usage

```ts
import {
  HeartbeatEmitter, IdentityStore, Transport,
  buildSagaMetrics, normalizeDeltas, applyDefaultOn, parseConsent,
} from "@mythicalos/telemetry";

const identity = new IdentityStore({ stateRoot });
const transport = new Transport({ stateRoot });

const emitter = new HeartbeatEmitter({
  product: "saga",
  version: VERSION,
  identity,
  transport,
  getConsent: () => readConsent(),          // read LIVE — a flip takes effect next tick
  getEndpoints: () => ({ centralUrl, copyUrl }),
  buildMetrics: (day) => buildSagaMetrics({ deltas, connections, uptimeSeconds }),
});

const result = await emitter.emit();        // { sent: false, reason: "opted_out" } when disabled
```

Products holding **lifetime** counters normalise first — the wire carries per-day deltas only:

```ts
const { deltas, snapshot } = normalizeDeltas(yesterdaySnapshot, currentLifetimeCounters);
persist(snapshot);
```

A counter that went **backwards** is a process restart, and `normalizeDeltas` emits the new value,
never a negative. Only the producer can tell a restart from a genuine drop; the collector never
can, which is why this belongs at the emitter.

## Schema and the field-class manifest

- `schema/heartbeat.v2.json` — the canonical schema. `additionalProperties: false` at every level,
  including inside `metrics`. brokkr's ten sections are v1's, **verbatim**; the lockstep test
  re-asserts that deep equality on every run.
- `schema/heartbeat.v1.json` — retained unchanged for the record and for dual ingest.
- `schema/field-classes.json` — every leaf's value class and temporal class. `cumulative` is not a
  legal temporal value; there is no `opaque-id` value class.
- `scripts/check-field-classes.ts` — the CI gate.

> **The check enforces SHAPE, not privacy.** It cannot distinguish `database_oid: integer` from a
> legitimate count. Any new or reclassified leaf needs a **named human privacy review recorded in
> the pull request**. Do not describe this check as enforcing privacy.

## Development

```sh
bun install
bun test          # includes lockstep.test.ts: JSON Schema ↔ validator ↔ real emitter output
bun run typecheck
bun run check:manifest
```

## Licence

Apache-2.0. See [`LICENSE`](../../LICENSE) and [`NOTICE`](./NOTICE).
