# AGENTS.md — mythical-telemetry

The shared **product telemetry** layer for mythicalOS — one repo holding both halves of the
contract so they cannot drift: `packages/telemetry/` (**`@mythicalos/telemetry`**, the heartbeat
client products consume — frozen envelope, per-product bodies, identity derivation, opt-out,
dual-send transport; published to npm) and the two collectors (`collector/` — Bun + SQLite, the
reference you can run yourself; `collector-worker/` — Cloudflare Workers + D1, the deployed
one). Neither collector is ever published as a package.

## Authority & precedence

Repository orientation, not a role contract. If a role, playbook, or system prompt governs your
session, that contract is authoritative and supersedes anything here. This file grants no edit,
run, commit, push, publish, or deploy permission.

## Commands

Run only if your active role permits command execution.

- Install: `bun install`
- Test: `bun test` — includes the **schema ↔ zod ↔ emitter ↔ collector lockstep test**, the
  reason this is one repo
- Typecheck: `bun run typecheck` · Manifest check: `bun run check:manifest`

Report skipped or failing checks exactly.

## Boundaries & gotchas

- **A schema change is a three-place change** — envelope schema, emitter, and BOTH collectors'
  validation/admission move in lockstep, and the lockstep test must see it. (It exists because a
  rename once touched two of the three and no test could see across the gap.)
- **`docs/FIELDS.md` is the complete field list.** Nothing outside it is ever sent, and the
  schema rejects undeclared fields structurally — a new field lands in FIELDS.md, the schema,
  the emitter, and both collectors together, or not at all.
- **Never introduce a shared or baked write key.** Ingest identity is derived
  (`sha256(instance_secret)` → id, recomputed and constant-time-compared per request): no
  registration, no stored key material, no credential to leak. Any "just add an API key" change
  breaks the model.
- **The README's deployment paragraph is deliberately kept current** ("as of this writing the
  central collector…"). If you change where or whether heartbeats are received, update it in the
  same change — a claim about where user data goes must never go stale.
- Copy-destination identity is destination-scoped: the central identity is never disclosed to
  operators, and changing a copy endpoint rotates the derived id. Preserve both properties.
- This repo is consumed as a pinned submodule by a private downstream workspace: land and push
  on `main` here first, then the consumer bumps its pin.
