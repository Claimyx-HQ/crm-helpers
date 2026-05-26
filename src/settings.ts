// crm-helpers/src/settings.ts
// `getSetting<T>` — typed reader for the sales-crm Setting entity with a
// small in-process cache so hot-path callers (orchestrator loops, retry
// timers) don't hit the SDK on every invocation.
//
// Intended call pattern in consumers:
//
//   import { getSetting } from '@claimyx/crm-helpers/settings';
//   const ttlMinutes = await getSetting<number>(
//     Setting,
//     'orchestrator_run_ttl_minutes',
//     30, // fallback default
//   );
//
// Cache TTL defaults to 60s. Pass `cacheTtlSeconds: 0` to bypass cache
// (useful for tests and for one-shot scripts that just need the current
// value). Each Deno worker has its own in-process cache — that's fine for
// settings, which change rarely and don't need cross-worker invalidation.

/**
 * Canonical value-type taxonomy for the Setting entity. The SET of allowed
 * string literals is the contract — Setting rows persist `value_type` as a
 * string, so adding or removing a literal here is a coordinated change
 * (sales-crm Setting entity definition + any consumer's runtime validation).
 * The ORDER of literals in this union has no runtime meaning.
 *
 *   - `number`: a JSON number, validated against optional min/max.
 *   - `string`: a JSON string.
 *   - `boolean`: a JSON boolean.
 *   - `duration_minutes` / `duration_days`: numbers that the consumer will
 *     multiply into milliseconds / seconds as needed. The helper itself
 *     does NOT do unit conversion — `getSetting<number>` returns the raw
 *     value and the caller knows the unit from the value_type.
 *   - `stage_id`: a string referring to a Stage entity id. Treated as
 *     `string` for validation.
 *   - `user_id`: a string referring to a User entity id. Treated as
 *     `string` for validation.
 */
export type SettingValueType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'duration_minutes'
  | 'duration_days'
  | 'stage_id'
  | 'user_id';

/**
 * Wire shape for the sales-crm Setting entity. sales-crm's `Setting.jsonc`
 * MUST mirror these field names — every name here is part of the cross-repo
 * contract.
 *
 * `default_value` is the application-side default the row was created with;
 * `value` is the current effective value. `min_value` / `max_value` apply
 * only to numeric `value_type`s and are optional.
 */
export interface SettingRecord {
  id: string;
  key: string;
  value_type: SettingValueType;
  value: unknown;
  default_value: unknown;
  min_value?: number;
  max_value?: number;
}

/**
 * Options for `getSetting`.
 *
 * - `cacheTtlSeconds`: override the default 60s cache TTL. Pass `0` to
 *   bypass the cache (always re-read from the entity).
 */
export interface GetSettingOptions {
  cacheTtlSeconds?: number;
}

/**
 * Minimal entity-client surface required by `getSetting`. Mirrors the
 * Base44 SDK shape: `filter(where, sort, limit)` is the established
 * positional signature in this repo (see `chunkedEntityScan` in
 * `./base44.ts`). `sort` is a Base44 sort string — `'-created_date'` to
 * pick the most-recent row if duplicates exist.
 */
export interface SettingEntity {
  filter(
    where: Record<string, unknown>,
    sort: string,
    limit: number,
  ): Promise<SettingRecord[]>;
}

// Sort used by the Setting lookup. Newest-first so the most-recently-written
// Setting row wins if duplicates exist (Base44 has no unique constraints —
// see flow-catalog research 14a).
const SETTINGS_LOOKUP_SORT = '-created_date';

// In-process cache. Keyed on the Setting key. Each Deno worker has its own
// instance — that's fine because settings change rarely and the cost of a
// stale value for up to 60s is bounded.
//
// Stored value is the raw cell + its expiry timestamp (epoch ms). Invalid
// rows fall back to the caller's `fallbackDefault` and are NOT cached, so
// that fixing the row (or adding it) takes effect on the next call.
const cache = new Map<string, { value: unknown; expiresAt: number }>();

const DEFAULT_CACHE_TTL_SECONDS = 60;

/**
 * Validate a Setting row's `value` against its declared `value_type`,
 * `min_value`, and `max_value`. Returns the validated value on success or
 * the symbol `INVALID` on failure (so the caller can branch on validity
 * without conflating "value is `null`" with "value is invalid").
 */
const INVALID = Symbol('invalid');
function validateSettingValue(
  row: SettingRecord,
): unknown | typeof INVALID {
  const { value, value_type, min_value, max_value } = row;
  switch (value_type) {
    case 'number':
    case 'duration_minutes':
    case 'duration_days': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return INVALID;
      if (min_value !== undefined && value < min_value) return INVALID;
      if (max_value !== undefined && value > max_value) return INVALID;
      return value;
    }
    case 'string':
    case 'stage_id':
    case 'user_id': {
      if (typeof value !== 'string') return INVALID;
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return INVALID;
      return value;
    }
    default: {
      // Unknown value_type — be permissive (returning the raw value) so
      // adding a new type in sales-crm doesn't break already-deployed
      // workers that haven't updated this helper yet.
      return value;
    }
  }
}

/**
 * Read a Setting value by key, with type validation, range checking, and a
 * small in-process cache.
 *
 * Behavior:
 *   1. Check the in-process cache. If present and not expired, return the
 *      cached value.
 *   2. Otherwise, call `settingEntity.filter({ key }, '-created_date', 1)`.
 *   3. If no row exists, return `fallbackDefault` and cache nothing — so
 *      the row appears if added later.
 *   4. If the row exists, validate `value` against `value_type` and
 *      `min_value` / `max_value`. On validation failure: warn to console,
 *      return `fallbackDefault`, cache nothing (so a fix in the row takes
 *      effect on the next call).
 *   5. On success: cache the value for `cacheTtlSeconds` (default 60s) and
 *      return it.
 *
 * Bypass the cache by passing `cacheTtlSeconds: 0` — useful for tests and
 * for one-shot scripts.
 *
 * Type parameter `T` is purely a return-type hint — there is no runtime
 * cast beyond the per-`value_type` validation in `validateSettingValue`.
 * Caller is responsible for the T choice matching the registered
 * `value_type` (e.g. `getSetting<number>(..., 'orchestrator_run_ttl_minutes', 30)`
 * for a number-typed setting).
 */
export async function getSetting<T = unknown>(
  settingEntity: SettingEntity,
  key: string,
  fallbackDefault: T,
  options?: GetSettingOptions,
): Promise<T> {
  const ttlSeconds = options?.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  const now = Date.now();

  if (ttlSeconds > 0) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }
    // Evict expired entries so a long-running Deno worker that iterates over
    // many distinct setting keys doesn't grow the Map unboundedly.
    if (cached) cache.delete(key);
  }

  const matches = await settingEntity.filter({ key }, SETTINGS_LOOKUP_SORT, 1);
  const row = matches?.[0];
  if (!row) {
    // No row → use the caller's fallback. Do NOT cache the absence; if
    // someone adds the row later, the next call should pick it up.
    return fallbackDefault;
  }

  const validated = validateSettingValue(row);
  if (validated === INVALID) {
    console.warn(
      `[settings] Setting '${key}' has invalid value for value_type='${row.value_type}'; returning fallback`,
    );
    // Do not cache invalid values — fixing the row takes effect immediately.
    return fallbackDefault;
  }

  if (ttlSeconds > 0) {
    cache.set(key, {
      value: validated,
      expiresAt: now + ttlSeconds * 1000,
    });
  }
  return validated as T;
}

/**
 * Clear the in-process settings cache. Intended for tests and for explicit
 * "force-refresh" call sites (e.g. an admin UI that just changed a setting
 * and wants the next read to bypass the 60s window). Not part of the
 * hot-path API — callers should prefer `cacheTtlSeconds: 0` on a specific
 * read if they just want to bypass once.
 */
export function clearSettingsCache(): void {
  cache.clear();
}

/**
 * Internal: current number of entries in the in-process settings cache.
 * Exported for tests that need to verify expiry-eviction behavior. Not part
 * of the supported API — do not use from application code.
 */
export function _settingsCacheSize(): number {
  return cache.size;
}
