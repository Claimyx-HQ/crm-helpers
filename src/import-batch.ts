// crm-helpers/src/import-batch.ts
// `appendImportBatchId` — read-merge-write helper for appending a batch id
// to `Company.import_batch_ids`. Base44's Entity.update does NOT support
// the `$addToSet` operator (flow-catalog research 14b — that operator is
// only honored on Entity.updateMany), so the only safe single-row variant
// is read-current-array → check membership → write-merged-array.
//
// Intended call pattern in consumers (import flows):
//
//   import { appendImportBatchId } from '@claimyx/crm-helpers/import-batch';
//   const updated = await appendImportBatchId(Company, companyId, batchId);
//   // updated.import_batch_ids now contains batchId (idempotent — safe to
//   // call repeatedly).

/**
 * Minimal entity-client surface required by `appendImportBatchId`. Mirrors
 * the Base44 SDK shape: `get` returns the row by id, `update` patches it.
 */
export interface ImportBatchEntity<C extends { id: string; import_batch_ids?: string[] }> {
  get(id: string): Promise<C>;
  update(id: string, data: Record<string, unknown>): Promise<C>;
}

/**
 * Append a batch id to the company's `import_batch_ids` array, idempotently.
 *
 * Base44's Entity.update does not support array operators like `$addToSet`
 * (see flow-catalog research 14b — those are only honored on
 * Entity.updateMany), so the only safe path for a single row is:
 *
 *   1. Read the current row.
 *   2. If `import_batch_ids` already contains `batchId`, return the row
 *      unchanged (no write).
 *   3. Otherwise, write `import_batch_ids: [...existing, batchId]`.
 *
 * Missing `import_batch_ids` field is treated as an empty array.
 *
 * NOTE: This is read-modify-write and is therefore NOT safe under high
 * concurrency on the same company id — two concurrent appends could race
 * and one batch id can be lost. The import flow this helper supports is
 * serial per-company (a single import worker per CSV row), so the race is
 * not realized in practice. If a future caller needs concurrent appends,
 * wrap calls in a per-company lock or move to Entity.updateMany with
 * `$addToSet`.
 *
 * Returns the company row (updated, or the original on no-op). Throws
 * on underlying SDK errors (no swallowing — the caller is responsible
 * for retry).
 */
export async function appendImportBatchId<
  C extends { id: string; import_batch_ids?: string[] },
>(
  companyEntity: ImportBatchEntity<C>,
  companyId: string,
  batchId: string,
): Promise<C> {
  const company = await companyEntity.get(companyId);
  const existing = Array.isArray(company.import_batch_ids)
    ? company.import_batch_ids
    : [];
  if (existing.includes(batchId)) {
    // Already present — no-op. Return the freshly-read row.
    return company;
  }
  const merged = [...existing, batchId];
  return companyEntity.update(companyId, { import_batch_ids: merged });
}
