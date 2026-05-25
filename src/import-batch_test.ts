// crm-helpers/src/import-batch_test.ts
import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  appendImportBatchId,
  type ImportBatchEntity,
} from './import-batch.ts';

interface Company {
  id: string;
  name?: string;
  import_batch_ids?: string[];
}

function makeFakeCompany(initial: Company) {
  const store: Record<string, Company> = { [initial.id]: { ...initial } };
  const calls: { get: string[]; update: Array<{ id: string; data: Record<string, unknown> }> } = {
    get: [],
    update: [],
  };
  const entity: ImportBatchEntity<Company> = {
    async get(id) {
      calls.get.push(id);
      return store[id];
    },
    async update(id, data) {
      calls.update.push({ id, data });
      store[id] = { ...store[id], ...(data as Partial<Company>) };
      return store[id];
    },
  };
  return { entity, store, calls };
}

Deno.test('appendImportBatchId: appends when missing', async () => {
  const { entity, store, calls } = makeFakeCompany({
    id: 'c_1',
    import_batch_ids: ['batch_old'],
  });
  const result = await appendImportBatchId(entity, 'c_1', 'batch_new');
  assertEquals(result.import_batch_ids, ['batch_old', 'batch_new']);
  assertEquals(store.c_1.import_batch_ids, ['batch_old', 'batch_new']);
  assertEquals(calls.update.length, 1);
});

Deno.test('appendImportBatchId: no-op when batch already present', async () => {
  const { entity, calls } = makeFakeCompany({
    id: 'c_1',
    import_batch_ids: ['batch_a', 'batch_b'],
  });
  const result = await appendImportBatchId(entity, 'c_1', 'batch_a');
  // No update call should have been issued.
  assertEquals(calls.update.length, 0);
  // Returned company is the freshly-read row, unchanged.
  assertEquals(result.import_batch_ids, ['batch_a', 'batch_b']);
});

Deno.test('appendImportBatchId: missing import_batch_ids field treated as empty array', async () => {
  // Old companies created before the import-tracking feature don't have
  // import_batch_ids at all. We must not throw.
  const { entity, store } = makeFakeCompany({ id: 'c_old' });
  const result = await appendImportBatchId(entity, 'c_old', 'batch_first');
  assertEquals(result.import_batch_ids, ['batch_first']);
  assertEquals(store.c_old.import_batch_ids, ['batch_first']);
});

Deno.test('appendImportBatchId: non-array import_batch_ids treated as empty', async () => {
  // Defensive: a corrupted row with import_batch_ids: null should not throw.
  const store: Record<string, Company> = {
    c_1: { id: 'c_1', import_batch_ids: null as unknown as string[] },
  };
  const entity: ImportBatchEntity<Company> = {
    async get(id) { return store[id]; },
    async update(id, data) {
      store[id] = { ...store[id], ...(data as Partial<Company>) };
      return store[id];
    },
  };
  const result = await appendImportBatchId(entity, 'c_1', 'batch_x');
  assertEquals(result.import_batch_ids, ['batch_x']);
});

Deno.test('appendImportBatchId: preserves other fields on update', async () => {
  const { entity, store, calls } = makeFakeCompany({
    id: 'c_1',
    name: 'Acme',
    import_batch_ids: [],
  });
  const result = await appendImportBatchId(entity, 'c_1', 'batch_1');
  assertEquals(result.name, 'Acme');
  assertEquals(store.c_1.name, 'Acme');
  // The patch only writes import_batch_ids — the name field is untouched
  // because we don't include it in the update payload.
  assertEquals(Object.keys(calls.update[0].data), ['import_batch_ids']);
});

Deno.test('appendImportBatchId: idempotent on repeated calls', async () => {
  const { entity, calls } = makeFakeCompany({
    id: 'c_1',
    import_batch_ids: [],
  });
  await appendImportBatchId(entity, 'c_1', 'batch_1');
  await appendImportBatchId(entity, 'c_1', 'batch_1');
  await appendImportBatchId(entity, 'c_1', 'batch_1');
  // Three gets (one per call), but only ONE update — the first call appended,
  // the next two saw the existing value and short-circuited.
  assertEquals(calls.get.length, 3);
  assertEquals(calls.update.length, 1);
});

Deno.test('appendImportBatchId: append preserves order (existing first, then new)', async () => {
  const { entity } = makeFakeCompany({
    id: 'c_1',
    import_batch_ids: ['batch_a', 'batch_b', 'batch_c'],
  });
  const result = await appendImportBatchId(entity, 'c_1', 'batch_d');
  assertEquals(result.import_batch_ids, ['batch_a', 'batch_b', 'batch_c', 'batch_d']);
});

Deno.test('appendImportBatchId: returns the updated row from entity.update', async () => {
  // The helper passes through whatever entity.update returns — the SDK is
  // the source of truth, not our local fake's store. Lock this contract.
  const entity: ImportBatchEntity<Company> = {
    async get() { return { id: 'c_1', import_batch_ids: [] }; },
    async update() {
      return {
        id: 'c_1',
        name: 'Server-side name',
        import_batch_ids: ['batch_1'],
      };
    },
  };
  const result = await appendImportBatchId(entity, 'c_1', 'batch_1');
  assertEquals(result.name, 'Server-side name');
  assertEquals(result.import_batch_ids, ['batch_1']);
});
