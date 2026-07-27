# mythical-telemetry

The shared **product telemetry** layer for mythicalOS — one repo holding both halves of the
contract:

| Path | What it is | Published? |
|---|---|---|
| `packages/telemetry/` | **`@mythicalos/telemetry`** — the heartbeat client every product consumes: the frozen envelope, the per-product bodies, identity derivation, opt-out, and the dual-send transport. | ✅ npm |
| `collector/` | The ingest service that receives heartbeats. Operator-deployable; run your own or don't. | ❌ never published |

**Why one repo:** the schema, the emitter that produces payloads and the validator that accepts
them must not drift. Keeping them together lets a single lockstep test span all three — a real
defect once slipped through precisely because a rename touched two of them and not the third,
and no test could see across the gap.

## What is collected

Read **[`docs/FIELDS.md`](docs/FIELDS.md)** — the complete field list, with the producer, value
class and temporal class of every leaf. Nothing outside that list is ever sent, and the schema
rejects undeclared fields structurally.

The payload carries **no** names, paths, hostnames, emails, prompts, source, SQL, job names or
database identifiers. It is **pseudonymous, not anonymous**: the instance id is stable across
days, so the daily records form a longitudinal series. We say so plainly rather than claiming
an anonymity the design does not provide.

## Identity — derived, stateless, no shared secret

Each install holds a 32-byte random `instance_secret` (hex) that is **never sent on any route**.
Its id is `sha256(secret)[0..16]` formatted as a UUIDv4. Ingest authorization is the collector
recomputing that derivation from the header secret and constant-time comparing it to the
payload's claimed id.

There is no registration, no stored key material, no first-writer race, and **no shared or
baked write key** — one install cannot impersonate another, and there is no credential to leak.
Do not introduce one.

Per-install reads require the same secret. The id alone is not a read capability.

## Destinations

Telemetry is **opt-out** — on by default, all-or-nothing, and explained in each product's UI.
When enabled, heartbeats always go to the central collector. An operator may additionally
configure a **copy** to their own endpoint; a copy never replaces central, and
copy-without-central is not a valid configuration.

The copy carries its **own** destination-scoped secret and a **different** derived id. The
central identity is never disclosed to an operator — otherwise they could impersonate that
install at central, or delete its data. Changing the copy endpoint rotates that identity; it is
never carried to a new destination.

## Collector compatibility

The central collector accepts both **v1** and **v2** payloads for a stated support window, so
an installation pinned to an older client keeps working. *(Window length: to be published here
before the first release — gate G15.)*

An operator's own collector must be at least the minimum version stated in the client's release
notes. A copy always sends v2; there is no version negotiation, and a version rejection
surfaces as an actionable delivery error rather than silent loss.

## Development

```sh
bun install
bun test           # includes the schema ↔ zod ↔ emitter ↔ collector lockstep
bun run typecheck
bun run check:manifest
```

## Licence

**Apache-2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The licence covers the code,
not the names and branding; see [`TRADEMARK.md`](TRADEMARK.md). Contributions are accepted
under the same licence with a [DCO](https://developercertificate.org/) sign-off and **no CLA**.
