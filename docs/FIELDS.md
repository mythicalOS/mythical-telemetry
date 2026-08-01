# What the heartbeat carries — the field contract

This is the authoritative list of every field a mythicalOS product may send. Each leaf names the
producer that generates it, its value class, and its temporal class. Nothing outside this list is
emitted, and the schema rejects undeclared fields structurally.

Read it alongside `packages/telemetry/schema/heartbeat.v1.json` (the machine-checked form) and
`packages/telemetry/schema/field-classes.json` (the manifest CI validates against).

**Where the producers live.** This repository holds the client that assembles a payload and the
collector that receives it. The counters and gauges a payload is built *from* are instrumentation
inside each product — `brokkr`, `saga` and `skuld` each maintain their own, in their own
repositories. Where a table below names a counter, that name is the contract: the client reads it by
name out of a normalised delta map, and the accepted names are pinned here by `SAGA_COUNTER_NAMES`
and `SKULD_COUNTER_NAMES` in `packages/telemetry/src/bodies/`. Nothing outside those lists is ever
read into a payload, so a counter that some other subsystem mis-names — with a database, host or
connection name in it — cannot reach the wire even by accident.

## The rules this list obeys

1. **Counts, buckets, booleans, enums and version strings only.** No names, paths, hostnames,
   emails, prompts, source, SQL, job names or database/schema/table names — for any product.
   Exactly one identifier reaches the wire, the envelope's `instance_id`, and it is *derived*
   rather than descriptive: see "What this payload is, honestly" for what that does and does not
   hide. Nothing under `metrics` identifies a person, a machine or a resource.
2. **Temporal class is `delta` or `gauge`. `cumulative` is not a valid class on any leaf.**
   Products holding lifetime counters normalise to per-day deltas *at the emitter* before the
   value reaches the wire (see "Delta normalisation" below).
3. **Gauges mean "last sample of the day wins."** A multi-day window reads the latest sample
   per day; gauges are never summed.
4. **Every leaf has a named producer.** A field whose producer does not exist yet cannot be
   frozen — that is what forces instrumentation to land before the schema does.
5. **`additionalProperties: false` at every level, including inside `metrics`.** This is a
   structural fence, *not* a privacy policy — see "Adding or changing a field".

## Envelope — shared, frozen, identical for all three products

| Field | Class | Temporal | Producer | Notes |
|---|---|---|---|---|
| `schema_version` | `version` | — | constant `1` | There is one heartbeat schema; a second would be a new file and a new number, never a widening of this one. |
| `instance_id` | — | — | `deriveInstanceId(secret)` | UUIDv4 *format*, derived as `sha256(secret utf-8)[0..16]` with v4 version nibble + variant bits stamped. **Per product** — the three products never share one, and a copy destination receives a different, destination-scoped id. |
| `day` | — | — | emitter | `YYYY-MM-DD`, UTC. |
| `product.name` | `enum` | — | constant per product | `brokkr` \| `saga` \| `skuld`. Closed set; this is the discriminator. |
| `product.version` | `version` | — | package version | Strict semver-core, else the literal `other`. |
| `platform.os` | `enum` | gauge | `process.platform` | `darwin` \| `linux` \| `win32` \| `other`. |
| `platform.arch` | `enum` | gauge | `process.arch` | `arm64` \| `x64` \| `other`. |
| `metrics` | — | — | per product | Discriminated on `product.name`; the three bodies below. |

**There is deliberately no identifier class in the vocabulary.** The contract gives each product its
own documented identity rather than a shared `install_group` field, so such a class would have had
no members, and `instance_id` is fenced by an exact grammar instead — the UUIDv4 pattern above,
which no name, label or encoded hostname satisfies. Anything that reintroduces an identifier-shaped
leaf must be a *generated UUIDv4 validated against that exact grammar*: a charset-and-length limit
is not a fence, because a base64-encoded hostname satisfies one. It is also exactly the kind of
change "Adding or changing a field" below exists for.

## Delta normalisation — how cumulative producers reach a `delta` leaf

saga and skuld hold **lifetime cumulative** counters locally. brokkr already produces completed-day
deltas. The wire carries deltas only, so saga and skuld each:

1. persist the previous day's raw lifetime snapshot per counter, alongside the telemetry
   identity and independent of the counters themselves;
2. emit `today − yesterday` for each counter;
3. treat a counter that has gone **backwards** as a process restart and emit the *new* value,
   not a negative number. Only the producer can distinguish a restart from a genuine drop; the
   collector never can, which is exactly why this belongs at the emitter.
4. On the very first day (no prior snapshot) emit the current value and record the snapshot.

A normalised counter is therefore always `>= 0`, and the schema floors every **numeric** delta leaf
at `minimum: 0`. (A handful of delta leaves are not numeric — `models[].name` is an `enum` — and a
floor does not apply to them; they are fenced by their closed value set instead.)

### A first snapshot is not a one-day delta — the collector must handle this

Step 4 above means a counter with no prior snapshot emits its **current lifetime value**. On a fresh
install that is genuinely about one day's activity. On an install that has been running for months
before telemetry was first switched on, it is **months of accumulation reported as a single day**.

This is not a hypothetical, and it is not once-per-install either. Three situations reach it, all
governed by `normalizeDeltas`:

- **A first snapshot.** Where the prior snapshot is absent, the emitted value is the counter's
  lifetime total, and the payload does not record how much of the install's life that covers. It
  therefore has to be read as *up to* the whole of it.
- **A newly instrumented leaf.** A counter absent from the prior snapshot is treated as first-run
  *for that counter alone*, so a leaf added later carries its whole history on the heartbeat that
  introduces it — on installs that have been reporting for months.
- **A lost snapshot.** If the stored snapshot goes missing, the next heartbeat re-enters the
  condition wholesale.

Consent bears on when a collector first *sees* this, not on when it happens: the emitter refuses to
send for an install nobody has decided for (`isSendPermitted`, in
`packages/telemetry/src/optout.ts`), so the first heartbeat a collector receives from an instance is
the earliest figure it will ever have for that identity — with no earlier row to difference it
against and nothing in the document saying how long a span it represents.

This applies to the delta-normalising producers, **saga** and **skuld**. brokkr does not normalise:
its rollup is already a completed-day fold, so its first heartbeat is one day like any other.

The emitter deliberately does **not** solve this by emitting `0` for an unseen counter — that
would silently discard real activity, and the lifetime total is genuinely useful on the first
observation.

**Therefore the collector must exclude each `(instance_id, product)`'s first observed day from
any per-day rate statistic**, and must not present it as a representative day. Storing it is
correct; averaging it in is not. A collector that skips this rule will report a large one-time
spike at every install's activation and will overstate per-day rates permanently, because the
inflated row never ages out of a lifetime average.

Both collectors in this repository implement it, for every product — a collector cannot tell which
producer a document came from, and for brokkr the rule costs one day of rate data and nothing else.
The first day an identity is seen is stamped once, on insert, as `instances.first_report_day`; it is
never backfilled from a later heartbeat, which would stamp an ordinary day as the first and bar it
from every rate for the rest of that install's life.

The authenticated per-install read reports the exclusion rather than performing it quietly:
`instance.first_report_day` is always returned, and when that day falls inside the requested window
the read also sets `rates.excluded_day` to it and `rates.excluded_reason` to
`"first_report_is_not_a_daily_delta"`. For a window that does not reach back that far, nothing was
excluded from it and both fields are `null`. Either way the day itself is still stored and still
counted in `totals` — it is real data; it is only barred from the per-day rates.

## `brokkr` body

**Ten sections under `metrics`** — `config`, `features`, `sessions`, `context_fill`, `mode_split`,
`spine`, `models`, `tokens`, `review`, `errors` — pinned as a set by the lockstep test, so a leaf
cannot be added, removed, renamed or reclassified without the build saying so.

Two producers feed them: a configuration view read at send time (`BrokkrConfigView`) supplies the
`config` and `features` sections, and brokkr's completed-day rollup (`BrokkrDayRollup`) supplies
every other section. Both types are declared in `packages/telemetry/src/bodies/brokkr.ts`, which is
where this repository fixes the hand-over shape; the fold that fills them lives in the brokkr
product's own repository, not in this one. Because the rollup is already a completed-day fold, no
delta normalisation is applied to this body.

| Leaf | Class | Temporal | Producer |
|---|---|---|---|
| `config.backend` | `enum` | gauge | config view — `local` \| `server` |
| `config.harness_type` | `enum` | gauge | config view — `claude` \| `codex` \| `other` |
| `config.wizard_completed` | `bool` | gauge | config view |
| `config.team_size` | `count` | gauge | config view |
| `config.playbooks_active` | `count` | gauge | config view |
| `config.review_mode` | `enum` | gauge | config view — `cross-model` \| `ephemeral` |
| `features.terminal` | `bool` | gauge | config view |
| `features.edges` | `bool` | gauge | config view |
| `sessions.count` | `count` | delta | rollup `sessions.count` |
| `sessions.minutes` | `count` | delta | rollup `sessions.minutes` |
| `sessions.failed` | `count` | delta | rollup `sessions.failed` |
| `context_fill.peak_histogram[]` | `bucket` | delta | rollup `fill.histogram` — **exactly ten** deciles, `[0-10) … [90-100]` |
| `context_fill.avg_mean` | `ratio`, **nullable** | delta | rollup `fill.avg_sum / fill.bearing`; `null` when the day bore no sessions |
| `mode_split.normal` | `count` | delta | rollup `mode_split.normal` |
| `mode_split.spine` | `count` | delta | rollup `mode_split.spine` |
| `spine.joints` | `count` | delta | rollup `spine.joints` |
| `spine.tokens_before` | `count` | delta | rollup `spine.tokens_before` |
| `spine.tokens_after` | `count` | delta | rollup `spine.tokens_after` |
| `spine.estimated` | `bool` | gauge | rollup `spine.estimated` |
| `models[].name` | `enum` | delta | rollup `models`, folded through the closed model-id allowlist (`normalizeModelId`); at most 16 entries |
| `models[].sessions` | `count` | delta | rollup `models` |
| `tokens.{input,cache_read,cache_creation,output}` | `count` | delta | rollup `tokens.*` |
| `review.runs` | `count` | delta | rollup `review.runs` |
| `errors.classes.session_failed` | `count` | delta | rollup `errors.session_failed` |

`context_fill.avg_mean` is why `ratio` and `nullable` are load-bearing classes and not padding: a
day with no bearing sessions has no mean, and `0` would be a lie about it.

`errors.classes` is a **closed key taxonomy with no required members**, so `{}` is a valid classes
object and an absent class reads as zero. A consumer must read `session_failed` as `?? 0` rather
than assume it. The taxonomy grows only by a schema-version bump — never by free keys.

`models[].name` is drawn from a closed allowlist of publicly published model ids plus `other`. The
allowlist ships as `packages/telemetry/src/model-id-allowlist.ts` and is held equal to the schema's
enum by test, so its identity-leak capacity is zero by construction.

The brokkr builder also reconciles the cross-field invariants the collector enforces —
`mode_split` partitions `sessions.count` exactly; `sessions.failed`, the histogram, the model
sessions and the error classes each sum to at most it — *at the producer*, because a body that
breaches one is not slightly off: it is a day dropped on ingest.

## `saga` body

| Leaf | Class | Temporal | Producer |
|---|---|---|---|
| `collect.runs` | `count` | delta | `collect_runs_total` |
| `collect.errors` | `count` | delta | `collect_errors_total` |
| `refusals` | `count` | delta | `refusals_total` |
| `mcp.tool_calls` | `count` | delta | `mcp_tool_calls_total` |
| `mcp.refusals` | `count` | delta | `mcp_refusals_total` |
| `advisories.fired` | `count` | delta | `advisories_fired_total` |
| `advisories.by_severity.{info,warn}` | `count` | delta | `advisories_fired_{info,warn}_total`, bumped per severity at the advisor's fire site |
| `connections.by_engine.{postgres,mysql,sqlite}` | `count` | gauge | the connections registry — one count per `engine` family |
| `connections.total` | `count` | gauge | the connections registry — its length |
| `probe.outcomes.{ok,auth_failed,unreachable,timeout,other}` | `count` | delta | `probe_{ok,auth_failed,unreachable,timeout,other}_total`, bumped at the monitor's probe site |
| `uptime_bucket` | `bucket` | gauge | `uptimeBucket()` |

**`advisories.by_severity` carries `{info, warn}` and NOT `critical`.** The advisor's severity type
is `info | warn` in both its store and its UI types, and no rule emits anything else, so a
`critical` key would be a leaf with no producer — permanently zero, which rule 4 forbids. The
two-key wire shape is pinned by test here (`packages/telemetry/src/bodies/bodies.test.ts`) so it
cannot widen by accident; a severity added upstream is a new leaf in a new schema version, not a
quiet third key.

**Probe-outcome classification is deliberately coarse, and derived from the bounded engine error
CODE only — never an error message.** `MISSING_CREDENTIAL` maps to `auth_failed` (nothing left
the host, but that is the class an operator would act on); `TLS_FAILED` maps to `other`, not
`unreachable`, because TCP did connect and "unreachable" would be false.

`connections.by_engine` is a count per engine family rather than a set of `engines_used`
booleans — strictly more informative and no less safe, and read off the registry rather than
requiring its own instrumentation. Engine family is a closed set; an unrecognised engine is **not**
emitted per family, though it still contributes to `connections.total`, which is why the schema
requires `sum(by_engine) <= total` rather than equality.

**Database size buckets are NOT in this list.** No producer exists, and adding one means reading
per-database size — a step toward per-database granularity that buys little. If it is wanted later
it needs its own privacy review and a new schema version.

## `skuld` body

| Leaf | Class | Temporal | Producer |
|---|---|---|---|
| `jobs.created_by_type.{script,ai,report,agent_send,distill}` | `count` | delta | `jobs_created_by_type.*` (note the `agent-send` → `agent_send` key normalisation, done once, in the body builder) |
| `runs.total` | `count` | delta | `runs_total` |
| `runs.succeeded` | `count` | delta | `runs_succeeded` |
| `runs.failed` | `count` | delta | `runs_failed` |
| `runs.chain_rejections` | `count` | delta | `chain_rejections` |
| `events.runs_enqueued` | `count` | delta | `event_runs_enqueued`, an event fire that enqueued a run |
| `events.asks_delivered` | `count` | delta | `event_asks_delivered` |
| `events.rate_limit_deferred` | `count` | delta | `rate_limit_merged`, a fire deferred until the oldest in-window fire ages out |
| `events.route_errors` | `count` | delta | `event_route_errors`, a rule matcher/resolver threw |
| `gate.rejections` | `count` | delta | `gate_rejections`, the gate's refuse path |
| `gate.approvals` | `count` | delta | `gate_approvals`, the gate's **admit** path |
| `sandbox.pool_exhausted` | `count` | delta | `sandbox_pool_exhausted` |
| `sandbox.uid_vends` | `count` | delta | `sandbox_uid_vends`, at the uid **pool boundary** |
| `detection_state` | `enum` | gauge | the product's local detection gauge, folded to the closed enum `unknown` \| `not_detected` \| `detected` by `toDetectionState()` |
| `uptime_bucket` | `bucket` | gauge | `uptimeBucket()` |

`detection_state` is emitted as a closed enum and never as the raw integer the local gauge holds:
an integer is an open value space, and "0 or 1 today" is not a fence — the next state added upstream
would ship as an unlabelled number the collector could not interpret. The "never probed" state is
real and distinct from "probed, nothing found", and the enum keeps them apart.

### Leaves that are deliberately absent

**There is no `events.deferrals`.** The event trigger arm validates and **runs**; it does not
validate and defer, so there is no general deferral path and nothing to count. Rule 4 forbids a leaf
with no producer, and pointing a name like that at a neighbouring counter instead would silently
redefine what a frozen field means. The one real deferral signal — a fire held until the oldest
in-window fire ages out — has its own honestly-named leaf, `events.rate_limit_deferred`, which says
exactly what it counts. Event-deferral telemetry of any other kind is a **new leaf in a new schema
version**, and that cost is the correct one.

Three counters the product does maintain are deliberately **not** on the wire:

- **`event_arm_refused`** — its in-memory dedup means a restart re-counts a still-refused job, so
  its delta systematically over-reports. A counter with a known, uncorrectable bias is worse than
  no counter, and `gate.rejections` covers the same ground with better fidelity.
- **`coalesce_suppressed`** and **`events_ignored_replay`** — real and privacy-safe, but they
  measure the product's own window tuning rather than how the product is used. Not worth a
  permanent slot in someone else's payload.

### Two counters that are easy to misread

- **`gate.approvals` counts gate *admissions*, not approvals granted.** It is the symmetric
  partner of `gate.rejections`; together they are the gate's throughput. A recurring job that was
  approved once bumps this on every run.
- **`sandbox.uid_vends` is counted at the uid pool boundary**, not at a single call site — the
  pool has more than one consumer, and per-caller counting under-reports.

### The scheduling identity is not the telemetry identity

**skuld's `meta.instance_id` is NOT the telemetry identity and must not be touched.** It seeds
scheduling jitter; replacing it silently changes when jobs run. Telemetry mints a *separate*
`telemetry_secret` + derived `telemetry_instance_id` alongside it.

The same applies to saga's `meta.instance_id`: it is a bare `crypto.randomUUID()` with no preimage
secret, so it cannot satisfy the collector's derived-identity check. Mint a separate telemetry
identity; leave `meta.instance_id` in its existing role.

## Adding or changing a field

`bun run check:manifest` validates that every leaf declares a value class and a temporal class, that
strings are closed enums or bounded version/bucket grammars, that no object accepts open-ended keys,
that every numeric delta leaf declares `minimum: 0`, and that no leaf is classed `cumulative`. It
runs in CI, and it is a **floor, not a ceiling**.

**It cannot tell a privacy-safe count from a privacy-hostile one.** You can add
`metrics.database_oid: integer` or `metrics.probe_error: string`, update the schema, the runtime
validator, the manifest and the emitter together, and every mechanical check still passes. So do
not describe this check — in a README, a pull request, a release note or product copy — as
enforcing privacy. It enforces that the shape stays declarable and declared.

What closes the gap is a person. **Any pull request that adds a leaf, reclassifies one, or widens an
enum must carry a privacy review by a named reviewer, in the pull request itself**, arguing what the
new value can reveal about an installation and why that is acceptable. Say who reviewed it. A field
that cannot be justified that way does not ship, and a field that needs a wider value space than the
classes above allow is a new schema version rather than a widening of this one.

## What this payload is, honestly

It is **pseudonymous, not anonymous.** A stable `instance_id` joined across days to product
version, OS/arch, engine mix and job mix is a longitudinal record, and a rare combination can
single out a small installation. Never describe it as anonymous in UI copy, README text, or the
privacy notice.
