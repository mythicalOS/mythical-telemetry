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
| `instances` | `instance_id`, `product`, `first_seen_day`, `last_seen_day` — PK `(instance_id, product)` |
| `heartbeats` | `instance_id`, `product`, `day`, `schema_version`, `payload`, `received_day` — PK `(instance_id, product, day)` |
| `admissions` | `day`, `admitted` — the append-only admission ledger; counts only, no identities |

Three privacy properties are **schema-level**, not promises in a code comment:

- **No address column anywhere.** Throttling state is in-memory and process-lifetime only; it is
  never written to the database, and no request address is ever logged.
- **No key material at rest.** Authorization is recomputed per request from the presented secret.
  Nothing derived from a secret is stored.
- **`received_day` is day granularity.** An exact receive timestamp would fingerprint an
  installation's check-in cadence.

`schema_version` records the version the payload arrived as **on the wire**; `payload` is always
the normalized v2 document.

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
| `X-Mythical-Write-Key` | the same credential under its historical name; still accepted so older clients keep working. When both are present the canonical one wins. |

## Routes

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/v1/ingest` | POST | instance secret | v1 and v2 accepted; 32 KB body cap; day window (≤ today UTC, ≥ today−30); upsert per (instance, product, day), last write wins; `202 {ok:true}` |
| `/v1/instances/<uuid>/stats?product=<name>` | GET | instance secret | that installation's own days and totals; optional `&days=N` (1–400) |
| `/v1/instances/<uuid>` | DELETE | instance secret | purges the identity across **every** product; idempotent `204` |
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

## Statistics, and why there is no family total

Statistics are **per product**. Each product derives its own installation identity, and nothing
joins them, so a family-wide "N installations" figure cannot be computed without double-counting
anyone running two products. The aggregate response carries `family_total_installs: null`
explicitly rather than omitting it — a gap invites someone to close it by summing the column.

The public aggregate applies a **small-cell floor** (`MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL`,
default 5). A product below it is withheld entirely; an individual figure below it renders as `—`.
"Three installations, all on Linux" is a statement about three identifiable installations.

## Compatibility window

The collector accepts **v1 and v2** payloads. v1 is normalized into the v2 shape on ingest and is
brokkr-only by construction. Set `MYTHICAL_TELEMETRY_ACCEPT_V1=0` to close the window; v1 payloads
then reject like any other invalid payload, and the `ingest_rejected_v1_window_closed` counter says
so.

> **The window's length is not yet decided** and must be published here before the client package's
> first release. Operators cannot plan an upgrade against a deadline that does not exist.

Normalization is a structural move only — sections move under `metrics`, `product.daemon_version`
becomes `product.version` — and it deliberately moves *every* non-envelope key, including ones the
schema does not declare, so an undeclared section stays rejectable. Copying a known list of
sections across would silently discard the rest and turn a rejectable payload into an acceptable
one. For the same reason every key is written with `defineProperty` rather than plain assignment:
`JSON.parse` produces a genuine own `__proto__` property, and assigning it back would invoke the
inherited setter and make the field vanish mid-move.

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
| `MYTHICAL_TELEMETRY_TRUSTED_PROXIES` | **which peers** are your proxies — a comma-separated list of addresses or CIDRs (IPv4 and IPv6), e.g. `10.0.0.0/8,2001:db8:1::/48` |
| `MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS` | **how many** of them are in the chain |

A hop count alone is not enough, and the collector refuses to start with one: it would honour the
header from whoever connected, so anyone with a direct route to the listener — a sibling container,
a misconfigured security group, a leaked internal port — could hand themselves any bucket they
liked. The header is read **only when the peer is on the list**.

With `N` hops, the rightmost `N` entries of the chain were appended by infrastructure you control,
and the client address is taken from that position. Anything an attacker prepends sits to the left
of it and is ignored. Every failure — an untrusted peer, a chain shorter than declared, a missing
header, an implausible value — falls back to the peer address, never to a header value.

An IPv4-mapped IPv6 peer (`::ffff:10.0.0.1`, which is what a dual-stack listener commonly reports)
matches an IPv4 CIDR, so you do not have to write your ranges twice. A malformed entry in the list
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
- accepted counts split by wire version, which is the number the compatibility-window decision
  actually needs;
- store gauges (identities total, identities admitted today) against their configured budgets;
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
| `MYTHICAL_TELEMETRY_RATE_LIMIT_PER_MIN` | `60` | per-source token bucket → `429` (in-memory only) |
| `MYTHICAL_TELEMETRY_NEW_INSTANCE_PER_SOURCE_PER_HOUR` | `20` | per-source budget for FRESH identities |
| `MYTHICAL_TELEMETRY_NEW_INSTANCES_PER_DAY` | `5000` | global daily budget for fresh identities (0 disables) |
| `MYTHICAL_TELEMETRY_MAX_INSTANCES` | `100000` | absolute ceiling on stored identities |
| `MYTHICAL_TELEMETRY_RETENTION_DAYS` | `400` | per-(instance, product) row cap, pruned daily |
| `MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS` | `0` | proxies in the chain; 0 = never trust `X-Forwarded-For` |
| `MYTHICAL_TELEMETRY_TRUSTED_PROXIES` | *(unset)* | which peers those are: comma-separated addresses/CIDRs. **Required** when hops > 0; the service refuses to start otherwise |
| `MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL` | `5` | small-cell floor for the public aggregate |
| `MYTHICAL_TELEMETRY_ACCEPT_V1` | `1` | accept v1 payloads (the compatibility window) |
| `MYTHICAL_TELEMETRY_OPS_KEY` | *(unset)* | gates `/metrics`; unset means the route does not exist |

## Upgrading an existing volume

The store gained a product dimension. `CREATE TABLE IF NOT EXISTS` cannot express that, so the
collector ships a **transactional rebuild** that runs at boot:

- every existing row is carried over and backfilled as product `brokkr`;
- the admission ledger is created and seeded from the identities already stored, so upgrading does
  not hand today's budget back in full;
- stored v1 payloads are normalized to v2 **at rest**, so the read path has one shape — leaving
  them would not crash, it would silently fold zeros into every historical total;
- the whole thing is one `IMMEDIATE` transaction: it lands completely or not at all, and a second
  process booting on the same file waits rather than racing;
- the shape is detected from the actual tables, not from a version marker, so re-running is a
  no-op and a hand-edited marker cannot skip a rebuild that is genuinely needed;
- nothing is dropped. A payload that will not parse is carried over verbatim and counted.

The report is logged at boot and served on `/metrics`. **Back up the volume first anyway** — this
rewrites tables in place, and no test is a substitute for a copy of the file.

## Retention

Up to `MYTHICAL_TELEMETRY_RETENTION_DAYS` daily rows per (instance, product), pruned daily. State
whatever you configure in your privacy notice; it is a published property, not an implementation
detail.

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
