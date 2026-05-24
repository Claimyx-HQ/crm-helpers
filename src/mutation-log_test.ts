import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { computeDiff } from './mutation-log.ts';

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
