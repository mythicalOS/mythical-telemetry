# The collector

The service that ingests product heartbeats. **Deployed, never published** — it is a private
workspace package, and the repository's release workflow publishes only the client package.

Run your own or don't. Nothing in any product requires this service to exist.

## What it stores, and what it cannot

One JSON document per installation, per product, per UTC day. The document is whatever the
canonical schema declares — counts, buckets, booleans, closed enums and version strings. See
[`../docs/FIELDS.md`](../docs/FIELDS.md) for the complete list.

| Table | Columns |
|---|---|
| `instances` | `instance_id`, `product`, `first_seen_day`, `last_seen_day`, `first_report_day` — PK `(instance_id, product)` |
| `heartbeats` | `instance_id`, `product`, `day`, `schema_version`, `payload`, `received_day` — PK `(instance_id, product, day)` |
| `admissions` | `day`, `admitted` — the append-only admission ledger; counts only, no identities |

Three privacy properties are **schema-level**, not promises in a code comment:

- **No address column anywhere.** Throttling state is in-memory and process-lifetime only; it is
  never written to the database, and no request address is ever logged.
- **No key material at rest.** Authorization is recomputed per request from the presented secret.
  Nothing derived from a secret is stored.
- **`received_day` is day granularity.** An exact receive timestamp would fingerprint an
  installation's check-in cadence. It is also what the retention clock runs on — see
  [Retention](#retention).

**Both tables expire.** Neither a heartbeat nor an identity row is held indefinitely, including for
an installation that stopped reporting years ago. The only thing that outlives an installation is
the `admissions` ledger, which holds per-day counts and no identity.

`schema_version` records which heartbeat schema the stored `payload` is. There is exactly one, so
today it only ever holds `1`. The column stays because it is the durable evidence a future second
schema would need — a store whose rows cannot say what shape they are is a store that has to guess.
Nothing is normalized on the way in or at rest: a document is stored exactly as the validator
accepted it.

### It is pseudonymous, not anonymous

The installation id is stable across days, so the daily records form a longitudinal series, and a
rare combination of version, platform and metric mix can single out a small installation. Say so;
do not call this data anonymous anywhere.

## Authorization

There is **no shared or baked key**, and no route accepts one. Every per-installation route —
read, write and delete alike — proves possession of that installation's own secret:

```
instance_id = uuidv4Format( sha256(instance_secret)[0..16] )
```

The service recomputes that derivation from the presented header and constant-time compares it to
the claimed id. No registration, no stored key material, no first-writer claim race. Forging
access is a sha256 preimage.

The derivation hashes the **UTF-8 bytes of the 64-character hex string**, not the 32 bytes that
string decodes to. That is not a detail: change it and every existing installation silently mints a
new identity, orphaning its own history and its own delete capability.

**The installation id is not a read capability.** Knowing an id grants nothing. Reads used to be
open to anyone holding the id, and the unauthenticated per-installation page that went with them
(`/i/<uuid>`) has been **removed**, not merely made authenticated.

| Header | Meaning |
|---|---|
| `X-Mythical-Instance-Secret` | the installation secret — canonical name |
| `X-Mythical-Write-Key` | the same credential under its historical name; still accepted so a client built against the older name keeps working. When both are present the canonical one wins. |

## Routes

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/v1/ingest` | POST | instance secret | 32 KB body cap; day window (≤ today UTC, ≥ today−30); upsert per (instance, product, day), last write wins; `202 {ok:true}` |
| `/v1/instances/<uuid>/stats?product=<name>` | GET | instance secret | that installation's own days, totals and per-day rates; optional `&days=N` (1 – the configured retention, 90 by default) |
| `/v1/instances/<uuid>` | DELETE | instance secret | purges the identity across **every** product; idempotent `204` |

Every authenticated route is per-source throttled. Anyone can mint a valid (secret, id) pair, so an
authenticated request is not a scarce one — an unthrottled read or no-op purge would reach the
database for the price of a hash. Reads and deletes draw on a **separate** budget from ingest, so a
read flood cannot stop heartbeat delivery for installations behind the same address, and the
throttle sits **after** the identity proof, so a 403 never depends on someone else's traffic.

The two public routes (`/` and `/v1/stats`) serve a **cached** aggregate, recomputed at most once a
minute. The figures move at day granularity, so recomputing per request is pure waste — and on a
public route that waste is an amplification lever.
| `/v1/stats` | GET | none | per-product aggregate, small-cell suppressed |
| `/` | GET | none | the aggregate give-back page |
| `/v1/schema` | GET | none | the published JSON Schema, when the operator wired one; otherwise absent |
| `/metrics` | GET | operator key | counters and gauges; **absent entirely** unless `MYTHICAL_TELEMETRY_OPS_KEY` is set |
| `/healthz` | GET | none | `200 {ok:true}` |

Wire answers are deliberately coarse. An absent secret and a wrong secret are the same answer; a
nonexistent installation and one you cannot authenticate for are the same answer. Operators get the
fine-grained breakdown from `/metrics`, callers do not.

`/metrics` is gated because live rejection counts are a feedback channel for tuning an attack, and
the population figures are commercially sensitive. The operator key is **not** a write or read
credential: it cannot ingest, and it cannot read any installation's data.

## The first heartbeat from an installation is not a one-day delta

**Read this before deriving any per-day figure from this data, including in a collector of your
own.** It is invisible until the numbers look wrong months later.

The client emits per-day deltas by diffing each counter against a stored prior snapshot. A counter
with **no** prior snapshot emits its **current lifetime value**. On a fresh installation that is
roughly a day's activity. On an installation that has been running for months before telemetry was
switched on, it is **months of accumulation arriving as a single day's row**.

This is not an edge case that might occur — **it happens once for every installation**, at
activation, because no installation has a prior snapshot the first time. It recurs for any leaf
added later: that leaf's first heartbeat on an existing installation carries its whole history.

The emitter deliberately does not paper over this by sending `0` for an unseen counter — that would
discard real activity and throw away a genuinely useful total on the one occasion it is available.
So the rule belongs to the collector:

> **Exclude each `(instance_id, product)`'s first observed day from every per-day rate statistic.**
> Store the row — it is real data and its total is meaningful — but do not average it in, and do not
> present it as a representative day.

A collector that skips this reports a large one-time spike at every installation's activation and
then **overstates per-day rates permanently**, because the inflated row never ages out of a lifetime
average.

How this collector implements it:

- `instances.first_report_day` records the `day` of that identity's **first** heartbeat, written
  once on insert and never moved — not derived from whatever happens to be in the query window,
  which would break the moment retention pruned the real first day.
- The authenticated read returns `instance.first_report_day`, and a separate `rates` object whose
  `per_day` figures are computed over the window **minus** that day. `rates.days_counted` and
  `rates.excluded_day` say exactly what was used.
- `totals` still covers the whole window, first-report row included. It is a lifetime total, and
  that row belongs in it.
- **`totals.x / days.length` is the bug.** The `rates` object exists so the correct figure is the
  easy one to reach.
- When the window holds only the first-report day, `rates.per_day` is `null` rather than zeros —
  "nothing representative to average" and "averaged to zero" are different claims.
- The exclusion matches on the **stored row's** day, not on the `day` inside the document. Which
  day a row is for is a fact about the store; a corrupt historical payload must not be able to
  smuggle the first-report row back into the rate window.
- Any accumulated figure that overflows to a value JavaScript cannot represent is emitted as an
  explicit `null` rather than as `Infinity` — which `JSON.stringify` renders as a bare `null`
  meaning something else entirely. Rates are computed as a running mean for the same reason.
- Gauges get no rate (a mean of snapshots is not a rate of anything), and neither does the model
  breakdown.
- Upgrading an existing volume derives `first_report_day` from the earliest surviving heartbeat.
  Where no heartbeat survives it stays `NULL`, meaning *unknown* — it is never filled in from a
  later heartbeat, which would stamp an ordinary day as the first and exclude it from every rate
  from then on.
- **It is lost when the identity row expires**, and that is deliberate: keeping a stable id for
  years after everything it described was deleted, purely to annotate rates, would re-create the
  indefinite record retention exists to end. The cost mostly cancels — the row is only dropped once
  every heartbeat of that identity has gone too, so no *surviving* row loses its annotation. An
  installation that returns after that long is treated as new, which for a product that normalises
  cumulative counters is right rather than merely convenient: its first day back really is another
  whole-gap accumulation. For a product already emitting completed-day deltas it costs one
  representative day, and `rates.excluded_day` says so out loud.

## Statistics, and why there is no family total

Statistics are **per product**. Each product derives its own installation identity, and nothing
joins them, so a family-wide "N installations" figure cannot be computed without double-counting
anyone running two products. The aggregate response carries `family_total_installs: null`
explicitly rather than omitting it — a gap invites someone to close it by summing the column.

The public aggregate applies a **small-cell floor** (`MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL`,
default 5). A product below it is withheld entirely; an individual figure below it renders as `—`.
"Three installations, all on Linux" is a statement about three identifiable installations.

**The number of withheld products is not published either.** With a closed product set, "two rows
shown, one withheld" names the withheld product and states that it is under the floor — the
suppression would announce exactly the fact it exists to hide.

## One shape, no negotiation

The collector accepts exactly one document shape: the schema published by the client package. There
is no second version, no accept-both mode, and no normalization anywhere in the service — a payload
is handed to the one injected validator and is either stored as it arrived or refused.

A document that is not that shape — including the retired pre-collapse shape, whose body sections
sat at the top level rather than under `metrics` — is refused like any other invalid payload and
counted as `ingest_rejected_schema_invalid`. Note that the retired shape declared the SAME
`schema_version: 1` as the current one, so the version discriminator does not distinguish them and
nothing here may be built as though it did: what refuses it is the shape, `metrics` being required
and every top-level section being undeclared under `additionalProperties: false`. That rejection is
pinned by test rather than left to inspection.

---

## This is public, unauthenticated ingest — operate it accordingly

Read this section before deploying. It is the honest description of what the service can and
cannot defend, and several of the controls below are only as good as the configuration you give
them.

**What the identity scheme defends:** impersonation. One installation cannot write, read or delete
another's data, and there is no credential to leak.

**What it does not defend:** nothing stops anyone minting unlimited fresh secrets and ids and
submitting perfectly schema-valid junk. Every id is self-asserted, and so is `product.version`.
That is a capacity and data-poisoning problem, and no amount of payload validation addresses it.

### Every statistic derived from this data is untrusted

Treat ingested counts as an **upper bound on activity, never a measurement**. The aggregate
response says so in-band (`data_quality: "untrusted-public-ingest"`) and the page says so in prose.
Do not put these numbers in front of anyone without that caveat, and do not use them where a
number has to be defensible.

### Admission control, and the fact that it is itself a lever

Three budgets bound how much a flood can consume:

| Control | Default | What it bounds |
|---|---|---|
| `MYTHICAL_TELEMETRY_MAX_INSTANCES` | 100000 | the absolute ceiling on stored identities |
| `MYTHICAL_TELEMETRY_NEW_INSTANCES_PER_DAY` | 5000 | how fast that ceiling can be approached, globally |
| `MYTHICAL_TELEMETRY_NEW_INSTANCE_PER_SOURCE_PER_HOUR` | 20 | how fast one source can mint identities |

**The ceiling is itself a denial-of-service lever: exhaust it and legitimate first-time
installations get `429`.** The daily budget does not remove that — it converts *one flood
permanently exhausts the ceiling* into *one flood exhausts one day's budget*, and it restores
itself at the UTC day boundary.

Two properties make those budgets real rather than nominal:

- **The check and the write are one `IMMEDIATE` transaction.** Split apart, two replicas sharing a
  store could each observe capacity available and each insert, walking straight past both budgets.
- **The daily count comes from an append-only `admissions` ledger, not from counting
  `instances.first_seen_day`.** That count falls again when an installation exercises its right to
  delete, so mint → delete → repeat would have bought unlimited admissions. The ledger is only ever
  incremented.

Both are therefore shared by every replica reading the same database, and both survive a restart.

The per-source mint budget is the anomaly isolation: minting is throttled separately from, and far
more tightly than, ordinary traffic, and an installation that is already reporting is **never**
subject to it. A mint flood therefore cannot degrade service for anyone already on the system.

Monitor `ingest_rejected_instance_capacity` and `ingest_rejected_daily_admission_budget`. Either
one moving off zero means real installations are being turned away, and neither is self-healing at
the ceiling.

### The trusted-proxy model — decide this deliberately

`X-Forwarded-For` is **never trusted by default**. `MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS` defaults
to `0`, and at `0` the throttling key is the peer address of the TCP connection: the only value in
a request an attacker cannot choose.

Both mistakes here are real, and neither is safe to guess:

- **Trust the header when nothing sets it** and every attacker picks their own bucket. The
  per-source limiter becomes decoration.
- **Ignore it behind a load balancer** and every request appears to come from the balancer. The
  limiter then throttles your entire population as one source — a self-inflicted outage the first
  time traffic is normal.

So state **two** things, and both are required together:

| Variable | Meaning |
|---|---|
| `MYTHICAL_TELEMETRY_TRUSTED_PROXIES` | **which peers** are your proxies — a comma-separated list of addresses or CIDRs (IPv4 and IPv6), e.g. `10.0.0.0/8,2001:db8:1::/48`. List **every** proxy in the chain, not only the one that connects to the collector |
| `MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS` | **how many** of them are in the chain |

A hop count alone is not enough, and the collector refuses to start with one: it would honour the
header from whoever connected, so anyone with a direct route to the listener — a sibling container,
a misconfigured security group, a leaked internal port — could hand themselves any bucket they
liked. The header is read **only when the peer is on the list**.

The declared hops are **verified, not assumed**. With two or more hops, the entries to the right of
the client position were appended by your own infrastructure, so each of them must itself be on the
list. That is why the list has to name every proxy: checking only the peer would let anyone who can
reach an **inner** proxy directly — skipping an outer one — write those entries himself and choose,
and freely rotate, his own throttle bucket. If a hop is not on the list the request did not arrive
the way you described it, and the key falls back to the peer address, exactly as it does for an
untrusted peer or a chain shorter than the declared count. A chain that silently collapses to one
bucket is the symptom of a hop count that names more proxies than the list does; `GET /metrics`
reports `throttle.rate_limit_keys` and `throttle.trusted_proxies_configured` so you can see it.

With `N` hops, the rightmost `N` entries of the chain were appended by infrastructure you control,
and the client address is taken from that position. Anything an attacker prepends sits to the left
of it and is ignored. Every failure — an untrusted peer, a chain shorter than declared, a missing
header, an implausible value — falls back to the peer address, never to a header value.

An IPv4-mapped IPv6 peer (`::ffff:10.0.0.1`, which is what a dual-stack listener commonly reports)
matches an IPv4 CIDR, so you do not have to write your ranges twice. Throttle buckets are keyed by
an address's canonical bytes, so one source cannot spell itself two ways, and a value that does not
parse as an address gets no bucket at all.

The address parser is deliberately strict, because in an allowlist a false positive means the
header is believed from someone who is not a proxy. It **rejects** — rather than normalizes —
leading-zero IPv4 octets (`010.0.0.1` is decimal here and octal to some resolvers, so the same text
names two hosts), a `::` that compresses nothing, an embedded IPv4 anywhere but the final group, and
a malformed or repeated zone id. Write your ranges in canonical form. A malformed entry in the list
fails at boot with the offending text rather than being skipped — a silently dropped proxy means
the header is ignored and your whole population shares one bucket, which looks like a capacity
problem rather than a configuration one.

**Set the hop count to the number of proxies that actually rewrite the header.** Setting it too
high is the dangerous direction: it selects a position an attacker can write.

### Monitoring hooks

`GET /metrics` (operator key) returns:

- every rejection counter, **including the ones that have never fired**, as zeros — a missing key
  and a zero are indistinguishable otherwise, and a rejection class that silently never registers
  is the failure this exists to prevent;
- aggregate serves versus aggregate recomputes, so the cache's effectiveness is visible;
- store gauges (identities total, identities admitted today) against their configured budgets;
- both retention controls (`retention_days`, `max_rows_per_instance`) and `last_prune` — what the
  most recent prune deleted and the window it used, so the clock's operation is observable rather
  than assumed. `null` until one has run in this process;
- the boot-time migration report;
- throttle map sizes.

Nothing in that response contains an installation id or an address.

Worth alerting on: `ingest_rejected_instance_capacity` and `ingest_rejected_daily_admission_budget`
above zero; a sustained rise in `ingest_accepted_new_instance`; `internal_error` above zero;
`ingest_rejected_validator_error` above zero (the injected validator is misbehaving).

### Residuals we are not claiming to have solved

- **A distributed flood from more sources than the throttle map holds** degrades the per-source
  limiter: idle keys are swept, then the least-recently-seen are evicted. A WAF or edge rate-limit
  tier is the mitigation for that shape, not this process.
- **Callers who share a source address share its budget, and that is not fully fixable here.**
  Identities are freely mintable, so an attacker behind the same NAT — or the same trusted proxy
  client address — can spend the read/delete budget that legitimate installations at that address
  would have used. Splitting reads and deletes off the ingest budget keeps heartbeat *delivery*
  out of the blast radius, which is the part that loses data; it does not isolate callers from one
  another. Doing that properly needs a trustworthy upstream client identity or an edge quota, and
  this service has neither. If your population is concentrated behind few addresses, enforce
  per-client quotas at the edge.
- **Poisoned data already ingested** is not detectable after the fact. There is no provenance
  beyond the derived id, which the poisoner also controls. Deletion of a suspected range is a
  manual operator action against the database.
- **`product.version` is self-asserted.** A modified client can claim any allowlisted version. A
  version allowlist here would be an operational control, never a consent or compliance guarantee.
- **Replicas share the durable budgets but not the per-source throttle.** The ceiling and the daily
  ledger live in the database and are enforced transactionally across replicas; the per-source
  token buckets are per-process memory. Per-source limits are therefore per-replica — size them
  accordingly, or enforce them at the edge.

### Reverse proxy and TLS (required)

The instance secret travels in a request header, so **TLS fronting is a transport requirement, not
a suggestion**. Publish the service loopback-only and terminate TLS at your reverse proxy.

### The no-address-logs deployment expectation

The service never logs or stores request addresses — and the deployment is expected to match:
**disable access logging, or strip client addresses, at the fronting layer** for these routes. An
operator who retains address access logs next to the heartbeat store has recreated exactly the
linkage this design removes.

---

## Deployment

Build from the **repository root** (the collector needs its sibling client package — see the
Dockerfile):

```sh
docker build -f collector/Dockerfile -t telemetry-collector .
```

```yaml
services:
  collector:
    image: telemetry-collector
    restart: unless-stopped
    ports:
      - "127.0.0.1:7910:7910"   # loopback publish; expose via reverse proxy only
    volumes:
      - telemetry-data:/data
    environment:
      MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS: "1"          # YOUR proxy count
      MYTHICAL_TELEMETRY_TRUSTED_PROXIES: "10.0.0.0/8"     # YOUR proxy addresses
      MYTHICAL_TELEMETRY_RATE_LIMIT_PER_MIN: "60"

volumes:
  telemetry-data:
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `MYTHICAL_TELEMETRY_DB_PATH` | `/data/telemetry.db` | bun:sqlite database (WAL) |
| `MYTHICAL_TELEMETRY_PORT` | `7910` | bind port |
| `MYTHICAL_TELEMETRY_MAX_BODY` | `32768` | ingest body cap in bytes → `413` |
| `MYTHICAL_TELEMETRY_RATE_LIMIT_PER_MIN` | `60` | per-source token bucket across ingest, reads and deletes → `429` (in-memory only) |
| `MYTHICAL_TELEMETRY_NEW_INSTANCE_PER_SOURCE_PER_HOUR` | `20` | per-source budget for FRESH identities |
| `MYTHICAL_TELEMETRY_NEW_INSTANCES_PER_DAY` | `5000` | global daily budget for fresh identities (0 disables) |
| `MYTHICAL_TELEMETRY_MAX_INSTANCES` | `100000` | absolute ceiling on stored identities |
| `MYTHICAL_TELEMETRY_RETENTION_DAYS` | `90` | how many days after **arrival** a record is kept, for heartbeats and identity rows alike; pruned at start-up and daily. **Must be ≥ 1** — the service refuses to start at 0, which would delete every heartbeat on the next prune |
| `MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS` | `0` | proxies in the chain; 0 = never trust `X-Forwarded-For` |
| `MYTHICAL_TELEMETRY_TRUSTED_PROXIES` | *(unset)* | which peers those are: comma-separated addresses/CIDRs. **Required** when hops > 0; the service refuses to start otherwise |
| `MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL` | `5` | small-cell floor for the public aggregate |
| *(not configurable)* | 60s | how long a computed public aggregate is reused before recomputing |
| `MYTHICAL_TELEMETRY_OPS_KEY` | *(unset)* | gates `/metrics`; unset means the route does not exist |

## Upgrading an existing volume

The store gained a product dimension. `CREATE TABLE IF NOT EXISTS` cannot express that, so the
collector ships a **transactional rebuild** that runs at boot:

- every existing row is carried over and backfilled as product `brokkr`;
- the admission ledger is created and seeded from the identities already stored, so upgrading does
  not hand today's budget back in full;
- `instances.first_report_day` is added and derived from the earliest surviving heartbeat (see
  above);
- **no stored document is ever rewritten.** There is one heartbeat schema, so there is no at-rest
  conversion to perform; the rebuild moves rows between table definitions and leaves every payload
  byte-identical;
- the whole thing is one `IMMEDIATE` transaction: it lands completely or not at all, and a second
  process booting on the same file waits rather than racing;
- the shape is detected from the tables' actual **primary keys**, not from a version marker and not
  merely from a column's presence, so re-running is a no-op while a naive `ALTER TABLE ... ADD
  COLUMN product` hand-upgrade — which leaves the legacy key in place — is still completed rather
  than mistaken for done. Any product values such an upgrade had already set are kept;
- nothing is dropped. A payload that will not parse is carried over verbatim.

**Nothing needs doing for the retention clock.** The index it uses (`received_day`) is created by
the same boot-time DDL, which is idempotent — an index is not a table shape, so there is no version
bump and no rebuild. Expect the **first prune to delete a great deal at once**, though: on a volume
that predates the clock, everything already past the window goes on that first pass. That is the
control working. Take the backup first, as above.

The report is logged at boot and served on `/metrics`. **Back up the volume first anyway** — this
rewrites tables in place, and no test is a substitute for a copy of the file.

## Retention

**Retention is an age, and it has a clock.** A heartbeat row is deleted
`MYTHICAL_TELEMETRY_RETENTION_DAYS` days after it **arrives**, whether or not that installation is
still reporting. The prune runs at start-up and every 24 hours. State whatever you configure in
your privacy notice; it is a published property, not an implementation detail.

Two things expire, on the same clock:

| Row | Deleted when |
|---|---|
| a `heartbeats` row | its `received_day` is older than the window |
| an `instances` row | its last arrival is older than the window **and** no heartbeat of that identity is left |

The `instances` row expires because it is pseudonymous personal data in its own right — a stable id
plus the days it was active — and keeping it after everything it described was deleted would leave
an indefinite record of who reported and when. The `NOT EXISTS` half of the condition is what makes
that safe: the identity row is the only way to read the heartbeats keyed to it, so it always
outlives the last of them, and no heartbeat is ever orphaned.

**The cutoff is on arrival (`received_day`), not on the day the data describes (`day`).** Retention
is a promise about how long *we* hold a record, so its clock starts when the record reaches us.
Keying on `day` would hand two installations reporting identical data different retention purely
because one delivered late — a heartbeat backfilled for an older day would arrive with part of its
window already spent, or none of it left. `day` is not ignored: ingest bounds it to
`today−30 … today`, so keying on arrival still bounds the **age of the data** at retention + 30
days, and a future `day` is refused at ingest rather than surviving in the store.

**An impossible arrival day is corrected, not believed and not destroyed.** A record cannot arrive
after today, and believing one that claims to would let it outlive the window twice over — the
cutoff has to climb past the stamp before it even starts counting, so a stamp a year out would buy a
year *plus* the window. Deleting it instead is the opposite error: one day of clock skew between two
replicas would destroy a heartbeat that did nothing wrong. So the prune **clamps** anything stamped
beyond tomorrow back to today, the earliest arrival still defensible, and it expires one ordinary
window later. Tomorrow itself is left alone — that is a host a few minutes fast, and it costs a day.

Clamp and cutoff together are **total over stored values**, including ones that are not dates at
all. Text comparison sorts every value somewhere, and each place is covered: above tomorrow
(`not-a-day`) the clamp corrects it; below the cutoff (an empty string) it is deleted at once;
between the two (`2026-07-1X`) the rising cutoff reaches it at the same prune as its well-formed
neighbours. No stored arrival day escapes the clock. (Only `received_day` and `last_seen_day` are
ever rewritten; no stored payload is touched, here or anywhere in this service.)

**The cutoff never goes backwards.** The highest day any prune has acted on is recorded durably, and
a system clock reading *below* it is not believed — otherwise a clock set back would silently
suspend the promise, leaving rows past the window kept with nothing to show that anything was wrong.
The trade is deliberate and it is not free: a clock jumped *forward* deletes early, and the
watermark makes that damage persist until the real date catches up. Telling "the clock jumped a
year" from "the service was down for a year" needs a trusted time source this process does not have,
so between quietly keeping data too long and visibly deleting it too early, this service takes the
second. Run a clock you trust, and watch `store.last_prune` on `/metrics`: `effective_day` differing
from today is the collector saying its clock went backwards.

**What the clock does not promise to the second.** The prune is daily, so a row can outlive its
window by up to a day before the next run reaches it, and a collector that is not running cannot
prune — the start-up prune closes that gap, and it runs before the first request is served. A prune
failure at start-up is fatal on purpose: a collector that cannot delete should not be accepting data
it has promised to delete. A failure *while running* is survivable once — a lock, a transient IO
error — but it is logged, and after **two consecutive failures** the process **exits non-zero**
rather than quietly becoming a store with no retention. Failures are counted rather than timed on
purpose: a deadline in wall-clock milliseconds would be measured by the same clock the retention
code already cannot fully trust. Watch for that line, and for `store.last_prune.cutoff_day` on
`/metrics` failing to advance.

**What deletion does and does not physically do.** The store runs with `secure_delete`, so a pruned
payload is overwritten in the database's freed pages rather than left legible there, and **every**
prune checkpoints and **truncates** the write-ahead log, which is where those changes land first and
where `secure_delete` has no reach. Both are best effort: a checkpoint blocked by an active reader
reports busy rather than failing the prune. It runs on every prune — not only one that deleted
something — precisely so that a busy moment is retried the next day instead of waiting for the next
deletion, which could be months away.

Neither is **media-level erasure**, and this is not claimed as such. Truncating a file does not
scrub the blocks it occupied, a copy-on-write filesystem or SSD may retain them, and — the part that
matters most in practice — **a backup or replica taken before a prune still holds the rows and has
no deletion path of its own**. If you operate this service, your backup retention is part of your
retention promise. The code cannot reach it for you.

**Behind the clock there is a row cap, and it is not retention.**
`maxRowsPerInstance` — `retention + 31` by default, derived and not a second literal — bounds what
one `(instance, product)` can hold irrespective of dates. Its remaining job is pathology the clock
cannot reason about: an operator's bulk import, a hand-edited volume, a future widening of the
ingest window. The default deliberately allows a whole ingest window of backfill on top of the
retention window, because a cap set at the retention window itself would trim a backfilling
installation's oldest days before the clock reached them — the cap doing retention's job, which is
exactly the conflation this design ended. `GET /metrics` reports both controls and the last prune's
receipt (`store.last_prune`), so which one is doing the work is observable rather than assumed.

**The admission ledger is deliberately never pruned.** It is one small row per UTC day the service
has ever seen — a few tens of kilobytes per decade, nothing beside the heartbeat rows — and
deleting from it is the only operation that can hand back a spent budget. A clock-driven prune of
*that* table would reintroduce exactly this: jump the clock past the horizon, let the prune drop a
day, move it back, and that day's budget is fresh. Expiring heartbeats and identities cannot be
abused that way, because the ledger only ever increases — an expired identity has still spent its
day's budget for ever. Capacity against `MYTHICAL_TELEMETRY_MAX_INSTANCES` *is* returned, correctly:
that ceiling bounds what is stored, and the storage really is gone.

The ledger's day-by-day counts are therefore **the only thing that outlives an installation**, and
they contain no identity — a number of first-time admissions per day, which cannot be turned back
into who they were.

A retention of `0` is refused at startup: "store nothing" is not a supported configuration, and
silently deleting every heartbeat on the next prune would be worse than saying so.

### What this changes about the published figures

Identity rows expire, so `installs_seen` on `/` and `/v1/stats` counts installations seen **within
the retention window**, never since the beginning. The page carries the window in the column heading
and in prose, and the JSON carries `retention_days`, because an unqualified "seen" reads as all-time
and would overstate the population.

Note the asymmetry the page also states: the window is on **arrival**, so `days_reported` counts
records that describe days reaching up to a month further back than the window itself — a record may
arrive up to 30 days after the day it covers. "Installations seen in the last 90 days" is exact;
"90 days of activity" would not be.

## Deleting your data

`DELETE /v1/instances/<uuid>` with the installation's secret purges every row for that identity,
across every product. Idempotent `204`. The secret proves ownership of the id itself, so the purge
is not scoped to one product — an erasure that left rows behind under another would be erasure in
name only.

## Merge point: the canonical validator

The collector owns **no schema knowledge**. It declares `HeartbeatValidator` in
[`src/validator.ts`](src/validator.ts) and takes an implementation as a dependency; the one real
validator lives in the client package, next to the schema and the emitter, so a single lockstep
test can span all three.

At merge with the client-package branch:

1. add `"@mythicalos/telemetry": "workspace:*"` to `collector/package.json` `dependencies` — it is
   deliberately absent while the package does not exist, because declaring it breaks `bun install`;
2. check that `loadCanonicalValidator()` matches the package's actual export name.

`src/cli/server.ts` calls that loader and nothing else imports the package. A load failure is fatal
by design: a collector that fell back to accepting payloads it could not validate would be worse
than one that refuses to start.

## Development

```sh
bun install         # from the repository root
bun test            # full suite, no real network (handlers driven with Request)
bun run typecheck
bun run start       # local run (set MYTHICAL_TELEMETRY_DB_PATH=./telemetry.db)
```

Tests inject a **test double** validator (`tests/fixtures.ts`). It is not the contract and must
never be promoted into `src/`.
