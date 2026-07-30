// SPIKE TEST HARNESS — a `D1Database` implemented over `bun:sqlite`.
//
// WHY THIS EXISTS. The collector's 263 tests run in `bun test` against an
// in-memory `bun:sqlite`. They cannot run against D1 as written, and the
// question the spike has to answer is HOW MUCH of that is the store being
// remote and how much is merely the store being async. This shim isolates the
// second half: it presents D1's exact API surface over `bun:sqlite`, so the
// ported test file differs from the original ONLY by `async`/`await` and by the
// assertions that name things D1 does not have.
//
// WHAT IT DOES NOT PROVE, stated plainly so no one reads more into a green run
// than is there:
//
//   • It does not prove D1's `batch()` atomicity. Here `batch` is a real
//     SQLite transaction, which is STRONGER than what D1 documents.
//   • It does not reproduce SQLITE_AUTH. Every PRAGMA works here and none work
//     on D1 — the PRAGMA findings in this spike come from `wrangler d1 execute
//     --local`, not from this file.
//   • It does not reproduce network latency, D1's per-query limits, or its
//     row/size caps.
//
// It is a harness for the PORTED LOGIC, not a substitute for running on D1.
// The end-to-end proof that the port works on real (local) D1 is the
// `wrangler dev --local` run recorded in the spike notes.

import { Database } from 'bun:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from './db-d1';

class ShimStatement implements D1PreparedStatement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly params: readonly unknown[] = [],
  ) {}

  /** D1 prepared statements are immutable — `bind` returns a NEW statement. */
  bind(...values: unknown[]): D1PreparedStatement {
    return new ShimStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    // `?? null` because bun:sqlite yields `undefined` for an empty result and
    // D1 yields `null`. Code written against D1 checks for null.
    return (this.db.query(this.sql).get(...(this.params as never[])) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return { results: this.db.query(this.sql).all(...(this.params as never[])) as T[], success: true, meta: {} };
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  /**
   * The synchronous execution used by `batch`.
   *
   * `bun:sqlite`'s `transaction()` takes a SYNCHRONOUS callback — an async one
   * would commit before its awaits resolved, which would make this shim
   * silently non-atomic and quietly invalidate every test that depends on it.
   * So batch members are executed through this rather than awaited.
   */
  runSync(): D1Result {
    const res = this.db.query(this.sql).run(...(this.params as never[]));
    return { success: true, meta: { changes: res.changes } };
  }
}

export class D1OverSqlite implements D1Database {
  constructor(private readonly db: Database) {}

  prepare(query: string): D1PreparedStatement {
    return new ShimStatement(this.db, query);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    // D1's batch is atomic and its members run in order. A SQLite transaction
    // gives both. A throw rolls the transaction back and PROPAGATES — never
    // swallowed — which is what D1 does too.
    const out: D1Result<T>[] = [];
    const tx = this.db.transaction(() => {
      for (const s of statements) {
        if (!(s instanceof ShimStatement)) {
          throw new Error('D1OverSqlite.batch received a statement it did not create');
        }
        // Every statement in the collector's batches is a write, so `runSync`
        // is the right verb. Deliberately NOT generalised to SELECTs: a harness
        // that quietly handled a case the real code never uses would be a place
        // for the port and the test to disagree.
        out.push(s.runSync() as D1Result<T>);
      }
    });
    tx();
    return out;
  }
}
