// The closed set of products that may create a storage partition.
//
// THIS MODULE EXISTS BECAUSE THERE ARE TWO COLLECTORS. `collector/` and
// `collector-worker/` are near-copies of each other (see
// `../../docs/TWO-COLLECTORS.md`), and this is the one constant whose drift
// would change what a deployment ACCEPTS rather than how it performs: adding a
// product to one side and not the other means heartbeats that one collector
// stores and the other refuses with `ingest_rejected_unknown_product`, for a
// reason no client can see and no test in either package would catch. So it is
// declared once, here, and imported by both route layers.
//
// It is deliberately its own file rather than a line in `server.ts` — a
// constant shared across a package boundary should not drag a module that
// imports `node:crypto`, the store and the page renderer along with it.

/**
 * The products this service will open a storage partition for.
 *
 * This is NOT payload validation — the canonical validator has already
 * accepted the document. It is an authorization check on the partition key: a
 * validator that one day widens its product enum must not be able to silently
 * create new partitions in a deployed collector, because `product` is half of
 * the primary key and of every aggregate. Widening is a deliberate act here.
 */
export const STORABLE_PRODUCTS: ReadonlySet<string> = new Set(['brokkr', 'saga', 'skuld']);
