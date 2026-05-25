// crm-helpers/src/task-run_test.ts
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  type TaskRunEntity,
  type TaskRunRecord,
  withTaskRun,
} from './task-run.ts';

// Fake TaskRun entity client. Records every create + update call and stores
// the resulting row state for assertions.
function makeFakeTaskRun() {
  const rows: Record<string, TaskRunRecord> = {};
  let nextId = 1;
  const calls: {
    create: Array<Record<string, unknown>>;
    update: Array<{ id: string; data: Record<string, unknown> }>;
  } = { create: [], update: [] };

  const entity: TaskRunEntity = {
    async create(data) {
      calls.create.push(data);
      const id = `tr_${nextId++}`;
      const row: TaskRunRecord = {
        id,
        task_type: (data.task_type as string) ?? '',
        status: (data.status as TaskRunRecord['status']) ?? 'running',
        started_at: (data.started_at as string) ?? new Date().toISOString(),
        attempt_count: (data.attempt_count as number) ?? 1,
        ...data,
      };
      rows[id] = row;
      return row;
    },
    async update(id, data) {
      calls.update.push({ id, data });
      rows[id] = { ...rows[id], ...data } as TaskRunRecord;
      return rows[id];
    },
  };

  return { entity, rows, calls };
}

Deno.test('withTaskRun: succeeded — creates row, runs fn, updates to succeeded', async () => {
  const { entity, rows, calls } = makeFakeTaskRun();
  const result = await withTaskRun(
    entity,
    'apollo_enrich',
    { targetEntityType: 'Company', targetEntityId: 'c_1' },
    async (_run) => {
      return { result: 'done' as const };
    },
  );
  assertEquals(result.status, 'succeeded');
  assertEquals(result.result, 'done');
  assertEquals(calls.create.length, 1);
  assertEquals(calls.create[0].task_type, 'apollo_enrich');
  assertEquals(calls.create[0].status, 'running');
  assertEquals(calls.create[0].target_entity_type, 'Company');
  assertEquals(calls.create[0].target_entity_id, 'c_1');
  assertEquals(calls.update.length, 1);
  assertEquals(calls.update[0].data.status, 'succeeded');
  // duration_ms should be a non-negative integer-ish number.
  const dur = calls.update[0].data.duration_ms as number;
  assert(typeof dur === 'number' && dur >= 0);
  assertEquals(rows[result.taskRunId].status, 'succeeded');
});

Deno.test('withTaskRun: succeeded — plain T return is propagated as result', async () => {
  const { entity } = makeFakeTaskRun();
  const result = await withTaskRun<number>(entity, 't', {}, async () => {
    return 42;
  });
  assertEquals(result.status, 'succeeded');
  assertEquals(result.result, 42);
});

Deno.test('withTaskRun: succeeded — stats propagate to the TaskRun row', async () => {
  const { entity, calls } = makeFakeTaskRun();
  await withTaskRun(entity, 'sync', {}, async () => {
    return { result: undefined, stats: { processed: 10, updated: 8 } };
  });
  assertEquals(calls.update[0].data.stats, { processed: 10, updated: 8 });
});

Deno.test('withTaskRun: failed — thrown error caught, status=failed, last_error set', async () => {
  const { entity, calls } = makeFakeTaskRun();
  const result = await withTaskRun(entity, 'failing', {}, async () => {
    throw new Error('boom');
  });
  assertEquals(result.status, 'failed');
  assertEquals(result.error?.message, 'boom');
  assertEquals(result.result, undefined);
  assertEquals(calls.update[0].data.status, 'failed');
  assertEquals(calls.update[0].data.last_error, 'boom');
  assert(typeof calls.update[0].data.last_error_at === 'string');
});

Deno.test('withTaskRun: failed — non-Error thrown values are coerced to Error', async () => {
  const { entity } = makeFakeTaskRun();
  const result = await withTaskRun(entity, 't', {}, async () => {
    throw 'string failure'; // intentional non-Error throw
  });
  assertEquals(result.status, 'failed');
  assert(result.error instanceof Error);
  assertEquals(result.error?.message, 'string failure');
});

Deno.test('withTaskRun: failed — does NOT re-throw, returns failed result', async () => {
  const { entity } = makeFakeTaskRun();
  // If this threw, the test would fail with an unexpected exception.
  const result = await withTaskRun(entity, 't', {}, async () => {
    throw new Error('intentional');
  });
  assertEquals(result.status, 'failed');
});

Deno.test('withTaskRun: partial — explicit { status: "partial" } is honored', async () => {
  const { entity, calls } = makeFakeTaskRun();
  const result = await withTaskRun<string>(entity, 't', {}, async () => {
    return { status: 'partial', result: 'kinda', stats: { ok: 8, failed: 2 } };
  });
  assertEquals(result.status, 'partial');
  assertEquals(result.result, 'kinda');
  assertEquals(calls.update[0].data.status, 'partial');
  assertEquals(calls.update[0].data.stats, { ok: 8, failed: 2 });
});

Deno.test('withTaskRun: post-success update is retried on transient failure', async () => {
  // First two update calls fail; third succeeds. The retry-with-backoff
  // loop should make the call eventually land and the helper returns
  // succeeded.
  const rows: Record<string, TaskRunRecord> = {};
  let updateAttempts = 0;
  const entity: TaskRunEntity = {
    async create(data) {
      const row: TaskRunRecord = {
        id: 'tr_1',
        task_type: data.task_type as string,
        status: 'running',
        started_at: new Date().toISOString(),
        attempt_count: 1,
        ...data,
      };
      rows.tr_1 = row;
      return row;
    },
    async update(id, data) {
      updateAttempts++;
      if (updateAttempts < 3) {
        throw new Error(`transient ${updateAttempts}`);
      }
      rows[id] = { ...rows[id], ...data } as TaskRunRecord;
      return rows[id];
    },
  };
  const result = await withTaskRun(entity, 't', {}, async () => {
    return { result: 'ok' };
  });
  assertEquals(result.status, 'succeeded');
  assertEquals(updateAttempts, 3);
  assertEquals(rows.tr_1.status, 'succeeded');
});

Deno.test('withTaskRun: post-success update exhausts retries → warns, still returns succeeded', async () => {
  let updateAttempts = 0;
  const entity: TaskRunEntity = {
    async create(data) {
      return {
        id: 'tr_x',
        task_type: data.task_type as string,
        status: 'running',
        started_at: new Date().toISOString(),
        attempt_count: 1,
      };
    },
    async update() {
      updateAttempts++;
      throw new Error('persistent failure');
    },
  };
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  let result;
  try {
    result = await withTaskRun(entity, 't', {}, async () => {
      return { result: 'ok' };
    });
  } finally {
    console.warn = originalWarn;
  }
  // 3 attempts were made before giving up.
  assertEquals(updateAttempts, 3);
  // The work succeeded; we returned succeeded even though the row update
  // could not be persisted.
  assertEquals(result.status, 'succeeded');
  assertEquals(result.result, 'ok');
  assertEquals(warnings.length, 1);
});

Deno.test('withTaskRun: failed-path update is also retried', async () => {
  // The failed-path update has the same retry contract — if it can't
  // land, the row would otherwise look stuck in 'running' forever.
  let updateAttempts = 0;
  const entity: TaskRunEntity = {
    async create(data) {
      return {
        id: 'tr_x',
        task_type: data.task_type as string,
        status: 'running',
        started_at: new Date().toISOString(),
        attempt_count: 1,
      };
    },
    async update(_id, _data) {
      updateAttempts++;
      if (updateAttempts < 2) throw new Error('transient');
      return {
        id: 'tr_x',
        task_type: 't',
        status: 'failed',
        started_at: new Date().toISOString(),
        attempt_count: 1,
      };
    },
  };
  const result = await withTaskRun(entity, 't', {}, async () => {
    throw new Error('work failed');
  });
  assertEquals(result.status, 'failed');
  assertEquals(updateAttempts, 2); // landed on attempt 2
});

Deno.test('withTaskRun: TaskRun fn receives the created run row', async () => {
  const { entity } = makeFakeTaskRun();
  let seenId: string | undefined;
  let seenType: string | undefined;
  await withTaskRun(entity, 'fancy_task', {}, async (run) => {
    seenId = run.id;
    seenType = run.task_type;
    return 'done';
  });
  assert(seenId && seenId.startsWith('tr_'));
  assertEquals(seenType, 'fancy_task');
});

Deno.test('withTaskRun: optional context fields propagate to create payload', async () => {
  const { entity, calls } = makeFakeTaskRun();
  await withTaskRun(
    entity,
    'enrich',
    {
      targetEntityType: 'Lead',
      targetEntityId: 'l_1',
      parentTaskId: 'tr_parent',
      sessionId: 'ss_1',
      triggeredByUserId: 'u_1',
    },
    async () => 'ok',
  );
  assertEquals(calls.create[0].target_entity_type, 'Lead');
  assertEquals(calls.create[0].target_entity_id, 'l_1');
  assertEquals(calls.create[0].parent_task_id, 'tr_parent');
  assertEquals(calls.create[0].session_id, 'ss_1');
  assertEquals(calls.create[0].triggered_by_user_id, 'u_1');
});

Deno.test('withTaskRun: omitted context fields are not in the create payload', async () => {
  const { entity, calls } = makeFakeTaskRun();
  await withTaskRun(entity, 'enrich', {}, async () => 'ok');
  // Should not be present at all (vs being null), so downstream entity
  // validation that requires nullable-not-present semantics works.
  assert(!('target_entity_type' in calls.create[0]));
  assert(!('parent_task_id' in calls.create[0]));
  assert(!('session_id' in calls.create[0]));
});

Deno.test('withTaskRun: error propagated through return value, not throw', async () => {
  // Lock the contract: throwing the inner error would short-circuit batch
  // callers. Make sure errors stay packaged.
  const { entity } = makeFakeTaskRun();
  let threw = false;
  try {
    const r = await withTaskRun(entity, 't', {}, async () => {
      throw new Error('inner');
    });
    assertEquals(r.status, 'failed');
    assertEquals(r.error?.message, 'inner');
  } catch (_e) {
    threw = true;
  }
  assertEquals(threw, false);
});

Deno.test('withTaskRun: succeeded TaskRun row carries completed_at and duration_ms', async () => {
  const { entity, rows } = makeFakeTaskRun();
  const result = await withTaskRun(entity, 't', {}, async () => {
    await new Promise((r) => setTimeout(r, 5));
    return 'ok';
  });
  const row = rows[result.taskRunId];
  assert(typeof row.completed_at === 'string');
  assert(typeof row.duration_ms === 'number' && row.duration_ms >= 0);
});
