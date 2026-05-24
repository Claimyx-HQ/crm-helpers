// crm-helpers/src/phone.ts
// Canonical phone normalizer and primary-phone picker. Consolidates three
// drifting copies that previously lived in sales-crm base44 functions
// (`syncQuoCalls`, `discoverLeadsForCompany`, `enrichLeadFromApollo`).
//
// `normalizePhone` produces an E.164-shaped string ("+15551234567") suitable
// for use as a dedup key. `extractPrimaryPhone` picks the most-trustworthy
// raw phone string from an Apollo-shaped contact; pipe its output through
// `normalizePhone` to get a dedup-ready value.

/**
 * Normalize a phone string into an E.164-ish form ("+15551234567"). Returns
 * an empty string for null / undefined / whitespace / pure non-digit input.
 *
 * Rules:
 *  - Leading `+` is preserved; all other non-digit characters are stripped.
 *  - 10-digit input (no `+`) is treated as US and prefixed `+1`.
 *  - 11+-digit input without `+` is prefixed `+` as-is (best-effort guess
 *    at the country code already being present).
 *
 * The output is a STRICTLY normalized comparison key, not a display form.
 * Render the original `phone` field for users; use this only for dedup
 * lookups and phone-index queries.
 */
export function normalizePhone(phone: string | null | undefined): string {
  const raw = String(phone ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) {
    const stripped = raw.replace(/[^+\d]/g, '');
    return stripped === '+' ? '' : stripped;
  }
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

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
