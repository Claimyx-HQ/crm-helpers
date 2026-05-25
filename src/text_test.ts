import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { equalEnough, isBlankCell } from './text.ts';

Deno.test('isBlankCell — null / undefined / empty string are blank', () => {
  assertEquals(isBlankCell(null), true);
  assertEquals(isBlankCell(undefined), true);
  assertEquals(isBlankCell(''), true);
});

Deno.test('isBlankCell — empty array and empty object are blank', () => {
  assertEquals(isBlankCell([]), true);
  assertEquals(isBlankCell({}), true);
});

Deno.test('isBlankCell — non-empty containers are NOT blank', () => {
  assertEquals(isBlankCell(['a']), false);
  assertEquals(isBlankCell({ a: 1 }), false);
});

Deno.test('isBlankCell — non-string primitives are NOT blank (incl. 0 and false)', () => {
  assertEquals(isBlankCell(0), false);
  assertEquals(isBlankCell(false), false);
  assertEquals(isBlankCell('x'), false);
});

Deno.test('isBlankCell — whitespace-only string is NOT blank (does not trim)', () => {
  assertEquals(isBlankCell('   '), false);
  assertEquals(isBlankCell('\t\n'), false);
});

Deno.test('equalEnough — still collapses blanks to empty string after refactor', () => {
  assertEquals(equalEnough(null), '');
  assertEquals(equalEnough(undefined), '');
  assertEquals(equalEnough(''), '');
  assertEquals(equalEnough([]), '');
  assertEquals(equalEnough({}), '');
});

Deno.test('equalEnough — non-blank values serialize as before', () => {
  assertEquals(equalEnough(0), '0');
  assertEquals(equalEnough(false), 'false');
  assertEquals(equalEnough('x'), 'x');
  assertEquals(equalEnough(['a', 'b']), '["a","b"]');
  assertEquals(equalEnough({ a: 1 }), '{"a":1}');
});
