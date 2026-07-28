# What the heartbeat carries — the field contract

This is the authoritative list of every field a mythicalOS product may send. It is the
**G4 sign-off artifact**: each leaf names the producer that generates it, its value class, and
its temporal class. Nothing outside this list is emitted, and the schema rejects undeclared
fields structurally.

Read this alongside `packages/telemetry/schema/heartbeat.v1.json` (the machine-checked form)
and `packages/telemetry/schema/field-classes.json` (the manifest CI validates against).

## The rules this list obeys

1. **Counts, buckets, booleans, enums and version strings only.** No names, paths, hostnames,
   emails, prompts, source, SQL, job names, database/schema/table names, or identifiers of any
   kind — for any product.
2. **Temporal class is `delta` or `gauge`. `cumulative` is not a valid class on any leaf.**
   Products holding lifetime counters normalise to per-day deltas *at the emitter* before the
   value reaches the wire (see "Delta normalisation" below).
3. **Gauges mean "last sample of the day wins."** A multi-day window reads the latest sample
   per day; gauges are never summed.
4. **Every leaf has a named producer.** A field whose producer does not exist yet cannot be
   frozen — that is what forces instrumentation to land before the schema does.
5. **`additionalProperties: false` at every level, including inside `metrics`.** This is a
   structural fence, *not* a privacy policy — see "The limit of mechanical enforcement".

## Envelope — shared, frozen, identical for all three products

| Field | Class | Temporal | Producer | Notes |
|---|---|---|---|---|
| `schema_version` | `version` | — | constant `1` | There is one heartbeat schema; a second would be a new file and a new number, never a widening of this one. |
| `instance_id` | — | — | `deriveInstanceId(secret)` | UUIDv4 *format*, derived as `sha256(secret utf-8)[0..16]` with v4 version nibble + variant bits stamped. **Per product** — the three products never share one (gate G1a). |
| `day` | — | — | emitter | `YYYY-MM-DD`, UTC. |
| `product.name` | `enum` | — | constant per product | `brokkr` \| `saga` \| `skuld`. Closed set; this is the discriminator. |
| `product.version` | `version` | — | package version | |
| `platform.os` | `enum` | gauge | `process.platform` | `darwin` \| `linux` \| `win32` \| `other`. |
| `platform.arch` | `enum` | gauge | `process.arch` | `arm64` \| `x64` \| `other`. |
| `metrics` | — | — | per product | Discriminated on `product.name`; the three bodies below. |

**`opaque-id` is deliberately absent from the class vocabulary.** Gate G1b chose three
documented per-product identities over a shared `install_group` field, so the class would have
had no members. Anything reintroducing it re-opens G1b and must be a *generated UUIDv4
validated against that exact grammar* — a charset-and-length limit is not a fence, because a
base64-encoded hostname satisfies one.

## Delta normalisation — how cumulative producers reach a `delta` leaf

saga and skuld hold **lifetime cumulative** counters in a local `counters` table. brokkr already
produces completed-day deltas. The wire carries deltas only, so saga and skuld each:

1. persist the previous day's raw lifetime snapshot per counter, alongside the telemetry
   identity and independent of the counters table itself;
2. emit `today − yesterday` for each counter;
3. treat a counter that has gone **backwards** as a process restart and emit the *new* value,
   not a negative number. Only the producer can distinguish a restart from a genuine drop; the
   collector never can, which is exactly why this belongs at the emitter.
4. On the very first day (no prior snapshot) emit the current value and record the snapshot.

A delta leaf is therefore always `>= 0`, and the schema enforces `minimum: 0`.

### The FIRST heartbeat from any instance is not a one-day delta — the collector must handle this

Rule 4 means a counter with no prior snapshot emits its **current lifetime value**. On a fresh
install that is genuinely about one day's activity. On an install that has been running for
months before telemetry was first switched on, it is **months of accumulation reported as a
single day**.

This is not an edge case that might occur — **it is guaranteed for every install**. Telemetry
has never been activated anywhere, so at first activation every counter on every instance is
seeing its first snapshot. The same applies whenever a *new leaf* is added later: its first
heartbeat on an existing install carries that counter's whole history.

The emitter deliberately does **not** solve this by emitting `0` for an unseen counter — that
would silently discard real activity, and the lifetime total is genuinely useful on the first
observation.

**Therefore the collector must exclude each `(instance_id, product)`'s first observed day from
any per-day rate statistic**, and must not present it as a representative day. Storing it is
correct; averaging it in is not. A collector that skips this rule will report a large one-time
spike at every install's activation and will overstate per-day rates permanently, because the
inflated row never ages out of a lifetime average.

## `brokkr` body

**Ten sections under `metrics`,** pinned as a set by the lockstep test so a leaf cannot be
added, removed, renamed or reclassified without the build saying so.

Sections: `config`, `features`, `sessions`, `context_fill`, `mode_split`, `spine`, `models`,
`tokens`, `review`, `errors`.

Classes: every integer under `sessions` / `mode_split` / `spine` / `tokens` / `review` /
`errors.classes` is `count` + `delta`; `config.*` and `features.*` are `enum`/`bool`/`count` +
`gauge`; `context_fill.peak_histogram` is a `bucket` array + `delta`;
`context_fill.avg_mean` is a **nullable `ratio`** + `delta` (this is why `ratio` and `nullable`
are load-bearing classes and not padding); `models` is an array of allowlisted model ids
(`enum` + `delta`); `spine.estimated` is `bool` + `gauge`.

Producer: `heartbeat-rollup.ts` folds, already shipping.

## `saga` body

| Leaf | Class | Temporal | Producer | Status |
|---|---|---|---|---|
| `collect.runs` | `count` | delta | `collect_runs_total` (`monitor/engine.ts`) | existing |
| `collect.errors` | `count` | delta | `collect_errors_total` (`monitor/engine.ts`) | existing |
| `refusals` | `count` | delta | `refusals_total` (`engines/adhoc.ts`, `engines/factory.ts`) | existing |
| `mcp.tool_calls` | `count` | delta | `mcp_tool_calls_total` (`mcp/dispatch.ts`) | existing |
| `mcp.refusals` | `count` | delta | `mcp_refusals_total` (`mcp/dispatch.ts`) | existing |
| `advisories.fired` | `count` | delta | `advisories_fired_total` (`advisor/rules.ts`) | existing |
| `advisories.by_severity.{info,warn}` | `count` | delta | `advisories_fired_{info,warn}_total`, per-severity bumps at the advisor fire site | NEW |
| `connections.by_engine.{postgres,mysql,sqlite}` | `count` | gauge | connections registry — count per `engine` | existing source, new shaping |
| `connections.total` | `count` | gauge | connections registry length | existing |
| `probe.outcomes.{ok,auth_failed,unreachable,timeout,other}` | `count` | delta | **new** bumps at the monitor's probe site | NEW |
| `uptime_bucket` | `bucket` | gauge | `uptimeBucket()` | existing |

**`advisories.by_severity` carries `{info, warn}` and NOT `critical` (amended 2026-07-27).** The
draft named a third severity that does not exist — the advisor's severity type is `info | warn`
in both its store and its UI types, and no rule emits anything else. Emitting `critical: 0`
forever would be a leaf with no producer, which rule 4 forbids. The emitted set is fenced to the
source declaration by a two-way compile-time assignability check plus a runtime test that parses
the declaration, so adding a severity upstream without extending the payload breaks the build
rather than silently dropping data.

**Probe-outcome classification is deliberately coarse, and derived from the bounded engine error
CODE only — never an error message.** `MISSING_CREDENTIAL` maps to `auth_failed` (nothing left
the host, but that is the class an operator would act on); `TLS_FAILED` maps to `other`, not
`unreachable`, because TCP did connect and "unreachable" would be false.

`connections.by_engine` is a count per engine family rather than a set of `engines_used`
booleans — strictly more informative and no less safe, and derivable from the registry today
with no new instrumentation. Engine family is a closed set; an unrecognised engine is not emitted.

**Database size buckets are NOT in this list.** The plan's §4 target named them, but no producer
exists and adding one means reading per-database size — a step toward per-database granularity
that buys little. If it is wanted later it needs its own review and a new schema version.

## `skuld` body

| Leaf | Class | Temporal | Producer | Status |
|---|---|---|---|---|
| `jobs.created_by_type.{script,ai,report,agent_send,distill}` | `count` | delta | `jobs_created_by_type.*` | existing (note the `agent-send` → `agent_send` key normalisation) |
| `runs.total` | `count` | delta | `runs_total` | existing |
| `runs.succeeded` | `count` | delta | `runs_succeeded` | existing |
| `runs.failed` | `count` | delta | `runs_failed` | existing |
| `runs.chain_rejections` | `count` | delta | `chain_rejections` | existing |
| `events.runs_enqueued` | `count` | delta | `event_runs_enqueued`, event fire that enqueued a run | existing |
| `events.asks_delivered` | `count` | delta | `event_asks_delivered` | existing |
| `events.rate_limit_deferred` | `count` | delta | `rate_limit_merged`, a fire deferred until the oldest in-window fire ages out | existing |
| `events.route_errors` | `count` | delta | `event_route_errors`, a rule matcher/resolver threw | existing |
| `gate.rejections` | `count` | delta | `gate_rejections`, gate refuse path | existing |
| `gate.approvals` | `count` | delta | `gate_approvals`, gate **admit** path | NEW |
| `sandbox.pool_exhausted` | `count` | delta | `sandbox_pool_exhausted` | existing |
| `sandbox.uid_vends` | `count` | delta | `sandbox_uid_vends`, at the uid **pool boundary** | NEW |
| `detection_state` | `enum` | gauge | `detection_state` gauge | existing — closed enum `unknown` \| `not_detected` \| `detected` |
| `uptime_bucket` | `bucket` | gauge | `uptimeBucket()` | existing |

### Amendments, and what they cost

**`events.deferrals` was DROPPED before freezing (2026-07-27).** It was drafted against
`event_deferrals`, whose producer is dead: an earlier design change turned the event trigger arm
from validate-and-**defer** into validate-and-**run**, so the deferral path is unreachable and
the bump was retired. Rule 4 forbids freezing a leaf with no producer, and repointing it at a
different counter would silently redefine a frozen field's meaning — which needs the named human
review this document mandates, not a quiet substitution. If event-deferral telemetry is wanted
later it becomes a **new leaf in a new schema version**, and that cost is the correct one.

This is what the producer rule is *for*: the field looked real in the plan, in the draft contract
and in the counter allowlist, and only building it surfaced that nothing had incremented it since
the design change.

**Four event leaves were ADDED in its place (2026-07-27)** — `events.runs_enqueued`,
`events.asks_delivered`, `events.rate_limit_deferred` and `events.route_errors`. All four bump
sites already existed and were verified durable empirically (write → close → reopen → read), not
just by reading the code. `rate_limit_merged` turned out to be the genuine deferral signal the
dropped leaf was reaching for, so it earns an honestly-named slot of its own. Note this is an
**addition of new leaves**, not a repointing of the dropped one: `events.rate_limit_deferred`
says exactly what it counts, whereas reusing the old name would have silently changed a frozen
field's meaning.

Three durable counters were considered and **excluded**, recorded so the reasoning survives:

- **`event_arm_refused`** — its in-memory dedup means a restart re-counts a still-refused job, so
  its delta systematically over-reports. A counter with a known, uncorrectable bias is worse than
  no counter, and `gate.rejections` covers the same ground with better fidelity.
- **`coalesce_suppressed`** and **`events_ignored_replay`** — real and privacy-safe, but they
  measure *our* window tuning rather than product usage, and we can read those off our own
  installs. Not worth a permanent slot in someone else's payload.

Three further clarifications from implementation, none of which change the wire shape:

- **`gate.approvals` counts gate *admissions*, not approvals granted.** It is the symmetric
  partner of `gate.rejections`; together they are the gate's throughput. A recurring job that was
  approved once bumps this on every run.
- **`sandbox.uid_vends` is counted at the uid pool boundary**, not at a single call site — the
  pool has more than one consumer, and per-caller counting under-reports.
- **`detection_state`'s "never probed" state is real and distinct.** The prior flat payload
  collapsed it into `0`, making "not detected" and "never asked" indistinguishable.

**skuld's `meta.instance_id` is NOT the telemetry identity and must not be touched.** It seeds
scheduling jitter (`engine/engine.ts`); replacing it silently changes when jobs run. Telemetry
mints a *separate* `telemetry_secret` + derived `telemetry_instance_id` alongside it.

The same applies to saga's `meta.instance_id`: it is a bare `crypto.randomUUID()` with no
preimage secret, so it cannot satisfy the collector's derived-identity check. Mint a separate
telemetry identity; leave `meta.instance_id` in its existing role.

## The limit of mechanical enforcement — read before adding a field

CI validates that every leaf declares a class, that strings are closed enums or bounded
version/bucket forms, that no open-ended key maps exist, and that no leaf is classed
`cumulative`. **CI cannot tell a privacy-safe count from a privacy-hostile one.** A product
author can add `metrics.database_oid: integer` or `metrics.probe_error: string`, update the
schema, the zod validator, the manifest and the emitter together, and every mechanical check
still passes.

Therefore: **any new or reclassified leaf requires a named human privacy review, recorded in
the pull request.** Do not describe CI as enforcing privacy — it enforces shape.

## What this payload is, honestly

It is **pseudonymous, not anonymous.** A stable `instance_id` joined across days to product
version, OS/arch, engine mix and job mix is a longitudinal record, and a rare combination can
single out a small installation. Never describe it as anonymous in UI copy, README text, or the
privacy notice.
