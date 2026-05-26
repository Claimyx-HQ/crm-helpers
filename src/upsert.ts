// crm-helpers/src/upsert.ts
// Natural-key upsert helper. Base44 has no unique-constraint primitive
// (see flow-catalog research 14a) — dedup must happen at application level
// before every create. `upsertByKey` is the canonical implementation:
// try a prioritized list of natural keys, update on hit, create on miss.
//
// Intended call pattern in consumers (sales-crm imports, Apollo sync, etc.):
//
//   const result = await upsertByKey(Company, {
//     keys: [
//       { field: 'domain', value: 'example.com' },
//       { field: 'name_normalized', value: 'example-corp' },
//     ],
//     data: { name: 'Example Corp', domain: 'example.com', source: 'apollo' },
//     merge: 'fill_blanks',
//     immutableFields: ['created_by', 'import_batch_ids'],
//     mergeArrays: ['tags'],
//   });
//   // result.action ∈ 'created' | 'updated' | 'noop'
//   // result.record is the resulting row (post-update or freshly created)

/**
 * A single natural-key candidate used by `upsertByKey`. The first key in the
 * `keys[]` array that matches an existing row wins.
 *
 * `field` is the entity field name (a key of `T`). `value` is the value to
 * match — typed `unknown` because the comparison happens server-side via
 * `entity.filter` and the SDK accepts arbitrary JSON-comparable values.
 */
export interface UpsertKey<T> {
  field: keyof T & string;
  value: unknown;
}

/**
 * Options for `upsertByKey`.
 *
 * - `keys`: prioritized list of natural keys. First match wins.
 * - `data`: payload to merge (update) or insert (create).
 * - `merge`:
 *     - `'fill_blanks'` (default): only write fields where the existing value
 *       is null/undefined/empty — never overwrite a non-blank existing value.
 *     - `'overwrite'`: write every field in `data` regardless of existing
 *       value, except those listed in `immutableFields`.
 * - `immutableFields`: fields that must NEVER be overwritten on update
 *   (e.g. `created_by`, import-owned columns). Honored under both merge modes.
 * - `mergeArrays`: array-valued fields that should be unioned with the
 *   existing array rather than replaced. Order is preserved: existing values
 *   first, then any new values not already present.
 */
export interface UpsertOptions<T> {
  keys: UpsertKey<T>[];
  data: Partial<T>;
  merge?: 'fill_blanks' | 'overwrite';
  immutableFields?: (keyof T & string)[];
  mergeArrays?: (keyof T & string)[];
}

/**
 * Result of `upsertByKey`.
 *
 * - `action`:
 *     - `'created'`: no key matched; a new row was inserted via `entity.create`.
 *     - `'updated'`: a key matched and at least one field changed.
 *     - `'noop'`: a key matched but the computed patch was empty (e.g. every
 *       field in `data` was either blocked by `immutableFields`, already
 *       equal under `fill_blanks`, or absent from the patch). No write was
 *       issued.
 * - `record`: the resulting entity row (post-update, freshly created, or
 *   the existing row on noop).
 * - `matchedKey`: which key from `options.keys` matched (only set on
 *   `'updated'` and `'noop'`).
 */
export interface UpsertResult<T> {
  action: 'created' | 'updated' | 'noop';
  record: T;
  matchedKey?: UpsertKey<T>;
}

/**
 * Minimal entity-client surface required by `upsertByKey`. Mirrors the Base44
 * SDK shape — `filter` returns rows matching a query object, `create` inserts
 * a new row, `update` patches an existing row by id. Typed permissively
 * (`Record<string, unknown>` over `T`) because the SDK types in @base44/sdk
 * are themselves loose; consumers pass their typed wrapper and the result is
 * cast to `T` at the boundary.
 */
export interface UpsertEntity<T extends { id: string }> {
  filter(
    query: Record<string, unknown>,
    options?: { limit?: number },
  ): Promise<T[]>;
  create(data: Record<string, unknown>): Promise<T>;
  update(id: string, data: Record<string, unknown>): Promise<T>;
}

/**
 * Treat a value as "blank" for `merge: 'fill_blanks'` purposes. Blank means
 * null, undefined, empty string, empty array, or empty plain object. Other
 * falsy primitives (`0`, `false`) are NOT blank — they're meaningful values.
 *
 * Mirrors `isBlankCell` from `./text.ts` semantically, kept inline to avoid a
 * cross-module import cycle and to give this helper a self-contained dedup
 * contract.
 */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Union two array values, preserving order: existing entries first, then any
 * new entries not already present. Equality is by `JSON.stringify` so nested
 * objects compare structurally. Falls back to wrapping a non-array existing
 * value as `[existing]`.
 */
function unionArrays(existing: unknown, incoming: unknown): unknown[] {
  const left = Array.isArray(existing)
    ? existing
    : existing === undefined || existing === null
    ? []
    : [existing];
  const right = Array.isArray(incoming)
    ? incoming
    : incoming === undefined || incoming === null
    ? []
    : [incoming];
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of [...left, ...right]) {
    const key = JSON.stringify(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Build the update patch for a matched existing row based on the merge
 * strategy, immutability rules, and array-union list. Returns the keys/values
 * to actually write — empty object means no-op (caller skips the update call
 * entirely).
 */
function buildUpdatePatch<T extends { id: string }>(
  existing: T,
  data: Partial<T>,
  merge: 'fill_blanks' | 'overwrite',
  immutableFields: (keyof T & string)[],
  mergeArrays: (keyof T & string)[],
): Record<string, unknown> {
  const immutable = new Set<string>(immutableFields);
  const arrayUnion = new Set<string>(mergeArrays);
  const patch: Record<string, unknown> = {};
  const existingRow = existing as Record<string, unknown>;

  for (const [field, incomingValue] of Object.entries(data)) {
    if (immutable.has(field)) continue;
    // Treat `undefined` as "field not provided" — callers writing
    // `{ name: maybeName }` with `maybeName === undefined` should not trigger
    // an "updated" action and should not emit `patch[field] = undefined`
    // (which JSON-transports may silently drop). To explicitly clear a field,
    // callers must pass `null`.
    if (incomingValue === undefined) continue;
    const existingValue = existingRow[field];

    if (arrayUnion.has(field)) {
      const merged = unionArrays(existingValue, incomingValue);
      // Only emit when the union actually differs from the existing array.
      if (JSON.stringify(merged) !== JSON.stringify(existingValue ?? [])) {
        patch[field] = merged;
      }
      continue;
    }

    if (merge === 'fill_blanks') {
      // Only write if existing value is blank — never overwrite a non-blank
      // existing value under fill_blanks.
      if (isBlank(existingValue)) {
        // And only if the incoming value itself is not blank — there's
        // nothing to gain by writing blank → blank.
        if (!isBlank(incomingValue)) {
          patch[field] = incomingValue;
        }
      }
      continue;
    }

    // merge === 'overwrite': always write, except when the value is identical
    // (saves a server round-trip for a no-op write).
    if (JSON.stringify(existingValue) !== JSON.stringify(incomingValue)) {
      patch[field] = incomingValue;
    }
  }

  return patch;
}

/**
 * Upsert an entity row by trying a prioritized list of natural keys, then
 * either updating the first matching row or creating a new row if none match.
 *
 * Base44 has no unique-constraint primitive (see flow-catalog research 14a) —
 * this is the canonical application-level dedup helper. Consumers should
 * always go through `upsertByKey` for entities that need natural-key
 * deduplication (Companies on domain/name, Leads on email/phone, etc.)
 * rather than rolling their own filter+create paths.
 *
 * Behavior:
 *   1. For each key in `options.keys` (in order), call
 *      `entity.filter({ [field]: value }, { limit: 1 })`.
 *   2. The first key that returns a row wins. The existing row is updated
 *      according to `merge` strategy:
 *        - `'fill_blanks'` (default): only write fields where the existing
 *          value is null/undefined/empty.
 *        - `'overwrite'`: write every field in `data`, except those in
 *          `immutableFields`.
 *   3. `mergeArrays` fields get array-union (existing ∪ new) rather than
 *      replacement. Useful for `import_batch_ids`, tag lists, etc.
 *   4. If the computed patch is empty after merge rules, no update is
 *      issued and `action` is `'noop'`.
 *   5. If no key matches, `entity.create(data)` is called and `action` is
 *      `'created'`.
 *
 * Throws on:
 *   - Empty `options.keys` array (degenerate — caller wants a plain create).
 *   - Underlying entity SDK errors (propagated as-is).
 */
export async function upsertByKey<T extends { id: string }>(
  entity: UpsertEntity<T>,
  options: UpsertOptions<T>,
): Promise<UpsertResult<T>> {
  if (!options.keys || options.keys.length === 0) {
    throw new Error(
      '[upsertByKey] options.keys must contain at least one key — for plain create, call entity.create directly',
    );
  }

  const merge = options.merge ?? 'fill_blanks';
  const immutableFields = options.immutableFields ?? [];
  const mergeArrays = options.mergeArrays ?? [];

  // Try each key in priority order until one matches.
  for (const key of options.keys) {
    const matches = await entity.filter(
      { [key.field]: key.value },
      { limit: 1 },
    );
    const existing = matches?.[0];
    if (!existing) continue;

    const patch = buildUpdatePatch(
      existing,
      options.data,
      merge,
      immutableFields,
      mergeArrays,
    );

    if (Object.keys(patch).length === 0) {
      return { action: 'noop', record: existing, matchedKey: key };
    }

    const updated = await entity.update(existing.id, patch);
    return { action: 'updated', record: updated, matchedKey: key };
  }

  // No key matched — create a new row.
  const created = await entity.create(options.data as Record<string, unknown>);
  return { action: 'created', record: created };
}
