// crm-helpers/src/upsert_test.ts
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0';
import {
  type UpsertEntity,
  upsertByKey,
  type UpsertOptions,
} from './upsert.ts';

interface Company {
  id: string;
  name?: string | null;
  domain?: string | null;
  name_normalized?: string | null;
  source?: string | null;
  created_by?: string | null;
  import_batch_ids?: string[];
  tags?: string[];
}

// In-memory fake entity client. Per-test reset; tracks every call so we can
// assert filter order, update vs create, and immutability.
function makeFakeEntity(initial: Company[] = []) {
  const rows: Record<string, Company> = {};
  let nextId = 1;
  for (const r of initial) {
    rows[r.id] = { ...r };
  }
  const calls: {
    filter: Array<{ where: Record<string, unknown>; sort: string; limit: number }>;
    create: Array<Record<string, unknown>>;
    update: Array<{ id: string; data: Record<string, unknown> }>;
  } = { filter: [], create: [], update: [] };

  const entity: UpsertEntity<Company> = {
    async filter(where, sort, limit) {
      calls.filter.push({ where, sort, limit });
      const matches: Company[] = [];
      for (const row of Object.values(rows)) {
        let isMatch = true;
        for (const [k, v] of Object.entries(where)) {
          if ((row as unknown as Record<string, unknown>)[k] !== v) {
            isMatch = false;
            break;
          }
        }
        if (isMatch) matches.push(row);
        if (limit && matches.length >= limit) break;
      }
      return matches;
    },
    async create(data) {
      calls.create.push(data);
      const id = `c_${nextId++}`;
      const row: Company = { id, ...(data as Partial<Company>) };
      rows[id] = row;
      return row;
    },
    async update(id, data) {
      calls.update.push({ id, data });
      rows[id] = { ...rows[id], ...(data as Partial<Company>) };
      return rows[id];
    },
  };

  return { entity, rows, calls };
}

Deno.test('upsertByKey: create path — no key matches → entity.create called', async () => {
  const { entity, calls } = makeFakeEntity();
  const opts: UpsertOptions<Company> = {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: 'Example', domain: 'example.com' },
  };
  const result = await upsertByKey(entity, opts);
  assertEquals(result.action, 'created');
  assertEquals(result.record.domain, 'example.com');
  assertEquals(calls.filter.length, 1);
  assertEquals(calls.create.length, 1);
  assertEquals(calls.update.length, 0);
  assertEquals(result.matchedKey, undefined);
});

Deno.test('upsertByKey: update path — first key matches → entity.update called', async () => {
  const { entity, calls } = makeFakeEntity([
    { id: 'c_existing', domain: 'example.com', name: null },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: 'Example Corp' },
  });
  assertEquals(result.action, 'updated');
  assertEquals(result.record.id, 'c_existing');
  assertEquals(result.record.name, 'Example Corp');
  assertEquals(result.matchedKey, { field: 'domain', value: 'example.com' });
  assertEquals(calls.update.length, 1);
  assertEquals(calls.create.length, 0);
});

Deno.test('upsertByKey: second key matches when first misses → filter called twice in order', async () => {
  const { entity, calls } = makeFakeEntity([
    { id: 'c_existing', name_normalized: 'example-corp', name: null },
  ]);
  const result = await upsertByKey(entity, {
    keys: [
      { field: 'domain', value: 'example.com' },
      { field: 'name_normalized', value: 'example-corp' },
    ],
    data: { name: 'Example Corp' },
  });
  assertEquals(result.action, 'updated');
  assertEquals(result.matchedKey?.field, 'name_normalized');
  // Verify order: domain first (miss), then name_normalized (hit).
  assertEquals(calls.filter.length, 2);
  assertEquals(Object.keys(calls.filter[0].where)[0], 'domain');
  assertEquals(Object.keys(calls.filter[1].where)[0], 'name_normalized');
});

Deno.test('upsertByKey: filter uses Base44 positional signature with limit=1', async () => {
  const { entity, calls } = makeFakeEntity();
  await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'x.com' }],
    data: { name: 'X' },
  });
  assertEquals(calls.filter[0].limit, 1);
  // Sort is part of the contract — oldest first so duplicates resolve
  // deterministically to the canonical row.
  assertEquals(calls.filter[0].sort, 'created_date');
});

Deno.test('upsertByKey: noop — fill_blanks merge with existing non-blank values', async () => {
  const { entity, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: 'Existing Name', source: 'manual' },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: 'Different Name', source: 'apollo' }, // both already filled
  });
  // fill_blanks default — nothing should be overwritten → noop.
  assertEquals(result.action, 'noop');
  assertEquals(result.record.name, 'Existing Name');
  assertEquals(calls.update.length, 0);
  assertEquals(result.matchedKey, { field: 'domain', value: 'example.com' });
});

Deno.test('upsertByKey: fill_blanks fills only blank fields', async () => {
  const { entity, rows } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: 'Existing', source: null },
  ]);
  await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: 'Should Not Overwrite', source: 'apollo' },
  });
  assertEquals(rows.c_1.name, 'Existing'); // not overwritten
  assertEquals(rows.c_1.source, 'apollo'); // filled because it was null
});

Deno.test('upsertByKey: overwrite mode writes every field', async () => {
  const { entity, rows } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: 'Existing', source: 'manual' },
  ]);
  await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: 'New', source: 'apollo' },
    merge: 'overwrite',
  });
  assertEquals(rows.c_1.name, 'New');
  assertEquals(rows.c_1.source, 'apollo');
});

Deno.test('upsertByKey: immutableFields preserved under overwrite', async () => {
  const { entity, rows } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: 'Existing', created_by: 'u_1' },
  ]);
  await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: 'New', created_by: 'u_2' },
    merge: 'overwrite',
    immutableFields: ['created_by'],
  });
  assertEquals(rows.c_1.name, 'New');
  assertEquals(rows.c_1.created_by, 'u_1'); // immutable, untouched
});

Deno.test('upsertByKey: immutableFields preserved under fill_blanks', async () => {
  // Even on fill_blanks, an immutable field that happens to be blank must not
  // be filled. Defense in depth: a caller might rely on the immutability
  // contract for fields like `import_batch_ids` that are always managed by a
  // dedicated helper.
  const { entity, rows } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', created_by: null },
  ]);
  await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { created_by: 'u_2' },
    merge: 'fill_blanks',
    immutableFields: ['created_by'],
  });
  assertEquals(rows.c_1.created_by, null);
});

Deno.test('upsertByKey: mergeArrays unions existing and incoming arrays', async () => {
  const { entity, rows } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', tags: ['a', 'b'] },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { tags: ['b', 'c'] }, // 'b' overlaps, 'c' is new
    merge: 'overwrite',
    mergeArrays: ['tags'],
  });
  assertEquals(result.action, 'updated');
  assertEquals(rows.c_1.tags, ['a', 'b', 'c']);
});

Deno.test('upsertByKey: mergeArrays noop when union equals existing', async () => {
  // Incoming tags are a subset of existing → no change → noop, no update.
  const { entity, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', tags: ['a', 'b', 'c'] },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { tags: ['a', 'b'] },
    merge: 'overwrite',
    mergeArrays: ['tags'],
  });
  assertEquals(result.action, 'noop');
  assertEquals(calls.update.length, 0);
});

Deno.test('upsertByKey: mergeArrays handles missing existing field as empty array', async () => {
  const { entity, rows } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com' }, // no tags field
  ]);
  await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { tags: ['a', 'b'] },
    merge: 'overwrite',
    mergeArrays: ['tags'],
  });
  assertEquals(rows.c_1.tags, ['a', 'b']);
});

Deno.test('upsertByKey: empty keys array throws', async () => {
  const { entity } = makeFakeEntity();
  await assertRejects(
    () =>
      upsertByKey(entity, {
        keys: [],
        data: { name: 'x' },
      }),
    Error,
    'at least one key',
  );
});

Deno.test('upsertByKey: noop when incoming data only contains immutable fields', async () => {
  const { entity, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', created_by: 'u_1' },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { created_by: 'u_2' },
    merge: 'overwrite',
    immutableFields: ['created_by'],
  });
  assertEquals(result.action, 'noop');
  assertEquals(calls.update.length, 0);
});

Deno.test('upsertByKey: overwrite mode is no-op when value is unchanged', async () => {
  const { entity, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: 'Same' },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: 'Same' },
    merge: 'overwrite',
  });
  // Same value → no update issued → noop.
  assertEquals(result.action, 'noop');
  assertEquals(calls.update.length, 0);
});

Deno.test('upsertByKey: fill_blanks treats empty arrays/objects/strings as blank', async () => {
  const { entity, rows } = makeFakeEntity([
    {
      id: 'c_1',
      domain: 'example.com',
      name: '',
      tags: [],
    },
  ]);
  await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: 'Filled', tags: ['t1'] },
    merge: 'fill_blanks',
  });
  assertEquals(rows.c_1.name, 'Filled');
  assertEquals(rows.c_1.tags, ['t1']);
});

Deno.test('upsertByKey: fill_blanks does not write blank → blank (skips no-op writes)', async () => {
  const { entity, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: null },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: null }, // blank → blank: nothing to write
    merge: 'fill_blanks',
  });
  assertEquals(result.action, 'noop');
  assertEquals(calls.update.length, 0);
});

// Regression: callers writing `{ name: maybeName }` where maybeName is
// undefined must not trigger an "updated" action and must not emit
// `patch[field] = undefined` (which JSON transports may silently drop).
// To explicitly clear a field, callers must pass `null`.
Deno.test('upsertByKey: overwrite skips undefined incoming values (no spurious update)', async () => {
  const { entity, rows, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: 'Existing Name' },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: undefined, source: undefined } as Partial<Company>,
    merge: 'overwrite',
  });
  assertEquals(result.action, 'noop');
  assertEquals(calls.update.length, 0);
  assertEquals(rows.c_1.name, 'Existing Name');
});

Deno.test('upsertByKey: overwrite — null is honored as explicit clear, undefined is not', async () => {
  const { entity, rows, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: 'Existing', source: 'apollo' },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: null, source: undefined } as Partial<Company>,
    merge: 'overwrite',
  });
  assertEquals(result.action, 'updated');
  assertEquals(calls.update.length, 1);
  // Only `name` was written; `source: undefined` was skipped.
  assertEquals(calls.update[0].data, { name: null });
  assertEquals(rows.c_1.name, null);
  assertEquals(rows.c_1.source, 'apollo');
});

// Regression: isBlank treats only plain {} as blank — class instances with no
// enumerable own keys (Date, Map, Set, custom classes) must be treated as
// meaningful values and NEVER overwritten under fill_blanks.
Deno.test('upsertByKey: fill_blanks treats Date as non-blank (not an empty object)', async () => {
  const existingDate = new Date('2025-01-01T00:00:00Z');
  interface CompanyWithDate extends Company {
    last_synced_at?: Date | null;
  }
  // Reuse the makeFakeEntity setup but with a Date field.
  const rows: Record<string, CompanyWithDate> = {
    c_1: { id: 'c_1', domain: 'example.com', last_synced_at: existingDate },
  };
  const calls = { update: [] as Array<{ id: string; data: Record<string, unknown> }> };
  const entity: UpsertEntity<CompanyWithDate> = {
    async filter(_where, _sort, _limit) {
      return Object.values(rows);
    },
    async create(data) {
      const id = `c_${Object.keys(rows).length + 1}`;
      const row: CompanyWithDate = {
        id,
        ...(data as Partial<CompanyWithDate>),
      };
      rows[id] = row;
      return row;
    },
    async update(id, data) {
      calls.update.push({ id, data });
      rows[id] = { ...rows[id], ...(data as Partial<CompanyWithDate>) };
      return rows[id];
    },
  };
  const result = await upsertByKey<CompanyWithDate>(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    // Try to overwrite the Date — but under fill_blanks the existing Date is
    // non-blank so the write should be skipped.
    data: { last_synced_at: new Date('2026-06-01T00:00:00Z') },
    merge: 'fill_blanks',
  });
  assertEquals(result.action, 'noop');
  assertEquals(calls.update.length, 0);
  // Existing Date is unchanged.
  assertEquals(rows.c_1.last_synced_at?.toISOString(), '2025-01-01T00:00:00.000Z');
});

// Regression: a key whose value is undefined/null/empty must NOT trigger a
// filter call. If undefined gets dropped during JSON transport, the filter
// would devolve into `{}` and match the first row in the table, causing an
// incorrect update on an unrelated row.
Deno.test('upsertByKey: skips keys with nullish/empty value, does not call filter', async () => {
  const { entity, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: 'Existing' },
  ]);
  const result = await upsertByKey(entity, {
    keys: [
      { field: 'domain', value: undefined },
      { field: 'name_normalized', value: null },
      { field: 'source', value: '' },
    ],
    data: { name: 'New', source: 'apollo' },
  });
  // All keys were nullish — fall through to create path.
  assertEquals(result.action, 'created');
  // Critically: NO filter calls were issued for the nullish keys.
  assertEquals(calls.filter.length, 0);
  assertEquals(calls.create.length, 1);
});

Deno.test('upsertByKey: mixed nullish + valid keys — only valid keys trigger filter', async () => {
  const { entity, calls } = makeFakeEntity([
    { id: 'c_1', name_normalized: 'example-corp', name: null },
  ]);
  const result = await upsertByKey(entity, {
    keys: [
      { field: 'domain', value: undefined }, // skip
      { field: 'name_normalized', value: 'example-corp' }, // valid
    ],
    data: { name: 'Example Corp' },
  });
  assertEquals(result.action, 'updated');
  assertEquals(calls.filter.length, 1);
  assertEquals(calls.filter[0].where.name_normalized, 'example-corp');
});

Deno.test('upsertByKey: fill_blanks — undefined incoming values are skipped (consistent with overwrite)', async () => {
  const { entity, rows, calls } = makeFakeEntity([
    { id: 'c_1', domain: 'example.com', name: null, source: null },
  ]);
  const result = await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'example.com' }],
    data: { name: undefined, source: 'apollo' } as Partial<Company>,
    merge: 'fill_blanks',
  });
  assertEquals(result.action, 'updated');
  assertEquals(calls.update.length, 1);
  // Only `source` filled the blank; `name: undefined` was skipped.
  assertEquals(calls.update[0].data, { source: 'apollo' });
  assertEquals(rows.c_1.source, 'apollo');
  assertEquals(rows.c_1.name, null);
});
