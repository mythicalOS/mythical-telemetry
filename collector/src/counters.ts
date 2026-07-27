// Observable rejections (plan §13: "rejections observable rather than silent").
//
// The WIRE answer stays deliberately coarse — several distinct internal
// reasons collapse to one response body so the route cannot be used as an
// oracle (an absent secret and a wrong secret must look identical; a malformed
// payload and an out-of-window day must not tell an attacker which guard
// fired). The OPERATOR answer is fine-grained, and that is what this file
// holds.
//
// Every counter name is seeded to zero at construction. A reason that has
// never fired must still appear in the snapshot: "the key is missing" and "the
// value is zero" are indistinguishable otherwise, and a rejection class that
// silently never registers is exactly the failure this exists to prevent.
//
// These counters are in-memory and process-lifetime only. They are not
// storage, they hold nothing per-install, and — like the rate limiter — they
// never touch the database.

export const COUNTER_NAMES = [
  // accepted
  'ingest_accepted_total',
  'ingest_accepted_wire_v1',
  'ingest_accepted_wire_v2',
  'ingest_accepted_new_instance',
  // rejected — one name per distinct internal reason
  'ingest_rejected_total',
  'ingest_rejected_missing_secret',
  'ingest_rejected_rate_limited',
  'ingest_rejected_body_too_large',
  'ingest_rejected_malformed_json',
  'ingest_rejected_unsupported_schema_version',
  'ingest_rejected_v1_window_closed',
  'ingest_rejected_schema_invalid',
  'ingest_rejected_validator_error',
  'ingest_rejected_unknown_product',
  'ingest_rejected_day_out_of_window',
  'ingest_rejected_identity_mismatch',
  'ingest_rejected_new_instance_source_limit',
  'ingest_rejected_instance_capacity',
  'ingest_rejected_daily_admission_budget',
  // reads
  'read_stats_ok',
  'read_stats_unauthorized',
  'read_stats_unknown',
  'read_aggregate_ok',
  // deletes
  'delete_ok',
  'delete_unauthorized',
  // service
  'internal_error',
] as const;

export type CounterName = (typeof COUNTER_NAMES)[number];

export class Counters {
  private readonly values = new Map<string, number>();

  constructor() {
    for (const name of COUNTER_NAMES) this.values.set(name, 0);
  }

  inc(name: CounterName, by = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }

  get(name: CounterName): number {
    return this.values.get(name) ?? 0;
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of COUNTER_NAMES) out[name] = this.values.get(name) ?? 0;
    return out;
  }
}
