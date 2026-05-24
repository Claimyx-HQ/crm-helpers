// crm-helpers/src/phone_test.ts
import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { normalizePhone, extractPrimaryPhone } from './phone.ts';

Deno.test('normalizePhone: empty / null / undefined → empty string', () => {
  assertEquals(normalizePhone(''), '');
  assertEquals(normalizePhone(null), '');
  assertEquals(normalizePhone(undefined), '');
  assertEquals(normalizePhone('   '), '');
});

Deno.test('normalizePhone: 10-digit US → +1 prefix', () => {
  assertEquals(normalizePhone('5551234567'), '+15551234567');
  assertEquals(normalizePhone('(555) 123-4567'), '+15551234567');
  assertEquals(normalizePhone('555-123-4567'), '+15551234567');
  assertEquals(normalizePhone('555.123.4567'), '+15551234567');
});

Deno.test('normalizePhone: already +E.164 → preserved, non-digit stripped', () => {
  assertEquals(normalizePhone('+15551234567'), '+15551234567');
  assertEquals(normalizePhone('+1 (555) 123-4567'), '+15551234567');
  assertEquals(normalizePhone('+44 20 7946 0958'), '+442079460958');
});

Deno.test('normalizePhone: non-US 11+ digits without + → + prefix added', () => {
  assertEquals(normalizePhone('442079460958'), '+442079460958');
  assertEquals(normalizePhone('5511987654321'), '+5511987654321');
});

Deno.test('normalizePhone: pure garbage → empty string', () => {
  assertEquals(normalizePhone('abc'), '');
  assertEquals(normalizePhone('---'), '');
});

Deno.test('extractPrimaryPhone: prefers raw_number from first entry', () => {
  const contact = {
    phone_numbers: [
      { raw_number: '+15551234567', sanitized_number: '15551234567' },
    ],
    sanitized_phone: 'fallback',
  };
  assertEquals(extractPrimaryPhone(contact), '+15551234567');
});

Deno.test('extractPrimaryPhone: falls back to sanitized_number then sanitized_phone', () => {
  assertEquals(
    extractPrimaryPhone({ phone_numbers: [{ sanitized_number: '15551234567' }] }),
    '15551234567',
  );
  assertEquals(
    extractPrimaryPhone({ sanitized_phone: '15551234567' }),
    '15551234567',
  );
});

Deno.test('extractPrimaryPhone: nothing → empty string', () => {
  assertEquals(extractPrimaryPhone({}), '');
  assertEquals(extractPrimaryPhone({ phone_numbers: [] }), '');
});

Deno.test('extractPrimaryPhone composed with normalizePhone', () => {
  // The intended call pattern in consumers.
  const contact = { phone_numbers: [{ raw_number: '(555) 123-4567' }] };
  assertEquals(normalizePhone(extractPrimaryPhone(contact)), '+15551234567');
});
