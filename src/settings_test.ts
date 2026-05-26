// crm-helpers/src/settings_test.ts
import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  _settingsCacheSize,
  clearSettingsCache,
  getSetting,
  type SettingEntity,
  type SettingRecord,
} from './settings.ts';

// Fake Setting entity client. Each test should call clearSettingsCache()
// before exercising the helper so module-level cache state doesn't bleed.
function makeFakeSetting(rows: SettingRecord[] = []) {
  const calls: {
    filter: Array<{ where: Record<string, unknown>; sort: string; limit: number }>;
  } = {
    filter: [],
  };
  const entity: SettingEntity = {
    async filter(where, sort, limit) {
      calls.filter.push({ where, sort, limit });
      return rows.filter((r) => r.key === where.key);
    },
  };
  return { entity, calls };
}

Deno.test('getSetting: returns cached value on subsequent calls (cache hit)', async () => {
  clearSettingsCache();
  const { entity, calls } = makeFakeSetting([
    {
      id: 's_1',
      key: 'orchestrator_run_ttl_minutes',
      value_type: 'duration_minutes',
      value: 30,
      default_value: 30,
    },
  ]);
  const v1 = await getSetting<number>(entity, 'orchestrator_run_ttl_minutes', 60);
  const v2 = await getSetting<number>(entity, 'orchestrator_run_ttl_minutes', 60);
  assertEquals(v1, 30);
  assertEquals(v2, 30);
  // Filter was called exactly once — the second call hit the cache.
  assertEquals(calls.filter.length, 1);
});

Deno.test('getSetting: cache miss re-reads from entity', async () => {
  clearSettingsCache();
  const { entity, calls } = makeFakeSetting([
    {
      id: 's_1',
      key: 'k1',
      value_type: 'number',
      value: 5,
      default_value: 5,
    },
  ]);
  await getSetting<number>(entity, 'k1', 0);
  clearSettingsCache(); // simulate expiry
  await getSetting<number>(entity, 'k1', 0);
  assertEquals(calls.filter.length, 2);
});

Deno.test('getSetting: cache respects TTL — expired entries trigger re-read', async () => {
  clearSettingsCache();
  const { entity, calls } = makeFakeSetting([
    { id: 's_1', key: 'k', value_type: 'number', value: 1, default_value: 1 },
  ]);
  await getSetting<number>(entity, 'k', 0, { cacheTtlSeconds: 0.01 }); // 10ms TTL
  await new Promise((r) => setTimeout(r, 25));
  await getSetting<number>(entity, 'k', 0, { cacheTtlSeconds: 0.01 });
  // Both calls hit the entity — the cached value expired between them.
  assertEquals(calls.filter.length, 2);
});

// Regression: expired entries must be evicted from the Map on the next
// read, otherwise a long-running worker that iterates over many distinct
// keys would grow the cache unboundedly.
Deno.test('getSetting: expired entries are evicted from cache on next read', async () => {
  clearSettingsCache();
  const { entity: e1 } = makeFakeSetting([
    { id: 's_1', key: 'k1', value_type: 'number', value: 1, default_value: 1 },
  ]);
  const { entity: e2 } = makeFakeSetting([
    { id: 's_2', key: 'k2', value_type: 'number', value: 2, default_value: 2 },
  ]);
  // Seed the cache with 2 entries on a 10ms TTL.
  await getSetting<number>(e1, 'k1', 0, { cacheTtlSeconds: 0.01 });
  await getSetting<number>(e2, 'k2', 0, { cacheTtlSeconds: 0.01 });
  assertEquals(_settingsCacheSize(), 2);

  // Wait until both expire.
  await new Promise((r) => setTimeout(r, 25));

  // Re-read only k1. The expired k1 entry should be evicted, then the fresh
  // value re-cached. k2 stays expired-but-still-in-map until its own read.
  await getSetting<number>(e1, 'k1', 0, { cacheTtlSeconds: 0.01 });
  // k1 was evicted then re-added → still 1 entry for k1, plus the stale k2.
  // (eviction happens on access; we never touched k2 again so it stays.)
  assertEquals(_settingsCacheSize(), 2);

  // Re-read k2 after it's also expired. Same eviction-then-rewrite path.
  await getSetting<number>(e2, 'k2', 0, { cacheTtlSeconds: 0.01 });
  assertEquals(_settingsCacheSize(), 2);

  // Now wait again until both expire, then read with a missing row that
  // should NOT cache. The expired entry must still be evicted, so cache
  // size drops.
  await new Promise((r) => setTimeout(r, 25));
  const { entity: empty } = makeFakeSetting([]); // no rows
  await getSetting<number>(empty, 'k1', 0, { cacheTtlSeconds: 0.01 });
  // k1 was expired → evicted; missing row → not re-cached. Only k2 remains.
  assertEquals(_settingsCacheSize(), 1);
});

Deno.test('getSetting: cacheTtlSeconds=0 bypasses cache entirely', async () => {
  clearSettingsCache();
  const { entity, calls } = makeFakeSetting([
    { id: 's_1', key: 'k', value_type: 'number', value: 1, default_value: 1 },
  ]);
  await getSetting<number>(entity, 'k', 0, { cacheTtlSeconds: 0 });
  await getSetting<number>(entity, 'k', 0, { cacheTtlSeconds: 0 });
  await getSetting<number>(entity, 'k', 0, { cacheTtlSeconds: 0 });
  // Every call hits the entity.
  assertEquals(calls.filter.length, 3);
});

Deno.test('getSetting: returns fallbackDefault when row is missing', async () => {
  clearSettingsCache();
  const { entity, calls } = makeFakeSetting([]); // no rows
  const result = await getSetting<number>(entity, 'missing_key', 99);
  assertEquals(result, 99);
  assertEquals(calls.filter.length, 1);
});

Deno.test('getSetting: missing row is NOT cached — next call re-reads', async () => {
  clearSettingsCache();
  const { entity, calls } = makeFakeSetting([]);
  await getSetting<number>(entity, 'k', 5);
  await getSetting<number>(entity, 'k', 5);
  // Both calls re-read because the absence was not cached. This is the
  // documented contract: if the row appears later, the next call should
  // pick it up.
  assertEquals(calls.filter.length, 2);
});

Deno.test('getSetting: returns fallbackDefault on type-mismatch (warns)', async () => {
  clearSettingsCache();
  // value is a string but value_type is 'number' — invalid.
  const { entity, calls } = makeFakeSetting([
    {
      id: 's_1',
      key: 'k',
      value_type: 'number',
      value: 'not a number',
      default_value: 5,
    },
  ]);
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  let result: number;
  try {
    result = await getSetting<number>(entity, 'k', 5);
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(result, 5);
  assertEquals(warnings.length, 1);
  // Invalid values are NOT cached.
  await getSetting<number>(entity, 'k', 5).catch(() => {});
  assertEquals(calls.filter.length, 2);
});

Deno.test('getSetting: number with min_value/max_value — out of range → invalid → fallback', async () => {
  clearSettingsCache();
  const { entity } = makeFakeSetting([
    {
      id: 's_1',
      key: 'k',
      value_type: 'number',
      value: 5,
      default_value: 10,
      min_value: 10,
      max_value: 100,
    },
  ]);
  const originalWarn = console.warn;
  console.warn = () => {};
  let result: number;
  try {
    result = await getSetting<number>(entity, 'k', 10);
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(result, 10); // fallback because 5 < min_value 10
});

Deno.test('getSetting: number within min_value/max_value range → valid', async () => {
  clearSettingsCache();
  const { entity } = makeFakeSetting([
    {
      id: 's_1',
      key: 'k',
      value_type: 'number',
      value: 50,
      default_value: 10,
      min_value: 10,
      max_value: 100,
    },
  ]);
  const result = await getSetting<number>(entity, 'k', 10);
  assertEquals(result, 50);
});

Deno.test('getSetting: duration_minutes — returns raw number (helper does not unit-convert)', async () => {
  // Per docstring: the helper does NOT multiply minutes into milliseconds.
  // It returns the raw declared value; the caller knows the unit.
  clearSettingsCache();
  const { entity } = makeFakeSetting([
    {
      id: 's_1',
      key: 'k',
      value_type: 'duration_minutes',
      value: 30,
      default_value: 30,
    },
  ]);
  const result = await getSetting<number>(entity, 'k', 60);
  assertEquals(result, 30);
});

Deno.test('getSetting: duration_days — also raw number with min/max validation', async () => {
  clearSettingsCache();
  const { entity } = makeFakeSetting([
    {
      id: 's_1',
      key: 'k',
      value_type: 'duration_days',
      value: 7,
      default_value: 7,
      min_value: 1,
      max_value: 30,
    },
  ]);
  const result = await getSetting<number>(entity, 'k', 14);
  assertEquals(result, 7);
});

Deno.test('getSetting: boolean — type-validated', async () => {
  clearSettingsCache();
  const { entity } = makeFakeSetting([
    {
      id: 's_1',
      key: 'enable_x',
      value_type: 'boolean',
      value: true,
      default_value: false,
    },
  ]);
  const result = await getSetting<boolean>(entity, 'enable_x', false);
  assertEquals(result, true);
});

Deno.test('getSetting: stage_id and user_id — string validation', async () => {
  clearSettingsCache();
  const { entity } = makeFakeSetting([
    {
      id: 's_1',
      key: 'default_stage',
      value_type: 'stage_id',
      value: 'stage_new',
      default_value: 'stage_new',
    },
    {
      id: 's_2',
      key: 'default_owner',
      value_type: 'user_id',
      value: 'u_admin',
      default_value: 'u_admin',
    },
  ]);
  assertEquals(
    await getSetting<string>(entity, 'default_stage', 'stage_other'),
    'stage_new',
  );
  assertEquals(
    await getSetting<string>(entity, 'default_owner', 'u_other'),
    'u_admin',
  );
});

Deno.test('getSetting: clearSettingsCache resets cached state', async () => {
  clearSettingsCache();
  const { entity, calls } = makeFakeSetting([
    { id: 's_1', key: 'k', value_type: 'number', value: 1, default_value: 1 },
  ]);
  await getSetting<number>(entity, 'k', 0);
  await getSetting<number>(entity, 'k', 0); // cache hit
  assertEquals(calls.filter.length, 1);
  clearSettingsCache();
  await getSetting<number>(entity, 'k', 0); // cache miss after clear
  assertEquals(calls.filter.length, 2);
});

Deno.test('getSetting: NaN / Infinity values are invalid (number)', async () => {
  clearSettingsCache();
  const { entity } = makeFakeSetting([
    {
      id: 's_1',
      key: 'k',
      value_type: 'number',
      value: Number.POSITIVE_INFINITY,
      default_value: 0,
    },
  ]);
  const originalWarn = console.warn;
  console.warn = () => {};
  let result: number;
  try {
    result = await getSetting<number>(entity, 'k', 42);
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(result, 42); // fallback because Infinity is not finite
});

Deno.test('getSetting: filter is called with Base44 positional signature (sort + limit=1)', async () => {
  clearSettingsCache();
  const { entity, calls } = makeFakeSetting([
    { id: 's_1', key: 'k', value_type: 'number', value: 1, default_value: 1 },
  ]);
  await getSetting<number>(entity, 'k', 0);
  assertEquals(calls.filter[0].limit, 1);
  // Newest-first so the most-recently-written Setting wins if duplicates exist.
  assertEquals(calls.filter[0].sort, '-created_date');
});
