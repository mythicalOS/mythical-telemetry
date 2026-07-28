// The public give-back page — AGGREGATE ONLY (gate G6).
//
// WHAT WAS REMOVED, AND WHY: the previous collector served `/i/<uuid>`, an
// unauthenticated per-install stats page whose entire access control was "you
// know the UUID". Under G6 the instance id is no longer a bearer read
// capability, so that route was not made authenticated — it was deleted.
// Leaving an unauthenticated per-install surface in place while declaring the
// id non-bearer would have been a contradiction, and a route that renders one
// install's history to whoever can produce its id is exactly the capability
// G6 withdraws. Per-install reads now happen over the authenticated JSON API.
//
// What is left is a page about the population, never about an installation:
// server-rendered, inline CSS only, zero JS, zero external assets, and every
// interpolated value through the ONE escape function below.
//
// The page also states the retention window, because retention changes what the
// figures MEAN: identity rows expire, so "installations seen" is seen-within-the-
// window and never an all-time count. That qualifier is on the column heading and
// in the notes, not left for a reader to infer.
//
// TWO disclosure rules bind this page:
//
//   1. SMALL-CELL SUPPRESSION. A product with fewer installs than the floor is
//      not listed at all, and any individual figure below the floor renders as
//      "—". "3 installs, all on Linux" is a statement about three identifiable
//      installations.
//
//      The COUNT of withheld products is not published either. With a closed
//      product set, "two rows shown, one withheld" names the withheld product
//      and says it has fewer than the floor — the suppression would announce
//      exactly the fact it exists to hide. The page says only that anything
//      below the floor is not listed.
//   2. NO FAMILY TOTAL. Each product derives its own identity, so nothing
//      joins one installation across products. Any family-wide count would
//      double-count everyone running two products. The absence is stated on
//      the page rather than left as a gap someone later "fixes" by summing.
//
// The figures are also labelled honestly as untrusted: ingest is public and
// unauthenticated, so anyone can mint identities and submit schema-valid junk.

/** The single HTML escape function — every interpolated value goes through it. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const esc = escapeHtml;

export interface AggregateProductView {
  product: string;
  /** null when the figure is below the small-cell floor. */
  installs_seen: number | null;
  installs_active: number | null;
  days_reported: number | null;
}

export interface AggregateView {
  generated_day: string;
  active_window_days: number;
  /**
   * The retention window. Rendered, not decoration: records expire on it, so
   * every figure on this page describes that window rather than all of time, and
   * a column headed only "seen" would be read as all-time.
   */
  retention_days: number;
  min_cell: number;
  products: AggregateProductView[];
}

/** Deterministic integer formatting with comma grouping (no locale dependence). */
function fmtInt(value: number | null): string {
  if (value === null) return '—';
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) return '—';
  return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^/, n < 0 ? '-' : '');
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #101418; color: #e6ebf0; padding: 2rem 1.25rem; line-height: 1.5; }
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
.sub { color: #8b98a5; font-size: 0.85rem; margin-bottom: 1.5rem; }
h2 { font-size: 0.95rem; font-weight: 600; color: #aab6c2; margin: 1.75rem 0 0.6rem; }
table { border-collapse: collapse; width: 100%; background: #1a2129; border: 1px solid #2a333d; border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 0.55rem 0.75rem; font-size: 0.85rem; border-bottom: 1px solid #232c36; }
th { color: #8b98a5; font-weight: 600; }
tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.note { color: #aab6c2; font-size: 0.82rem; margin-top: 1rem; }
.note strong { color: #e6ebf0; }
footer { color: #5c6873; font-size: 0.72rem; margin-top: 2.5rem; }
`;

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

export function renderAggregatePage(view: AggregateView): string {
  const rows = view.products
    .map(
      (p) => `<tr><td>${esc(p.product)}</td>` +
        `<td class="num">${esc(fmtInt(p.installs_seen))}</td>` +
        `<td class="num">${esc(fmtInt(p.installs_active))}</td>` +
        `<td class="num">${esc(fmtInt(p.days_reported))}</td></tr>`,
    )
    .join('');

  const table = `
<table>
<thead><tr><th>Product</th><th class="num">Installations seen (${esc(view.retention_days)}d)</th><th class="num">Active (${esc(view.active_window_days)}d)</th><th class="num">Days reported</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">Nothing to report yet.</td></tr>'}</tbody>
</table>`;

  const body = `
<h1>mythicalOS telemetry &mdash; population</h1>
<p class="sub">Aggregate figures only, as of ${esc(view.generated_day)} (UTC).</p>
${table}
<h2>How to read this</h2>
<p class="note"><strong>Nothing here is an all-time total.</strong> A record is deleted
${esc(view.retention_days)} days after it <em>arrives</em>, and an installation's identity row goes
with the last record of it &mdash; so an installation that stopped reporting more than
${esc(view.retention_days)} days ago is not counted at all. Days reported counts the records still
held, which describe days slightly older than that, since a record can arrive up to a month after
the day it covers.</p>
<p class="note"><strong>There is no family total, by design.</strong> Each product derives its own
installation identity, and nothing joins them. Adding these columns would count anyone running two
products twice, so no such figure is published.</p>
<p class="note"><strong>These numbers are untrusted.</strong> Ingest is public and unauthenticated:
anyone can mint an identity and submit well-formed junk. Treat them as an upper bound on activity,
not as a measurement.</p>
<p class="note"><strong>Anything below ${esc(view.min_cell)} is withheld.</strong> A figure under the
floor shows as &mdash;, and a product under it is not listed at all &mdash; nor is the fact that one
was withheld, which would name it. A small count describes identifiable installations rather than a
population.</p>
<h2>Your own data</h2>
<p class="note">Per-installation figures are not published here. They require the installation's own
secret, over the authenticated API &mdash; knowing an installation id grants nothing. The same
secret purges every record for that identity.</p>
<footer>Heartbeats are pseudonymous, not anonymous: the installation id is stable across days, so
the daily records form a series. Counts and buckets only &mdash; never content.</footer>`;

  return htmlDocument('mythicalOS telemetry — population', body);
}
