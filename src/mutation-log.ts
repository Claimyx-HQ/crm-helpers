// Mutation-log helpers — wrap Base44 entity writes with a MutationLog row.
// See `MutationLogRecord` (Task 2) for the wire shape; consumers (sales-crm)
// must define a `MutationLog.jsonc` entity that matches it field-for-field.

/**
 * A single field's change in a MutationLog row. `from` is the prior value
 * (or `undefined` if the field is new). `to` is the new value. Returned in
 * a `Record<string, FieldChange>` by `computeDiff` and stored under
 * `MutationLogRecord.field_changes`.
 */
export interface FieldChange {
  from: unknown;
  to: unknown;
}

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
 * Object key order also matters for the equality check (`{a,b}` ≠ `{b,a}`).
 * Base44 round-trips JSON with stable key order so this is low risk in
 * practice, but a manually-constructed `before` object could mismatch a
 * Base44-read `after` if the keys differ.
 */
export function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, FieldChange> {
  const diff: Record<string, FieldChange> = {};
  for (const key of Object.keys(after)) {
    const beforeVal = before[key];
    const afterVal = after[key];
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      diff[key] = { from: beforeVal, to: afterVal };
    }
  }
  return diff;
}

import type { WriteSource } from './activity.ts';

/**
 * Wire shape written to the sales-crm MutationLog entity. The sales-crm
 * `MutationLog.jsonc` MUST mirror these field names and types — every name
 * here is part of the cross-repo contract.
 */
export interface MutationLogRecord {
  entity_type: string;
  entity_id: string;
  mutation_type: 'create' | 'update' | 'delete';
  source: WriteSource;
  actor_id: string;
  field_changes: Record<string, FieldChange>;
  before_snapshot?: Record<string, unknown>;
  after_snapshot?: Record<string, unknown>;
}

/** Minimal Base44 entity client surface for update operations. */
export interface UpdatableEntity {
  update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  get(id: string): Promise<Record<string, unknown>>;
}

/** Minimal client surface for create operations. */
export interface CreatableEntity {
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Minimal client surface for delete operations. */
export interface DeletableEntity {
  delete(id: string): Promise<void>;
  get(id: string): Promise<Record<string, unknown>>;
}

/** The MutationLog entity client passed in via LoggedOptions.mutationLog. */
export interface LogEntity {
  create(record: MutationLogRecord): Promise<unknown>;
}

/**
 * Options passed to every logged* helper. `mutationLog` is the entity client
 * for writing the log row (injected so this module doesn't need to know
 * about a specific Base44 namespace). `fullSnapshots` controls whether
 * before_snapshot / after_snapshot are attached — defaults to true for
 * `llm`, `bulk_admin`, and `apollo_sync` sources (where override visibility
 * matters), false otherwise.
 */
export interface LoggedOptions {
  source: WriteSource;
  actor: string;
  mutationLog: LogEntity;
  fullSnapshots?: boolean;
  entityType?: string;
}

/**
 * Decide whether to attach full snapshots to a MutationLog row based on
 * source. Exposed for callers who want to query the default without setting
 * `fullSnapshots` explicitly.
 */
export function defaultFullSnapshots(source: WriteSource): boolean {
  return source === 'llm' || source === 'bulk_admin' || source === 'apollo_sync';
}

import { stampActivity } from './activity.ts';

/**
 * Wrap entity.update with a MutationLog write. Calls stampActivity to
 * enforce D2 (only `source === 'user'` stamps last_activity_at; non-user
 * sources have any accidental last_activity_at stripped from the payload).
 *
 * Returns the updated entity. Log-write failures are warned to console.warn
 * but do NOT throw — the entity write has already landed and we don't roll
 * back. Integrators that need stricter behavior can layer a retry on top.
 */
export async function loggedUpdate<T extends UpdatableEntity>(
  entity: T,
  id: string,
  updates: Record<string, unknown>,
  opts: LoggedOptions,
): Promise<Record<string, unknown>> {
  const nowIso = new Date().toISOString();
  const stamped = stampActivity(updates, nowIso, opts.source);

  // Snapshot the before state if needed; also needed for field_changes diff.
  const before = await entity.get(id);
  const updated = await entity.update(id, stamped);

  const fullSnapshots = opts.fullSnapshots ?? defaultFullSnapshots(opts.source);
  const entityType = opts.entityType ?? entity.constructor.name;

  const record: MutationLogRecord = {
    entity_type: entityType,
    entity_id: id,
    mutation_type: 'update',
    source: opts.source,
    actor_id: opts.actor,
    // Diff against `updates` (not `stamped`) so that stampActivity's
    // automatically-injected last_activity_at is NOT reported as a
    // field change — field_changes reflects what the caller intended to change.
    field_changes: computeDiff(before, updates),
  };
  if (fullSnapshots) {
    record.before_snapshot = before;
    record.after_snapshot = updated;
  }

  try {
    await opts.mutationLog.create(record);
  } catch (err) {
    console.warn(
      `[mutation-log] failed to write MutationLog row for ${entityType}:${id}: ${err}`,
    );
  }

  return updated;
}
