import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  computeDiff,
  type CreatableEntity,
  defaultFullSnapshots,
  type DeletableEntity,
  type FieldChange,
  loggedCreate,
  loggedDelete,
  loggedUpdate,
  type LogEntity,
  type MutationLogRecord,
  type UpdatableEntity,
} from './mutation-log.ts';

Deno.test('computeDiff: empty diff when nothing changed', () => {
  const before = { stage: 'New', owner: 'u1' };
  const after = { stage: 'New', owner: 'u1' };
  assertEquals(computeDiff(before, after), {});
});

Deno.test('computeDiff: returns from/to for each changed field', () => {
  const before = { stage: 'New', owner: 'u1', score: 50 };
  const after = { stage: 'Qualified', owner: 'u1', score: 75 };
  assertEquals(computeDiff(before, after), {
    stage: { from: 'New', to: 'Qualified' },
    score: { from: 50, to: 75 },
  });
});

Deno.test('computeDiff: only diffs fields present in `after`', () => {
  // `after` is a partial update — fields absent from `after` are not in the diff,
  // even if they exist in `before`.
  const before = { stage: 'New', phone: '+15551234567', owner: 'u1' };
  const after = { stage: 'Qualified' };
  assertEquals(computeDiff(before, after), {
    stage: { from: 'New', to: 'Qualified' },
  });
});

Deno.test('computeDiff: handles new field in after (from normalized to null)', () => {
  // A field absent from `before` is treated as null (not undefined) so the
  // diff entry is JSON-safe.
  const before = { stage: 'New' };
  const after = { stage: 'New', new_field: 'value' };
  assertEquals(computeDiff(before, after), {
    new_field: { from: null, to: 'value' },
  });
});

Deno.test('computeDiff: null and undefined are equivalent (JSON-safe normalization)', () => {
  // Both null and undefined normalize to null upstream of the JSON.stringify
  // comparison, so a field that was null and is now undefined (or vice
  // versa) produces an empty diff — they round-trip to the same Base44
  // value anyway.
  assertEquals(computeDiff({ phone: null }, { phone: undefined }), {});
  assertEquals(computeDiff({ phone: undefined }, { phone: null }), {});
});

Deno.test('computeDiff: explicit unset (value → null) is recorded', () => {
  // Genuinely setting a field from a value to null IS a change worth
  // recording — the previous null-vs-undefined test conflated absence with
  // explicit null; this one isolates the real case.
  const before = { phone: '+15551234567' };
  const after = { phone: null };
  assertEquals(computeDiff(before, after), {
    phone: { from: '+15551234567', to: null },
  });
});

Deno.test('computeDiff: nested object change detected by JSON equality', () => {
  const before = { meta: { a: 1, b: 2 } };
  const after = { meta: { a: 1, b: 3 } };
  assertEquals(computeDiff(before, after), {
    meta: { from: { a: 1, b: 2 }, to: { a: 1, b: 3 } },
  });
});

Deno.test('computeDiff: array change detected', () => {
  const before = { tags: ['a', 'b'] };
  const after = { tags: ['a', 'b', 'c'] };
  assertEquals(computeDiff(before, after), {
    tags: { from: ['a', 'b'], to: ['a', 'b', 'c'] },
  });
});

Deno.test('FieldChange + computeDiff: typed shape is stable', () => {
  // The diff entries are typed as FieldChange. Asserting via the named type
  // would catch a future rename of `from` / `to`.
  const diff = computeDiff({ stage: 'New' }, { stage: 'Qualified' });
  const change: FieldChange = diff.stage;
  assertEquals(change.from, 'New');
  assertEquals(change.to, 'Qualified');
});

Deno.test('MutationLogRecord type — required fields locked at compile time', () => {
  // If a required field is renamed or removed in mutation-log.ts, this
  // assignment fails to type-check and the build breaks. The runtime
  // assertion is incidental — the compile check is the contract.
  const r: MutationLogRecord = {
    entity_type: 'Lead',
    entity_id: 'lead_123',
    mutation_type: 'update',
    source: 'user',
    actor_id: 'u_1',
    field_changes: { stage: { from: 'New', to: 'Qualified' } },
  };
  assertEquals(r.entity_type, 'Lead');
  assertEquals(r.mutation_type, 'update');
});

Deno.test('defaultFullSnapshots: llm / bulk_admin / apollo_sync → true', () => {
  assertEquals(defaultFullSnapshots('llm'), true);
  assertEquals(defaultFullSnapshots('bulk_admin'), true);
  assertEquals(defaultFullSnapshots('apollo_sync'), true);
});

Deno.test('defaultFullSnapshots: user / cron / quo_sync / import → false', () => {
  assertEquals(defaultFullSnapshots('user'), false);
  assertEquals(defaultFullSnapshots('cron'), false);
  assertEquals(defaultFullSnapshots('quo_sync'), false);
  assertEquals(defaultFullSnapshots('import'), false);
});

// Fake entity + log clients for behavioral tests. Reset per-test.
function makeFakes() {
  const entityStore: Record<string, Record<string, unknown>> = {
    lead_1: { id: 'lead_1', stage: 'New', owner: 'u1', last_activity_at: null },
  };
  const logRows: MutationLogRecord[] = [];
  const entity: UpdatableEntity = {
    async update(id, data) {
      entityStore[id] = { ...entityStore[id], ...data };
      return entityStore[id];
    },
    async get(id) {
      return entityStore[id];
    },
  };
  const mutationLog: LogEntity = {
    async create(record) {
      logRows.push(record);
      return record;
    },
  };
  return { entity, mutationLog, logRows, entityStore };
}

Deno.test('loggedUpdate: writes the updated entity AND a MutationLog row', async () => {
  const { entity, mutationLog, logRows, entityStore } = makeFakes();
  await loggedUpdate(entity, 'lead_1', { stage: 'Qualified' }, {
    source: 'user',
    actor: 'u_42',
    mutationLog,
  });
  assertEquals(entityStore.lead_1.stage, 'Qualified');
  assertEquals(logRows.length, 1);
  assertEquals(logRows[0].entity_id, 'lead_1');
  assertEquals(logRows[0].mutation_type, 'update');
  assertEquals(logRows[0].source, 'user');
  assertEquals(logRows[0].actor_id, 'u_42');
  assertEquals(logRows[0].field_changes.stage, { from: 'New', to: 'Qualified' });
});

Deno.test('loggedUpdate: stampActivity is applied on user source', async () => {
  const { entity, mutationLog, entityStore } = makeFakes();
  await loggedUpdate(entity, 'lead_1', { stage: 'Qualified' }, {
    source: 'user',
    actor: 'u_42',
    mutationLog,
  });
  // The user source must have stamped last_activity_at on the live entity.
  const stamped = entityStore.lead_1.last_activity_at;
  assertEquals(typeof stamped === 'string' && stamped.length > 0, true);
});

Deno.test('loggedUpdate: bulk_admin does NOT stamp last_activity_at (D2)', async () => {
  const { entity, mutationLog, entityStore } = makeFakes();
  await loggedUpdate(entity, 'lead_1', { stage: 'Closed Lost' }, {
    source: 'bulk_admin',
    actor: 'u_42',
    mutationLog,
  });
  // Same starting state (null); bulk_admin must not stamp.
  assertEquals(entityStore.lead_1.last_activity_at, null);
});

Deno.test('loggedUpdate: defaults entity_type from constructor name when omitted', async () => {
  const { entity, mutationLog, logRows } = makeFakes();
  // Wrap the entity so its constructor name is "Lead".
  class Lead implements UpdatableEntity {
    async update(id: string, data: Record<string, unknown>) { return entity.update(id, data); }
    async get(id: string) { return entity.get(id); }
  }
  const leadClient = new Lead();
  await loggedUpdate(leadClient, 'lead_1', { stage: 'Qualified' }, {
    source: 'user',
    actor: 'u_42',
    mutationLog,
  });
  assertEquals(logRows[0].entity_type, 'Lead');
});

Deno.test('loggedUpdate: entityType option overrides constructor name', async () => {
  const { entity, mutationLog, logRows } = makeFakes();
  await loggedUpdate(entity, 'lead_1', { stage: 'Qualified' }, {
    source: 'user',
    actor: 'u_42',
    mutationLog,
    entityType: 'CustomEntity',
  });
  assertEquals(logRows[0].entity_type, 'CustomEntity');
});

Deno.test('loggedUpdate: fullSnapshots=true on user source attaches before/after', async () => {
  const { entity, mutationLog, logRows } = makeFakes();
  await loggedUpdate(entity, 'lead_1', { stage: 'Qualified' }, {
    source: 'user',
    actor: 'u_42',
    mutationLog,
    fullSnapshots: true,
  });
  assertEquals(typeof logRows[0].before_snapshot, 'object');
  assertEquals(typeof logRows[0].after_snapshot, 'object');
  assertEquals(logRows[0].before_snapshot?.stage, 'New');
  assertEquals(logRows[0].after_snapshot?.stage, 'Qualified');
});

Deno.test('loggedUpdate: default behavior: user source → no snapshots', async () => {
  const { entity, mutationLog, logRows } = makeFakes();
  await loggedUpdate(entity, 'lead_1', { stage: 'Qualified' }, {
    source: 'user',
    actor: 'u_42',
    mutationLog,
  });
  // Default for 'user' is no snapshots (diff is enough).
  assertEquals(logRows[0].before_snapshot, undefined);
  assertEquals(logRows[0].after_snapshot, undefined);
});

Deno.test('loggedUpdate: default behavior: llm source → snapshots attached', async () => {
  const { entity, mutationLog, logRows } = makeFakes();
  await loggedUpdate(entity, 'lead_1', { stage: 'Qualified' }, {
    source: 'llm',
    actor: 'processQuoActivity',
    mutationLog,
  });
  // Default for 'llm' is snapshots on.
  assertEquals(typeof logRows[0].before_snapshot, 'object');
  assertEquals(typeof logRows[0].after_snapshot, 'object');
});

Deno.test('loggedUpdate: log-write failure does not throw (warns instead)', async () => {
  const { entity, entityStore } = makeFakes();
  const failingLog: LogEntity = {
    async create() { throw new Error('log write failed'); },
  };
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    await loggedUpdate(entity, 'lead_1', { stage: 'Qualified' }, {
      source: 'user',
      actor: 'u_42',
      mutationLog: failingLog,
    });
  } finally {
    console.warn = originalWarn;
  }
  // Entity update still landed.
  assertEquals(entityStore.lead_1.stage, 'Qualified');
  // The warn was emitted.
  assertEquals(warnings.length >= 1, true);
});

Deno.test('loggedUpdate: no-op update (no field changes) still writes a log row', async () => {
  const { entity, mutationLog, logRows } = makeFakes();
  await loggedUpdate(entity, 'lead_1', { stage: 'New' }, {
    source: 'user',
    actor: 'u_42',
    mutationLog,
  });
  // The intent was recorded even though nothing changed — useful for "did the
  // human click save with no edits?" telemetry.
  assertEquals(logRows.length, 1);
  assertEquals(logRows[0].field_changes, {});
});

Deno.test('loggedUpdate: order is get → update → log', async () => {
  // Regression guard: if a future refactor moves the log write before the
  // entity update returns, after_snapshot would be stale. Lock the order.
  const events: string[] = [];
  const entity: UpdatableEntity = {
    async update(id, data) {
      events.push('update');
      return { id, ...data };
    },
    async get() {
      events.push('get');
      return { id: 'x', stage: 'New' };
    },
  };
  const mutationLog: LogEntity = {
    async create(_record) {
      events.push('log');
      return _record;
    },
  };
  await loggedUpdate(entity, 'x', { stage: 'Qualified' }, {
    source: 'user',
    actor: 'u',
    mutationLog,
  });
  assertEquals(events, ['get', 'update', 'log']);
});

Deno.test('loggedCreate: creates entity AND writes MutationLog row', async () => {
  const created: Record<string, unknown>[] = [];
  const logRows: MutationLogRecord[] = [];
  const entity: CreatableEntity = {
    async create(data) {
      const row = { id: 'lead_new', ...data };
      created.push(row);
      return row;
    },
  };
  const mutationLog: LogEntity = {
    async create(record) { logRows.push(record); return record; },
  };
  const result = await loggedCreate(entity, { stage: 'New', email: 'x@y.com' }, {
    source: 'import',
    actor: 'importCompaniesFromFile',
    mutationLog,
  });
  assertEquals(result.id, 'lead_new');
  assertEquals(logRows.length, 1);
  assertEquals(logRows[0].mutation_type, 'create');
  assertEquals(logRows[0].entity_id, 'lead_new');
  assertEquals(logRows[0].source, 'import');
  assertEquals(logRows[0].field_changes, {});  // empty for creates
});

Deno.test('loggedCreate: after_snapshot ALWAYS attached regardless of source', async () => {
  const logRows: MutationLogRecord[] = [];
  const entity: CreatableEntity = {
    async create(data) { return { id: 'lead_new', ...data }; },
  };
  const mutationLog: LogEntity = {
    async create(record) { logRows.push(record); return record; },
  };
  // 'user' source's default is fullSnapshots=false for updates, but creates
  // always snapshot the after-state for replay.
  await loggedCreate(entity, { stage: 'New' }, {
    source: 'user',
    actor: 'u_1',
    mutationLog,
  });
  assertEquals(logRows[0].after_snapshot?.stage, 'New');
  assertEquals(logRows[0].before_snapshot, undefined);  // no before state on create
});

Deno.test('loggedCreate: log-write failure warns, does not throw', async () => {
  const entity: CreatableEntity = {
    async create(data) { return { id: 'lead_new', ...data }; },
  };
  const failingLog: LogEntity = {
    async create() { throw new Error('log failed'); },
  };
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const result = await loggedCreate(entity, { stage: 'New' }, {
      source: 'user',
      actor: 'u_1',
      mutationLog: failingLog,
    });
    assertEquals(result.id, 'lead_new');
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(warnings.length >= 1, true);
});

Deno.test('loggedCreate: entity without id field — log row entity_id is empty string', async () => {
  // Edge case: if Entity.create returns a row without an `id` field, we log
  // entity_id as ''. Better than throwing — the create itself succeeded.
  const logRows: MutationLogRecord[] = [];
  const entity: CreatableEntity = {
    async create(data) { return { ...data }; },  // no id
  };
  const mutationLog: LogEntity = {
    async create(record) { logRows.push(record); return record; },
  };
  await loggedCreate(entity, { stage: 'New' }, {
    source: 'user', actor: 'u_1', mutationLog,
  });
  assertEquals(logRows[0].entity_id, '');
});

Deno.test('loggedCreate: warns when created entity has no id field', async () => {
  const entity: CreatableEntity = {
    async create(data) { return { ...data }; },  // no id
  };
  const mutationLog: LogEntity = {
    async create(record) { return record; },
  };
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    await loggedCreate(entity, { stage: 'New' }, {
      source: 'user', actor: 'u_1', mutationLog,
    });
  } finally {
    console.warn = originalWarn;
  }
  // Two warnings would be wrong (one for missing id, none for log failure).
  // One warning is correct: the missing-id warn fires; the log write succeeded.
  assertEquals(warnings.length, 1);
});

Deno.test('loggedDelete: deletes entity AND writes MutationLog row with before_snapshot', async () => {
  const store: Record<string, Record<string, unknown>> = {
    lead_doomed: { id: 'lead_doomed', stage: 'Closed Lost' },
  };
  const logRows: MutationLogRecord[] = [];
  const entity: DeletableEntity = {
    async delete(id) { delete store[id]; },
    async get(id) { return store[id]; },
  };
  const mutationLog: LogEntity = {
    async create(record) { logRows.push(record); return record; },
  };
  await loggedDelete(entity, 'lead_doomed', {
    source: 'user',
    actor: 'u_1',
    mutationLog,
  });
  assertEquals(store.lead_doomed, undefined);
  assertEquals(logRows.length, 1);
  assertEquals(logRows[0].mutation_type, 'delete');
  assertEquals(logRows[0].entity_id, 'lead_doomed');
  // before_snapshot MUST be present — destructive operation, need replay.
  assertEquals(logRows[0].before_snapshot?.stage, 'Closed Lost');
});

Deno.test('loggedDelete: before_snapshot present even when fullSnapshots=false', async () => {
  // Deletes always snapshot the before state, regardless of fullSnapshots
  // option. The option is ignored for delete; restorability is mandatory.
  const store: Record<string, Record<string, unknown>> = {
    lead_doomed: { id: 'lead_doomed', stage: 'New' },
  };
  const logRows: MutationLogRecord[] = [];
  const entity: DeletableEntity = {
    async delete(id) { delete store[id]; },
    async get(id) { return store[id]; },
  };
  const mutationLog: LogEntity = {
    async create(record) { logRows.push(record); return record; },
  };
  await loggedDelete(entity, 'lead_doomed', {
    source: 'user',
    actor: 'u_1',
    mutationLog,
    fullSnapshots: false,  // explicitly off — must be ignored
  });
  assertEquals(logRows[0].before_snapshot?.stage, 'New');
});

Deno.test('loggedDelete: get failure means we cannot capture before_snapshot — log row uses empty object', async () => {
  // If entity.get throws (e.g. already deleted, permission lost), we still
  // proceed to delete + log, but before_snapshot is {} not undefined so the
  // schema invariant holds.
  const entity: DeletableEntity = {
    async delete() {},
    async get() { throw new Error('not found'); },
  };
  const logRows: MutationLogRecord[] = [];
  const mutationLog: LogEntity = {
    async create(record) { logRows.push(record); return record; },
  };
  await loggedDelete(entity, 'lead_doomed', {
    source: 'user', actor: 'u_1', mutationLog,
  });
  assertEquals(logRows[0].before_snapshot, {});
});

Deno.test('loggedDelete: entity.get returning null falls back to empty before_snapshot', async () => {
  const logRows: MutationLogRecord[] = [];
  const entity: DeletableEntity = {
    async delete() {},
    async get() { return null as unknown as Record<string, unknown>; },
  };
  const mutationLog: LogEntity = {
    async create(record) { logRows.push(record); return record; },
  };
  await loggedDelete(entity, 'lead_doomed', {
    source: 'user', actor: 'u_1', mutationLog,
  });
  assertEquals(logRows[0].before_snapshot, {});
});

Deno.test('loggedDelete: log-write failure warns, does not throw', async () => {
  const entity: DeletableEntity = {
    async delete() {},
    async get() { return { id: 'x' }; },
  };
  const failingLog: LogEntity = {
    async create() { throw new Error('log failed'); },
  };
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    await loggedDelete(entity, 'lead_doomed', {
      source: 'user', actor: 'u_1', mutationLog: failingLog,
    });
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(warnings.length >= 1, true);
});
