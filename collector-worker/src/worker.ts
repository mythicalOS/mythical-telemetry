// The Worker entrypoint. The deployed counterpart of
// `collector/src/cli/server.ts` — see `../../docs/TWO-COLLECTORS.md`.
//
// Three things in that file have no Worker equivalent and are dealt with here:
//
//   1. `Bun.serve({ fetch })` becomes `export default { fetch }`. This part is
//      genuinely free — `buildFetchHandler` already returns exactly the right
//      shape.
//   2. `setInterval(prune, 24h)` becomes `export default { scheduled }` driven
//      by the Cron Trigger in wrangler.jsonc. Also close to free.
//   3. THE FAIL-CLOSED POSTURE DOES NOT SURVIVE. See `scheduled` below.
//
// And one thing that is not in that file at all: the handler is built ONCE PER
// ISOLATE, not once per process, because that is the only lifetime a Worker
// has. Everything the handler keeps in memory — the three token buckets, the
// counters, the aggregate cache — is per-isolate as a result. See the note on
// `getHandler`.

import { todayUtc } from '../../collector/src/day';
import type { ServerLike } from '../../collector/src/throttle';
import type { HeartbeatValidator, ValidationResult, Heartbeat } from '../../collector/src/validator';
import { TelemetryD1, type D1Database } from './db';
import { buildFetchHandler, type FetchHandler } from './server';

// THE VALIDATOR SEAM, AND WHY THIS IMPORT LOOKS LIKE THIS.
//
// `collector/src/validator.ts` loads the canonical validator with
// `await import(spec)` where `spec` is a variable. That is a RUNTIME module
// load, and a Worker has no module loader — esbuild has to resolve every import
// at bundle time, so the indirection through a variable defeats it. The seam
// must become a STATIC import.
//
// It also cannot be a static import of the package ROOT. `@mythicalos/telemetry`'s
// `index.ts` re-exports `identity.ts`, `atomic.ts` and `ssrf.ts`, which import
// `node:fs`, `node:path`, `node:http`, `node:https`, `node:net` and `node:dns` —
// client-side concerns that the collector never touches, but that a bundler
// pulls in regardless. So the import has to reach `envelope.ts` directly, which
// is the only module the validator actually needs and which imports nothing.
//
// So this is a deep RELATIVE import into the sibling package's source tree,
// not a package-name import. That is deliberate and it is bounded: this Worker
// is bundled from inside this repository, where the source is present, so it
// never resolves `@mythicalos/telemetry` through node_modules and never needs
// the package's `exports` map to publish a subpath. The dependency is still
// declared in `package.json` because it is a real coupling — if the package
// moved or its envelope module were renamed, this import would break and the
// declaration is what says whose fault that is.
//
// The consequence to know: ANYONE OUTSIDE THIS REPOSITORY cannot reproduce
// this wiring against the published package, because `exports` publishes only
// `"."` and the two schema JSON files. Adding a `./envelope` subpath export
// would fix that — it is not done here, because it would make an internal
// module a supported public entry point, and nothing in this deployment needs
// it.
import { validateHeartbeat } from '../../packages/telemetry/src/envelope';

export interface Env {
  DB: D1Database;
  MYTHICAL_TELEMETRY_RETENTION_DAYS?: string;
  MYTHICAL_TELEMETRY_MAX_INSTANCES?: string;
  MYTHICAL_TELEMETRY_NEW_INSTANCES_PER_DAY?: string;
  MYTHICAL_TELEMETRY_MAX_BODY?: string;
  MYTHICAL_TELEMETRY_RATE_LIMIT_PER_MIN?: string;
  MYTHICAL_TELEMETRY_NEW_INSTANCE_PER_SOURCE_PER_HOUR?: string;
  MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL?: string;
  MYTHICAL_TELEMETRY_OPS_KEY?: string;
}

/** As `envInt` in cli/server.ts, reading a binding instead of `process.env`. */
function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`expected a non-negative integer, got: ${raw}`);
  }
  return n;
}

/**
 * The canonical validator, adapted to the collector's seam.
 *
 * Same adapter as `loadCanonicalValidator`, minus the dynamic import and minus
 * the "refuse to start if it is absent" guard — a static import that fails to
 * resolve is a BUILD error here rather than a boot error, which is strictly
 * better: the collector cannot be deployed without its validator at all.
 */
const canonicalValidator: HeartbeatValidator = {
  validate(raw: unknown): ValidationResult {
    const result = validateHeartbeat(raw);
    if (result.ok) return { ok: true, value: result.value as unknown as Heartbeat };
    // The package's per-path error detail is discarded, exactly as the original
    // adapter discards it: it can embed an attacker-supplied property name, and
    // the collector only uses this string to choose a counter name.
    return { ok: false, error: 'schema_invalid' };
  },
};

/**
 * On Workers the client address is a header set by the edge, not a property of
 * a TCP peer — there is no `server.requestIP`. `CF-Connecting-IP` is written by
 * Cloudflare and cannot be spoofed by the client, so it is the honest analogue
 * of the peer address.
 *
 * NOTE what this does to `throttle.ts`'s trusted-proxy model: the entire
 * `trustedProxyHops` / `trustedProxies` / `X-Forwarded-For` apparatus — the
 * single most carefully-reasoned part of that file — becomes dead code, because
 * the only proxy in the chain is Cloudflare itself and it has already told us
 * the answer. That is a simplification, but it is also ~110 lines of reasoning
 * and a body of tests that no longer describe the deployment.
 */
function workerServerLike(req: Request): ServerLike {
  const address = req.headers.get('cf-connecting-ip');
  return { requestIP: () => (address !== null ? { address } : null) };
}

/**
 * Built once per ISOLATE and memoised in module scope.
 *
 * This is where a Worker differs from the Bun service in a way that matters.
 * `buildFetchHandler` closes over three `TokenBucketLimiter`s, a `Counters`
 * instance and the aggregate cache, all of which the original reasons about as
 * PROCESS-lifetime state — one process, one set of buckets, one cache. A Worker
 * has no process: Cloudflare runs many isolates, in many colos, and recycles
 * them freely. So each of those becomes per-isolate:
 *
 *   • the rate limiters no longer bound a source globally — they bound it per
 *     isolate, which for a distributed flood is close to not bounding it;
 *   • `/metrics` counters report one isolate's view, so the operator's
 *     fine-grained rejection breakdown becomes a sample rather than a total;
 *   • the aggregate cache's amplification guarantee ("database work is bounded
 *     to once per window no matter how many requests arrive") weakens to once
 *     per window PER ISOLATE.
 *
 * None of that is fixed here. Fixing it means Durable Objects or the platform
 * rate-limiting binding, and that is a design change, not a port.
 */
let handler: FetchHandler | null = null;
let handlerDb: TelemetryD1 | null = null;

function getHandler(env: Env): { handler: FetchHandler; db: TelemetryD1 } {
  if (handler !== null && handlerDb !== null) return { handler, db: handlerDb };
  const db = new TelemetryD1({
    db: env.DB,
    retentionDays: envInt(env.MYTHICAL_TELEMETRY_RETENTION_DAYS, 90),
    maxInstances: envInt(env.MYTHICAL_TELEMETRY_MAX_INSTANCES, 100_000),
    newInstancesPerDay: envInt(env.MYTHICAL_TELEMETRY_NEW_INSTANCES_PER_DAY, 5_000),
  });
  const built = buildFetchHandler({
    db,
    validator: canonicalValidator,
    maxBodyBytes: envInt(env.MYTHICAL_TELEMETRY_MAX_BODY, 32_768),
    rateLimitPerMin: envInt(env.MYTHICAL_TELEMETRY_RATE_LIMIT_PER_MIN, 60),
    newInstancePerSourcePerHour: envInt(env.MYTHICAL_TELEMETRY_NEW_INSTANCE_PER_SOURCE_PER_HOUR, 20),
    // Not configurable any more: Cloudflare is the proxy, and it reports the
    // client address itself. See `workerServerLike`.
    trustedProxyHops: 0,
    trustedProxies: [],
    minAggregateCell: envInt(env.MYTHICAL_TELEMETRY_MIN_AGGREGATE_CELL, 5),
    opsKey: env.MYTHICAL_TELEMETRY_OPS_KEY ?? null,
  });
  handler = built;
  handlerDb = db;
  return { handler: built, db };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { handler: h } = getHandler(env);
    return await h(req, workerServerLike(req));
  },

  /**
   * The retention prune, on a Cron Trigger.
   *
   * WHAT DOES NOT SURVIVE, and it is the most consequential loss in this file.
   * `cli/server.ts` implements a fail-closed posture in two places:
   *
   *   • the BOOT prune runs before the first request is served, and a failure
   *     is fatal — "a collector that cannot delete must not start accepting
   *     data it has promised to delete";
   *   • `MAX_CONSECUTIVE_PRUNE_FAILURES` counts failures across ticks and calls
   *     `process.exit(1)` at two in a row, so a supervisor restarts it and the
   *     service either recovers or stays visibly down.
   *
   * A Worker has no boot, no process to exit, and no cross-invocation counter.
   * There is no way from inside a `scheduled` handler to stop `fetch` from
   * serving. So the strongest available behaviour is: throw, so the failure is
   * recorded against the Cron Trigger and is visible in observability — AND
   * KEEP SERVING. The invariant "this service stops collecting when it can no
   * longer delete" is not implementable as written. Re-creating it needs
   * external state (a KV/D1 failure counter that `fetch` reads and honours),
   * which is new design, not a port.
   */
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const { db } = getHandler(env);
    const today = todayUtc();
    const report = await db.pruneRetention(today);
    if (report.effective_day !== today) {
      console.error(
        `retention: clock is behind the recorded watermark; pruned as of ${report.effective_day}`,
      );
    }
    console.log(`retention: ${JSON.stringify(report)}`);
  },
};
