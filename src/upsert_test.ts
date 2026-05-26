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
    filter: Array<{ query: Record<string, unknown>; limit?: number }>;
    create: Array<Record<string, unknown>>;
    update: Array<{ id: string; data: Record<string, unknown> }>;
  } = { filter: [], create: [], update: [] };

  const entity: UpsertEntity<Company> = {
    async filter(query, options) {
      calls.filter.push({ query, limit: options?.limit });
      const matches: Company[] = [];
      for (const row of Object.values(rows)) {
        let isMatch = true;
        for (const [k, v] of Object.entries(query)) {
          if ((row as unknown as Record<string, unknown>)[k] !== v) {
            isMatch = false;
            break;
          }
        }
        if (isMatch) matches.push(row);
        if (options?.limit && matches.length >= options.limit) break;
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
  assertEquals(Object.keys(calls.filter[0].query)[0], 'domain');
  assertEquals(Object.keys(calls.filter[1].query)[0], 'name_normalized');
});

Deno.test('upsertByKey: filter uses limit:1 for cheap lookups', async () => {
  const { entity, calls } = makeFakeEntity();
  await upsertByKey(entity, {
    keys: [{ field: 'domain', value: 'x.com' }],
    data: { name: 'X' },
  });
  assertEquals(calls.filter[0].limit, 1);
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
