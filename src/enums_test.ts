import { assertEquals, assert } from 'jsr:@std/assert@^1.0.0';
import {
  CALL_OUTCOMES,
  CALL_OUTCOME_LABEL,
  DEFAULT_CALL_OUTCOME,
  type CallOutcome,
  NEXT_ACTION_TYPES,
  NEXT_ACTION_LABEL,
  DEFAULT_NEXT_ACTION,
  type NextActionType,
  SENIORITY_ORDER,
  SENIORITY_LABEL,
} from './enums.ts';

Deno.test('CALL_OUTCOMES has exactly 9 values in the canonical order', () => {
  // The byte-for-byte values and order must match the enum arrays in
  // sales-crm/base44/entities/CallActivity.jsonc and Lead.jsonc. Changing
  // this list silently corrupts every existing CallActivity row.
  assertEquals(CALL_OUTCOMES, [
    'demo_scheduled',
    'not_reached',
    'wrong_contact',
    'not_interested_follow_up',
    'not_interested',
    'interested_needs_follow_up',
    'gatekeeper',
    'no_fit',
    'unknown',
  ] as const);
});

Deno.test('CALL_OUTCOME_LABEL has a label for every outcome and no orphans', () => {
  for (const o of CALL_OUTCOMES) {
    assert(CALL_OUTCOME_LABEL[o], `missing label for ${o}`);
    assert(
      typeof CALL_OUTCOME_LABEL[o] === 'string' && CALL_OUTCOME_LABEL[o].length > 0,
      `label for ${o} must be a non-empty string`,
    );
  }
  assertEquals(
    Object.keys(CALL_OUTCOME_LABEL).length,
    CALL_OUTCOMES.length,
    'label map must not have orphan keys',
  );
});

Deno.test('DEFAULT_CALL_OUTCOME is "unknown"', () => {
  // Matches CallActivity.ai_outcome.default and Lead.last_call_outcome semantics.
  assertEquals(DEFAULT_CALL_OUTCOME, 'unknown');
  // Must also be a member of CALL_OUTCOMES.
  assert(CALL_OUTCOMES.includes(DEFAULT_CALL_OUTCOME), 'default must be in CALL_OUTCOMES');
});

Deno.test('NEXT_ACTION_TYPES has exactly 6 values in the canonical order', () => {
  assertEquals(NEXT_ACTION_TYPES, [
    'callback',
    'send_info',
    'book_demo',
    'nurture',
    'dnc',
    'no_action',
  ] as const);
});

Deno.test('NEXT_ACTION_LABEL has a label for every type and no orphans', () => {
  for (const t of NEXT_ACTION_TYPES) {
    assert(NEXT_ACTION_LABEL[t], `missing label for ${t}`);
    assert(
      typeof NEXT_ACTION_LABEL[t] === 'string' && NEXT_ACTION_LABEL[t].length > 0,
      `label for ${t} must be a non-empty string`,
    );
  }
  assertEquals(
    Object.keys(NEXT_ACTION_LABEL).length,
    NEXT_ACTION_TYPES.length,
    'label map must not have orphan keys',
  );
});

Deno.test('DEFAULT_NEXT_ACTION is "no_action"', () => {
  assertEquals(DEFAULT_NEXT_ACTION, 'no_action');
  assert(NEXT_ACTION_TYPES.includes(DEFAULT_NEXT_ACTION), 'default must be in NEXT_ACTION_TYPES');
});

Deno.test('SENIORITY_ORDER + SENIORITY_LABEL regression (untouched by Task 3)', () => {
  // Verify the existing enums still line up after the append. If a future
  // edit drops a seniority entry, this catches it.
  for (const s of SENIORITY_ORDER) {
    assert(SENIORITY_LABEL[s], `missing seniority label for ${s}`);
  }
});
