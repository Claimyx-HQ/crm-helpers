// Shared enum-style data sets used by CRM UI and filtering logic. These are
// intentionally pure data — no React, no JSX, no icon imports — so both
// frontend and backend consumers can use the same values without pulling in
// UI dependencies.

/**
 * Apollo's seniority enum, ordered seniormost-first. Use this for sort
 * comparisons (lower index = more senior) and as the canonical iteration
 * order when rendering a dropdown of seniorities.
 */
export const SENIORITY_ORDER = [
  'owner',
  'founder',
  'c_suite',
  'partner',
  'vp',
  'head',
  'director',
  'manager',
  'senior',
  'entry',
  'intern',
] as const;

/**
 * Type alias for the seniority enum values, derived from
 * {@link SENIORITY_ORDER} so adding/removing an entry there flows through
 * automatically.
 */
export type Seniority = typeof SENIORITY_ORDER[number];

/**
 * Display label for each seniority enum value. Keyed by the values in
 * {@link SENIORITY_ORDER} so TypeScript flags any drift between the order
 * array and the label map.
 */
export const SENIORITY_LABEL: Record<Seniority, string> = {
  owner: 'Owner',
  founder: 'Founder',
  c_suite: 'C-suite',
  partner: 'Partner',
  vp: 'VP',
  head: 'Head',
  director: 'Director',
  manager: 'Manager',
  senior: 'Senior',
  entry: 'Entry',
  intern: 'Intern',
};

/**
 * Enum of phone-number categories the CRM tracks on a Lead's `phone_numbers`
 * array. `other` is the catch-all for unclassified numbers.
 */
export type PhoneType = 'mobile' | 'direct' | 'hq' | 'work' | 'other';

/**
 * Display label for each phone type. The original frontend map also carried
 * a lucide-react icon component per type — that was dropped here so this
 * module stays UI-framework-agnostic. Consumers that render icons should
 * keep their own type-to-icon map alongside this label lookup.
 */
export const PHONE_TYPE_LABEL: Record<PhoneType, string> = {
  mobile: 'Mobile',
  direct: 'Direct',
  hq: 'HQ',
  work: 'Work',
  other: 'Other',
};
