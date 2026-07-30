# The collector, as a Cloudflare Worker

The same heartbeat ingest service as [`../collector`](../collector), running on Cloudflare Workers
with [D1](https://developers.cloudflare.com/d1/) instead of Bun with `bun:sqlite`. **Deployed, never
published** — a private workspace package; the repository's release workflow publishes only the
client package.

> **This is one of two collectors in this repository and they are near-copies of each other.**
> Read [`../docs/TWO-COLLECTORS.md`](../docs/TWO-COLLECTORS.md) before changing anything in
> `src/`. It says which one is production, which is reference, and what must be changed in both.

Everything the service *does* — the routes, the identity scheme, the admission budgets, the
first-report exclusion, the small-cell floor, the wire answers — is described in
[`../collector/README.md`](../collector/README.md), and none of it changed in the port. **Read that
first.** This file covers only what is different: how to deploy it, how to check it works, and the
four guarantees it does not have.

---

## What this deployment does NOT have

Four documented guarantees of the Bun collector do not survive D1. They were measured, not guessed.
None of them is a to-do item that fell off the end; each is a property of the platform.

If you publish a privacy notice for this service, **it must describe the behaviour below, not the
behaviour in `../collector/README.md`.**

### 1. Pruned payloads are no longer overwritten in freed pages — and this does not come back

The Bun store sets `PRAGMA secure_delete = ON` deliberately, so that when a heartbeat is pruned its
payload is overwritten rather than left legible in the database's freed pages.

**D1 refuses every PRAGMA except `table_info`.** Each of `secure_delete`, `journal_mode`,
`wal_checkpoint`, `busy_timeout` and `user_version` returns `not authorized: SQLITE_AUTH`. So the
control cannot be set, and — just as important — **it cannot be read back either**, so nobody can
verify from here what D1 does with a freed page. Whatever Cloudflare's storage does, this service
neither sets it nor knows it.

The WAL truncation that went with it is gone for the same reason: D1 exposes no write-ahead log,
there is no `-wal` file, and the prune receipt therefore has no `wal_truncated` field. A field that
was permanently `false` would be a standing false negative on the operator metrics route, which is
worse than an absent one.

**This is permanent.** There is no configuration, no compatibility flag and no rewrite of this code
that restores it. The only thing that would is not running on D1.

### 2. D1 keeps a 30-day restorable copy that the retention prune cannot reach

This one is *new* on D1 rather than merely lost, and it is the most likely to make a published
retention promise inaccurate.

D1's [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) keeps the database
restorable to any point **within the last 30 days** (`wrangler d1 time-travel restore` accepts a
timestamp "within the last 30 days"). It is part of the product; there is no setting here that turns
it off. A row deleted by tonight's prune is therefore still recoverable, by anyone who can reach
this Cloudflare account, for up to 30 days after it was deleted.

The Bun collector's README already says the general form of this — *"a backup or replica taken
before a prune still holds the rows and has no deletion path of its own… your backup retention is
part of your retention promise"* — but there it is the operator's own backup policy, which the
operator can choose. Here it is always on and not disableable.

**Practical consequence: the real maximum age of a recoverable heartbeat is
`MYTHICAL_TELEMETRY_RETENTION_DAYS + 30` days, not `MYTHICAL_TELEMETRY_RETENTION_DAYS`.** State the
number you actually mean.

### 3. Retention is no longer fail-closed

The Bun collector refuses to be a store with no retention, in two places:

- it prunes **at boot**, before the first request is served, and a failure there is fatal;
- it counts consecutive failures of the daily prune and calls `process.exit(1)` at two in a row, so
  a supervisor restarts it and the service either recovers or stays visibly down.

The principle was: *a collector that cannot delete must not go on collecting.*

A Worker has no boot, no process to exit, and no state shared between the `scheduled` invocation and
the `fetch` invocations that would let one stop the other. **What replaces it:**

- the prune runs on a Cron Trigger (`17 3 * * *` UTC), and nothing else;
- a failure throws out of `scheduled`, which records the failure against the Cron Trigger and is
  visible in observability (`"observability": { "enabled": true }` in `wrangler.jsonc`, and
  `wrangler tail`);
- **ingest keeps accepting heartbeats regardless.**

**What that costs.** If the prune fails every night, this service goes on collecting data under a
retention promise nothing is enforcing, and the only thing that says so is a log line. Nobody is
paged by a log line. If you deploy this, **put an alert on the Cron Trigger's failure count**, and
treat it as an availability alert rather than a housekeeping one.

There is also no longer a boot prune to close the gap after downtime — a Worker that was not invoked
is not "down" in a way anything notices, but a cron that did not fire is still a day not pruned.

Making this fail closed again is possible and is **not** done here: it needs the failure count in
durable state (a `meta` row, or KV) which `fetch` reads and honours by refusing ingest. That is a
design change with its own failure modes — a store that cannot be read now also cannot serve — and
it was not part of porting the service.

### 4. The retention clock is unobservable in production, and the counters are a sample

`GET /metrics` (operator key) is per-**isolate**, not per-service. Cloudflare runs many isolates in
many locations and recycles them freely, so:

- **`store.last_prune` reads `null` essentially always.** The prune happens in the Cron Trigger's
  invocation; a `/metrics` request lands on a different isolate and sees an object that was never
  written. The one receipt that shows the retention clock actually ran is not reachable through the
  metrics route. Fixing it means persisting the receipt into the `meta` table and reading it back —
  small, and not done. **Until it is, `wrangler tail` is the only way to see a prune's receipt.**
- **Every counter is one isolate's view**, so the operator's rejection breakdown is a sample, not a
  total. This is easy to mistake for "nothing is happening": a freshly-started isolate reports
  `ingest_accepted_total: 0` next to `store.instances_total: 1`, because the store is shared and the
  counters are not. That exact pair was observed during verification below.
- **The rate limiters and the aggregate cache are per-isolate too.** The three token buckets
  (`rateLimitPerMin`, the separate read/delete budget, and the per-source new-identity budget) bound
  a source *per isolate*, which against a distributed flood is close to not bounding it at all. The
  comments in `src/server.ts` reason about process-lifetime state; on Workers that reasoning is
  weaker than it reads. The aggregate cache's "database work is bounded to once per window no matter
  how many requests arrive" becomes once per window *per isolate*.

The controls that are **not** weakened, because they live in the database: the absolute instance
ceiling, the daily admission budget, and the append-only admission ledger. Those are enforced across
every isolate.

The real fix for the limiters is Cloudflare's [rate limiting
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) or a WAF rule
in front of the Worker, not more code in `src/server.ts`. If this service is exposed publicly and
matters, put an edge rate-limit rule on `POST /v1/ingest`.

### One further inexactness, smaller than the four above

`recordHeartbeat` is atomic — D1 refuses `BEGIN IMMEDIATE`, so the budget tests were re-expressed as
`WHERE` clauses on the inserts inside an atomic `batch()`, and the ceiling and the daily budget are
still exact. But the "is this identity already known" read happens *before* the batch, because a
batch cannot branch and the caller needs the answer. **If two requests create the same identity in
that gap, the admissions ledger is bumped twice for one identity.** It over-counts, which spends
budget rather than refunding it — the conservative direction, and it cannot be used to *gain*
admissions. It is still not exact, and this is the honest statement of it. See the doc comment on
`recordHeartbeat` in `src/db.ts`.

### And two things that were dropped, deliberately

- **There is no migration path from an existing SQLite volume.** `collector/src/migrate.ts` is a
  transactional rebuild with a row-conservation guard; it has no D1 home, and a D1 database starts
  empty, so the legacy shape it upgrades from cannot exist here. Moving an existing volume to D1
  would be an export/import, and the row-conservation guard would not come with it. `migration` is
  therefore `null` on `/metrics` rather than a fabricated empty object.
- **The trusted-proxy configuration does nothing.** `MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS` and
  `MYTHICAL_TELEMETRY_TRUSTED_PROXIES` are not read by the Worker and setting them has no effect.
  Cloudflare is the only proxy in the chain and it reports the client address itself, in
  `CF-Connecting-IP`, which a client cannot spoof. That is a simplification, but it also means ~110
  lines of carefully-reasoned code in `collector/src/ip.ts` and its tests no longer describe this
  deployment.

---

## Deploy

Everything below runs on **your** Cloudflare account and cannot be done from a build session. You
need [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) and an authenticated session
(`wrangler login`, or `CLOUDFLARE_API_TOKEN` in the environment).

Wrangler is **not** vendored into this repository — the family's other Workers use `npx` too, and
pinning a ~100 MB CLI into a lockfile that CI installs on every job buys nothing here. The scripts
call `npx --yes wrangler@4`, which pins the major version. Verified against **wrangler 4.115.0**.

On macOS in a non-interactive shell, wrangler refuses OAuth ("set CLOUDFLARE_API_TOKEN"); run
deploys under a pty: `script -q /dev/null npx wrangler deploy`.

All commands run from this directory:

```sh
cd collector-worker
```

### 1. Create the D1 database

```sh
npx wrangler d1 create mythicalos-telemetry --location weur
```

`--location weur` is Western Europe, matching the family's other D1 database. **A database's
location cannot be changed afterwards** — decide it now.

The command prints a `database_id`.

### 2. Paste the id into `wrangler.jsonc`

`d1_databases[0].database_id` currently reads:

```
"database_id": "PLACEHOLDER_RUN_WRANGLER_D1_CREATE_AND_PASTE_THE_ID",
```

Replace that string with the id from step 1. Nothing else in the file needs changing to deploy.

This is the **only** value you must fill in. (Local emulation never resolves it, which is why every
`--local` command in this file works before you do this. `wrangler deploy` does resolve it, and
fails rather than deploying a binding that points at nothing.)

### 3. Apply the migration

```sh
npx wrangler d1 migrations apply mythicalos-telemetry --remote
```

Expect: `0001_init.sql  ✅`, `9 commands executed successfully.` Running it a second time prints
`✅ No migrations to apply!` — it is idempotent, and D1 records what it applied in its own
`d1_migrations` table.

Confirm the tables:

```sh
npx wrangler d1 execute mythicalos-telemetry --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expect `admissions`, `d1_migrations`, `heartbeats`, `instances`, `meta`.

### 4. Secrets

There is exactly one, and it is **optional**:

```sh
npx wrangler secret put MYTHICAL_TELEMETRY_OPS_KEY
```

It gates `GET /metrics`. **Leave it unset and that route does not exist** (`404`, indistinguishable
from any other unknown path) — which is a perfectly good posture, given how little the counters mean
per-isolate (see §4 above). It is not a read or write credential: it cannot ingest and it cannot
read any installation's data.

**There is no ingest key, and there must never be one.** Every per-installation route proves
possession of that installation's own derived secret. Do not add a shared credential.

### 5. Deploy

```sh
npx wrangler deploy
```

Wrangler prints the deployed URL — `https://mythicalos-telemetry.<your-subdomain>.workers.dev` —
and a **Version ID**. Write the Version ID down; it is what you roll back to.

### 6. Hostname (do this before shipping a client that points at it)

As deployed, the Worker answers on `workers.dev`. That is fine for the verification below and wrong
for an ingest endpoint that shipped clients hard-code. When the hostname is decided, add it to
`wrangler.jsonc` and redeploy:

```jsonc
"routes": [{ "pattern": "telemetry.mythicalos.ai", "custom_domain": true }]
```

The hostname must be on this Cloudflare zone; `custom_domain` then provisions the certificate. Once
the custom domain is live, consider `"workers_dev": false` so there is one address for this service
rather than two.

---

## Verify the deployment

Run all of this against the deployed URL. It exercises the whole path: schema validation, the
derived-identity proof, the store, the authenticated read, the public aggregate, erasure, and the
retention cron.

```sh
BASE=https://mythicalos-telemetry.<your-subdomain>.workers.dev
```

### Set up a throwaway installation identity

An installation's id is `sha256(secret)[0..16]` formatted as a UUIDv4, over the **UTF-8 bytes of the
64-character hex string**. This mints one exactly as a real install does — it needs no registration
and contacts nothing:

```sh
SECRET=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
ID=$(node -e '
  const h = require("node:crypto").createHash("sha256").update(process.argv[1], "utf8").digest();
  const b = Uint8Array.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = Buffer.from(b).toString("hex");
  console.log(`${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20)}`);
' "$SECRET")
DAY=$(node -e 'console.log(new Date().toISOString().slice(0,10))')
echo "$ID"
```

And a heartbeat that the canonical schema accepts:

```sh
cat > /tmp/heartbeat.json <<EOF
{
  "schema_version": 1,
  "instance_id": "$ID",
  "day": "$DAY",
  "product": { "name": "brokkr", "version": "0.1.37" },
  "platform": { "os": "darwin", "arch": "arm64" },
  "metrics": {
    "config": { "backend": "local", "harness_type": "claude", "wizard_completed": true,
                "team_size": 4, "playbooks_active": 3, "review_mode": "cross-model" },
    "features": { "terminal": true, "edges": false },
    "sessions": { "count": 12, "minutes": 340, "failed": 1 },
    "context_fill": { "peak_histogram": [0,1,2,3,2,1,1,1,0,1], "avg_mean": 41.5 },
    "mode_split": { "normal": 9, "spine": 3 },
    "spine": { "joints": 5, "tokens_before": 120000, "tokens_after": 40000, "estimated": false },
    "models": [ { "name": "claude-opus-4-8", "sessions": 7 }, { "name": "other", "sessions": 2 } ],
    "tokens": { "input": 900000, "cache_read": 4000000, "cache_creation": 200000, "output": 80000 },
    "review": { "runs": 4 },
    "errors": { "classes": { "session_failed": 1 } }
  }
}
EOF
```

### The checks

Each block gives the command and **the exact response to expect**. Anything else is a failure.

**Health.**

```sh
curl -s -w '\nHTTP %{http_code}\n' "$BASE/healthz"
```
```
{"ok":true}
HTTP 200
```

**Signed ingest is accepted.**

```sh
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/v1/ingest" \
  -H 'content-type: application/json' \
  -H "X-Mythical-Instance-Secret: $SECRET" \
  --data-binary @/tmp/heartbeat.json
```
```
{"ok":true}
HTTP 202
```

**…and it is idempotent.** Run the same command again: the same `202 {"ok":true}`. One row per
`(instance, product, day)`, last write wins.

**Unsigned ingest is refused.** No secret header at all:

```sh
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/v1/ingest" \
  -H 'content-type: application/json' --data-binary @/tmp/heartbeat.json
```
```
{"ok":false,"error":"write_key_mismatch"}
HTTP 403
```

**A wrong secret gets the identical answer** — an absent secret and a wrong one must not be
distinguishable:

```sh
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/v1/ingest" \
  -H 'content-type: application/json' \
  -H "X-Mythical-Instance-Secret: $(printf '0%.0s' $(seq 1 64))" \
  --data-binary @/tmp/heartbeat.json
```
```
{"ok":false,"error":"write_key_mismatch"}
HTTP 403
```

**A malformed body, and a payload of the wrong shape, are both refused as `invalid_payload`** —
the response never says which, and never echoes the request:

```sh
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/v1/ingest" \
  -H 'content-type: application/json' \
  -H "X-Mythical-Instance-Secret: $SECRET" --data-binary 'not json'
```
```
{"ok":false,"error":"invalid_payload"}
HTTP 400
```

**The authenticated per-installation read works.**

```sh
curl -s -w '\nHTTP %{http_code}\n' \
  "$BASE/v1/instances/$ID/stats?product=brokkr" \
  -H "X-Mythical-Instance-Secret: $SECRET"
```

Expect `HTTP 200` and a body whose head reads like this — note `first_report_day` set,
`rates.days_counted: 0` and `rates.per_day: null`, because an installation's **first** heartbeat is
not a one-day delta and is excluded from every rate (see `../collector/README.md`):

```json
{"ok":true,"contract_version":2,"product":"brokkr",
 "instance":{"id":"…","product":"brokkr","first_seen_day":"2026-07-30",
             "last_seen_day":"2026-07-30","first_report_day":"2026-07-30","days_reported":1},
 "days":[ … the document exactly as stored, plus brokkr's computed spine.tokens_saved … ],
 "totals":{ … },
 "rates":{"days_counted":0,"excluded_day":"2026-07-30",
          "excluded_reason":"first_report_is_not_a_daily_delta","per_day":null}}
```

**The id alone is not a read capability.** Same URL, no secret header:

```sh
curl -s -w '\nHTTP %{http_code}\n' "$BASE/v1/instances/$ID/stats?product=brokkr"
```
```
{"ok":false,"error":"unauthorized"}
HTTP 403
```

**The public aggregate serves, and suppresses small cells.** With one installation stored, the
product is below the default floor of 5 and is withheld **entirely** — an empty `products` array
here is the small-cell floor working, not a broken query:

```sh
curl -s -w '\nHTTP %{http_code}\n' "$BASE/v1/stats"
```
```
{"ok":true,"contract_version":2,"generated_day":"2026-07-30","active_window_days":28,
 "retention_days":90,"min_cell":5,"products":[],
 "data_quality":"untrusted-public-ingest","family_total_installs":null}
HTTP 200
```

**The give-back page renders.**

```sh
curl -s -o /dev/null -w 'HTTP %{http_code}  bytes=%{size_download}\n' "$BASE/"
```
```
HTTP 200  bytes=3432
```

**`/metrics` is absent unless you set the ops key.**

```sh
curl -s -w '\nHTTP %{http_code}\n' "$BASE/metrics"
```
```
{"ok":false,"error":"not_found"}
HTTP 404
```

With `MYTHICAL_TELEMETRY_OPS_KEY` set, the same request without the header answers
`403 {"ok":false,"error":"unauthorized"}`, and with `-H "X-Mythical-Ops-Key: <key>"` it answers
`200` with the counters, the store gauges and the throttle sizes. Re-read §4 above before believing
any of those numbers.

**Erasure works, and is idempotent.**

```sh
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X DELETE "$BASE/v1/instances/$ID"                        # 403
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X DELETE "$BASE/v1/instances/$ID" \
  -H "X-Mythical-Instance-Secret: $SECRET"                                                              # 204
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X DELETE "$BASE/v1/instances/$ID" \
  -H "X-Mythical-Instance-Secret: $SECRET"                                                              # 204 again
curl -s -w '\nHTTP %{http_code}\n' "$BASE/v1/instances/$ID/stats?product=brokkr" \
  -H "X-Mythical-Instance-Secret: $SECRET"
```
```
{"ok":false,"error":"unknown_instance"}
HTTP 404
```

That last one is reached only by an authenticated owner, so it discloses nothing: you learn that
your own identity has no data.

Confirm at the store, too — the delete purges the identity across **every** product:

```sh
npx wrangler d1 execute mythicalos-telemetry --remote \
  --command "SELECT COUNT(*) AS n FROM heartbeats"
```

**The retention cron.** You cannot fire a deployed Cron Trigger by hand; wait for `03:17 UTC` and
check that it ran and what it deleted:

```sh
npx wrangler tail mythicalos-telemetry --format pretty
```

A successful prune logs one line:

```
retention: {"effective_day":"2026-07-30","cutoff_day":"2026-05-02","clamp_day":"2026-07-31",
            "clamped_heartbeats":0,"clamped_instances":0,"expired_heartbeats":0,
            "capped_heartbeats":0,"expired_instances":0}
```

`cutoff_day` should be `retention_days − 1` behind `effective_day`, and `effective_day` should equal
today. **`effective_day` differing from today means the clock went backwards and the durable
watermark overrode it** — the prune still happened, correctly, but something is wrong with time.

This log line is the *only* place a prune's receipt appears: `store.last_prune` on `/metrics` reads
`null`, for the reason in §4.

If you want to see the prune act on a real row before trusting it, exercise it locally instead —
see "Local development" below, where the cron can be fired on demand.

---

## Rollback

**The code and the data roll back separately, and neither implies the other.**

**Code.** Every `wrangler deploy` prints a Version ID; list them and roll back:

```sh
npx wrangler deployments list
npx wrangler rollback <version-id> --message "why"
```

Rolling back the Worker does **not** undo a migration. The schema this repository ships is additive
and the current code is the only code that has ever run against it, so a rollback to the previous
*deployed* version is safe; a rollback to something predating a future migration is not, unless that
migration was written to be backward-compatible. Write them that way.

**Data.** D1 Time Travel restores the whole database to a point in time within the last 30 days:

```sh
npx wrangler d1 time-travel info mythicalos-telemetry
npx wrangler d1 time-travel restore mythicalos-telemetry --timestamp 2026-07-30T02:00:00Z
```

Two things to hold in mind before running that. It restores **everything**, so it also **undoes
every erasure request honoured since that timestamp** — an installation that exercised its right to
delete has its rows back. If you restore, re-run the deletes. And it is the same mechanism as §2
above: the ability to roll back and the inability to promise deletion are one property, not two.

**Stopping the service entirely.** `npx wrangler delete` removes the Worker; the D1 database and its
data survive that, and must be deleted separately (`npx wrangler d1 delete mythicalos-telemetry`) if
that is what you mean.

---

## Configuration

Every knob has a default in code and is optional. To change one, add it to `vars` in
`wrangler.jsonc` and redeploy — except the ops key, which is a secret (`wrangler secret put`).

| Variable | Default | Meaning |
|---|---|---|
| `MYTHICAL_TELEMETRY_RETENTION_DAYS` | `90` | days after **arrival** a record is kept, heartbeats and identity rows alike. Must be ≥ 1; `0` is refused. Remember §2: recoverable for this **+ 30**. |
| `MYTHICAL_TELEMETRY_MAX_INSTANCES` | `100000` | absolute ceiling on stored identities. Enforced in the database, so it holds across isolates. |
| `MYTHICAL_TELEMETRY_NEW_INSTANCES_PER_DAY` | `5000` | global daily budget for fresh identities (`0` disables). Also enforced in the database. |
| `MYTHICAL_TELEMETRY_NEW_INSTANCE_PER_SOURCE_PER_HOUR` | `20` | per-source budget for fresh identities. **Per isolate** — see §4. |
| `MYTHICAL_TELEMETRY_RATE_LIMIT_PER_MIN` | `60` | per-source token bucket. **Per isolate** — see §4. |
| `MYTHICAL_TELEMETRY_MAX_BODY` | `32768` | ingest body cap in bytes → `413` |
| `MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL` | `5` | small-cell floor for the public aggregate |
| `MYTHICAL_TELEMETRY_OPS_KEY` | *(unset)* | **secret.** Gates `/metrics`; unset means the route does not exist |

`MYTHICAL_TELEMETRY_DB_PATH`, `MYTHICAL_TELEMETRY_PORT`, `MYTHICAL_TELEMETRY_TRUSTED_PROXY_HOPS` and
`MYTHICAL_TELEMETRY_TRUSTED_PROXIES` have **no effect here** and setting them does nothing. The first
two are meaningless on Workers; the second two are explained at the end of the "does NOT have"
section.

TLS is not your problem on Workers — the platform terminates it and there is no plaintext listener
to publish. The instance secret travels in a request header, so do not proxy this service through
anything that logs headers.

---

## Tests

```sh
bun test tests      # from this directory
bun test            # from the repository root — includes these
```

Current: **31 pass, 2 skip, 0 fail.** They run in CI, because the root `bun test` picks them up.

### What is covered

`tests/db.test.ts` is `collector/tests/db.test.ts` ported to the D1 store. The transform was
mechanical — `async`/`await` throughout, and the store constructed over a shim instead of a file
path. **No assertion was relaxed and no expected value was changed.** It covers the whole store: the
upsert and its `first_seen_day`/`last_seen_day` behaviour, per-product partitioning, the retention
clock (arrival-based cutoff, the one-way watermark, the impossible-arrival clamp, malformed day
values, orphaned identity rows), the row cap, the admission ceiling and daily budget, the
append-only ledger, and the aggregate query.

Two of those tests matter more here than they did in the original, because they are what the
`BEGIN IMMEDIATE` rewrite has to survive:

- *"a second process on the same file cannot walk past the ceiling"* — two stores over one database,
  which is the shape of two isolates. If the `WHERE`-clause-inside-a-`batch()` rewrite is wrong,
  this is where it shows.
- *"a zero daily budget disables that check without disabling the ceiling"* — porting the suite
  caught a real bug in the rewrite here: a budget of `0` means "disabled", and the first SQL guard
  refused everything instead.

### What is NOT covered, and why

- **`bun test` cannot drive D1.** There is no D1 outside workerd. The store tests run against
  `tests/d1-over-sqlite.ts`, a shim presenting D1's API over `bun:sqlite`. Read that file's header:
  it does **not** prove D1's `batch()` atomicity (the shim uses a real SQLite transaction, which is
  stronger than D1 documents), does not reproduce `SQLITE_AUTH`, and does not reproduce network
  latency or D1's per-query and row-size limits.
- **`src/server.ts` has no unit tests here at all.** The original's route-level suites — ingest,
  read auth, hardening, IP/trusted-proxy, stats, aggregate, seam, packaging — were not ported. The
  route layer's only coverage is the end-to-end verification above. That is the largest gap in this
  package, and it is a gap, not a decision that route behaviour does not matter.
- **`src/worker.ts` has no tests.** Its `scheduled` path is exercised only by firing the cron by
  hand under `wrangler dev --local`.
- **The two unportable tests** are declared in `tests/db.test.ts` as skipped tests carrying their
  reason, so `bun test` reports `2 skip` on every run rather than silently forgetting them:
  - `file-backed database runs in WAL mode` — D1 refuses `PRAGMA journal_mode`.
  - `a prune folds the write-ahead log back and truncates it, and says whether it did` — D1 exposes
    no write-ahead log, and the prune receipt has no `wal_truncated` field.

  They are §1 of "What this deployment does not have", expressed as tests. Do not delete them to
  make the suite tidy; a skipped test is reported every run, a deleted one is reported never.

---

## Local development

Local emulation needs no Cloudflare account and never contacts one. It works with the placeholder
`database_id` exactly as it stands.

```sh
cd collector-worker
bun run migrate:local     # npx wrangler d1 migrations apply mythicalos-telemetry --local
bun run dev               # npx wrangler dev --local --port 8812
```

Every check in "Verify the deployment" works against the local server; set `BASE=http://127.0.0.1:8812`.

Two things you can do locally that you cannot do against the deployment:

**Fire the retention cron on demand.** `wrangler dev` says so at start-up:

```sh
curl "http://127.0.0.1:8812/cdn-cgi/handler/scheduled"      # -> ok
```

The prune's receipt is printed in the `wrangler dev` output.

**Reach into the store.** To watch the prune actually delete something, seed a row that is already
past the window and fire the cron:

```sh
npx wrangler d1 execute mythicalos-telemetry --local --command "
  INSERT INTO instances (instance_id, product, first_seen_day, last_seen_day, first_report_day)
    VALUES ('aged-identity','brokkr','2023-01-01','2023-01-01','2023-01-01');
  INSERT INTO heartbeats (instance_id, product, day, schema_version, payload, received_day)
    VALUES ('aged-identity','brokkr','2023-01-01',1,'{}','2023-01-01');"
curl "http://127.0.0.1:8812/cdn-cgi/handler/scheduled"
```

The receipt reports `"expired_heartbeats":1,"expired_instances":1` — the heartbeat aged out, and the
identity row went with it because nothing of that identity was left.

Local state lives in `.wrangler/` and is gitignored; delete that directory for a genuinely empty
database. `.dev.vars` (also gitignored) supplies local values for `MYTHICAL_TELEMETRY_OPS_KEY` and
the rest.

```sh
bun run typecheck
```
