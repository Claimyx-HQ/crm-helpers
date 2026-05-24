// crm-helpers/src/activity.ts
// Write-source taxonomy + the `stampActivity` helper that decides whether
// a Lead.update / Company.update payload should carry `last_activity_at`.
//
// Rule (PM decision D2, 2026-05-24): ONLY `source === 'user'` stamps
// `last_activity_at`. Bulk admin actions, cron jobs, LLM writes, Apollo /
// Quo syncs, and imports MUST NOT stamp. The downstream consumer of this
// rule is `processQuoActivity`'s "did the human edit this lead after the
// call started?" check — a bulk stage edit on 200 leads must not mask the
// next call from the LLM-override guard.

/**
 * Canonical write-source taxonomy. Add new values here, NOT inline in
 * consumer code. Order is part of the contract — `MutationLog` and any
 * future analytics will use these as enum values.
 */
export const WRITE_SOURCES = [
  'user',         // a human clicked a UI control
  'bulk_admin',   // bulk select + bulk action (stage, owner, re-enrich)
  'cron',         // scheduled job (daily enrich, stuck-run cleanup)
  'llm',          // LLM-generated update (processQuoActivity verdict)
  'apollo_sync',  // background Apollo enrichment / discovery
  'quo_sync',     // syncQuoCalls write path
  'import',       // CSV / file import
] as const;

export type WriteSource = typeof WRITE_SOURCES[number];

/**
 * `true` only for explicit user-initiated UI clicks. Used by `stampActivity`
 * and by any other code that needs to distinguish "human edited this" from
 * "an automation edited this." Bulk admin is intentionally NOT user-initiated
 * (PM decision D2).
 */
export function isUserInitiated(source: WriteSource): boolean {
  return source === 'user';
}

/**
 * Return a NEW updates object with `last_activity_at` stamped iff source is
 * user-initiated. Defense in depth: if `source` is non-user, any explicit
 * `last_activity_at` in `updates` is stripped so accidental inclusion can't
 * silently break the AI-override guard.
 *
 * Intended call pattern:
 *
 *   await Lead.update(id, stampActivity({ stage: 'Demo Booked' }, new Date().toISOString(), 'user'));
 *
 * Does NOT mutate `updates`.
 */
export function stampActivity<T extends Record<string, unknown>>(
  updates: T,
  timestampIso: string,
  source: WriteSource,
): T & { last_activity_at?: string } {
  if (isUserInitiated(source)) {
    // Preserve an explicit last_activity_at if the caller already supplied
    // one (e.g. backfill from a known event time); otherwise stamp `ts`.
    if ('last_activity_at' in updates && updates.last_activity_at != null) {
      return { ...updates };
    }
    return { ...updates, last_activity_at: timestampIso };
  }
  // Non-user: strip any accidental last_activity_at in the payload.
  if ('last_activity_at' in updates) {
    const { last_activity_at: _drop, ...rest } = updates as Record<string, unknown>;
    return rest as T;
  }
  return { ...updates };
}
