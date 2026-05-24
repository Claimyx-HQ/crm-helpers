import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  computeDiff,
  defaultFullSnapshots,
  type FieldChange,
  type MutationLogRecord,
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

Deno.test('computeDiff: handles new field in after (from: undefined)', () => {
  const before = { stage: 'New' };
  const after = { stage: 'New', new_field: 'value' };
  assertEquals(computeDiff(before, after), {
    new_field: { from: undefined, to: 'value' },
  });
});

Deno.test('computeDiff: handles null vs undefined as different values', () => {
  const before = { phone: null };
  const after = { phone: undefined };
  assertEquals(computeDiff(before, after), {
    phone: { from: null, to: undefined },
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
