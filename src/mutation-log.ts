// Mutation-log helpers — wrap Base44 entity writes with a MutationLog row.
// See `MutationLogRecord` (Task 2) for the wire shape; consumers (sales-crm)
// must define a `MutationLog.jsonc` entity that matches it field-for-field.

/**
 * Compute a field-by-field diff between two plain-JSON records. Only fields
 * present in `after` are inspected. A field whose JSON.stringify is equal
 * before and after is skipped — the returned object contains only changed
 * fields, with `{ from, to }` pairs.
 *
 * Used by `loggedUpdate` to compute the `field_changes` map written to
 * MutationLog. Not exposed for general-purpose diffing — the JSON.stringify
 * equality is intentionally narrow to Base44's "all values are plain JSON"
 * domain. A Date object or class instance in an entity field could
 * false-positive; in practice Base44 entities are plain JSON.
 */
export function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const beforeVal = before[key];
    const afterVal = after[key];
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      diff[key] = { from: beforeVal, to: afterVal };
    }
  }
  return diff;
}
