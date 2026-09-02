// UTC calendar-day arithmetic.
//
// Every date this service handles is a bare `YYYY-MM-DD` in UTC — the wire
// carries no times, and `received_day` is stored at day granularity so an
// installation's check-in cadence cannot be fingerprinted. Keeping the
// arithmetic in one place keeps the ingest day-window, the aggregate's active
// window and the retention cutoff agreeing about what a day is.

const MS_PER_DAY = 86_400_000;

/**
 * How many days BEFORE today an ingested `day` may be. Ingest accepts
 * `today − INGEST_DAY_WINDOW_DAYS … today` inclusive, so a stored row's `day` is
 * never more than this many days older than its `received_day`.
 *
 * It lives here, next to the retention arithmetic, because two controls derive
 * from it and they must not drift apart: the ingest window check itself, and the
 * per-(instance, product) row cap, which has to allow for a whole window of
 * backfill or it silently becomes the binding control and truncates history the
 * retention promise says is kept (see db.ts `maxRowsFor`). Widen this and the
 * cap widens with it.
 */
export const INGEST_DAY_WINDOW_DAYS = 30;

/** YYYY-MM-DD → UTC epoch ms, or null if it is not a real calendar day (e.g. 2026-02-30). */
export function dayToEpochUtc(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return t;
}

/** Shift a YYYY-MM-DD day by a whole number of days, staying in UTC. Unparseable input is returned unchanged. */
export function shiftDay(day: string, deltaDays: number): string {
  const epoch = dayToEpochUtc(day);
  if (epoch === null) return day;
  return new Date(epoch + deltaDays * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Today, UTC. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export { MS_PER_DAY };
