<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
    <img src=".github/assets/logo-light.svg" alt="mythicalOS" width="84" height="84">
  </picture>
</p>

<h1 align="center">mythical-telemetry</h1>

<p align="center">
  <strong>The shared heartbeat for mythicalOS products — and the collector that receives it, in one repo so they can't drift.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License: Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/@mythicalos/telemetry"><img src="https://img.shields.io/npm/v/@mythicalos/telemetry.svg?logo=npm&color=cb3837" alt="npm: @mythicalos/telemetry"></a>
  <img src="https://img.shields.io/badge/Bun-111.svg?logo=bun&logoColor=white" alt="Bun">
  <a href="https://mythicalos.ai"><img src="https://img.shields.io/badge/part_of-mythicalOS-0F6B66.svg" alt="Part of mythicalOS"></a>
</p>

---

| Path | What it is | Published |
|------|------------|:---------:|
| `packages/telemetry/` | **`@mythicalos/telemetry`** — the heartbeat client every product consumes: frozen envelope, per-product bodies, identity derivation, opt-out, dual-send transport. | npm |
| `collector/` | The reference ingest service (Bun + SQLite). Run your own, or don't. | — |
| `collector-worker/` | The same service on Cloudflare Workers + D1 — the deployed one. | — |

**Why one repo:** the schema, the emitter, and the validator must not drift, so a single lockstep
test spans all three. (A real defect once slipped through because a rename touched two of them and
no test could see across the gap.)

## What's collected — and what isn't

The full field list is [`docs/FIELDS.md`](docs/FIELDS.md); nothing outside it is ever sent, and the
schema rejects undeclared fields structurally. The payload carries **no** names, paths, hostnames,
emails, prompts, source, SQL, job names, or database identifiers.

It is **pseudonymous, not anonymous** — the instance id is stable across days, so daily records form
a longitudinal series. We say that plainly rather than claim an anonymity the design doesn't provide.

Identity is **derived, not registered**: each install holds a random `instance_secret` that never
leaves it, and the id is `sha256(secret)` — there is no stored key, no shared write key, and nothing
to leak. See [`docs/FIELDS.md`](docs/FIELDS.md) and the collector READMEs for the mechanics.

## Where it goes

Telemetry is **opt-out** — on by default, all-or-nothing, explained in each product's UI. Heartbeats
go to the central collector; an operator may configure an additional **copy** to their own endpoint
(never a replacement), carrying its own destination-scoped identity.

> As of this writing the central collector **is deployed** at `telemetry.mythicalos.ai` — the
> `collector-worker/` above. No released product sends to it yet, so it has received nothing so far.
> This note is kept current: a claim about where your data goes should never go stale.

## Develop

```sh
bun install
bun test           # includes the schema ↔ zod ↔ emitter ↔ collector lockstep
bun run typecheck
```

## License

**Apache-2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE); the licence covers the code, not the
mythicalOS name and marks ([TRADEMARK.md](TRADEMARK.md)). Everything here is open and stays open —
the collector in this repo *is* the one that receives central heartbeats; there is no separate,
closed ingest, and nothing is held back for the separate, private paid tier. Contributions welcome
under a DCO sign-off, no CLA — see [CONTRIBUTING.md](CONTRIBUTING.md).
