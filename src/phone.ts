// crm-helpers/src/phone.ts
// Single import surface for phone helpers consumed by sales-crm. Re-exports
// the canonical `normalizePhone` from `./text.ts` (the existing E.164 join-key
// normalizer) and adds `extractPrimaryPhone` — an Apollo-contact picker that
// returns the most-trustworthy raw phone string before normalization.
//
// Intended call pattern in consumers:
//
//   import { normalizePhone, extractPrimaryPhone } from '@claimyx/crm-helpers/phone';
//   const key = normalizePhone(extractPrimaryPhone(contact));

export { normalizePhone } from './text.ts';

/**
 * Shape of an Apollo contact-like object as seen by `extractPrimaryPhone`.
 * Intentionally permissive — Apollo's JSON varies between endpoints.
 */
export interface PhoneSource {
  phone_numbers?: Array<{
    raw_number?: string | null;
    sanitized_number?: string | null;
    [k: string]: unknown;
  }> | null;
  sanitized_phone?: string | null;
  [k: string]: unknown;
}

/**
 * Pick the most-trustworthy phone string from an Apollo contact. Order:
 *   1. `phone_numbers[0].raw_number`
 *   2. `phone_numbers[0].sanitized_number`
 *   3. `sanitized_phone`
 *
 * Returns an empty string if none are present. Caller should pipe the result
 * through `normalizePhone` for dedup comparisons.
 */
export function extractPrimaryPhone(contact: PhoneSource): string {
  const first = contact.phone_numbers?.[0];
  return (
    first?.raw_number ||
    first?.sanitized_number ||
    contact.sanitized_phone ||
    ''
  );
}
