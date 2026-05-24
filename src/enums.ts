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

// ---------------------------------------------------------------------------
// Call outcomes — the disposition assigned to a call by the LLM verdict in
// `processQuoActivity`, also stored on Lead.last_call_outcome and
// CallActivity.ai_outcome.
//
// MUST stay in sync with the `enum` arrays in
// `sales-crm/base44/entities/CallActivity.jsonc` and
// `sales-crm/base44/entities/Lead.jsonc`. Drift between this const and the
// entity JSONC enums is what flow-catalog issue #31 (sales-crm-plans) is
// about — once sales-crm switches its inline OUTCOMES const to import from
// here, the JSONC enums become the only other source of truth.
// ---------------------------------------------------------------------------

export const CALL_OUTCOMES = [
  'demo_scheduled',
  'not_reached',
  'wrong_contact',
  'not_interested_follow_up',
  'not_interested',
  'interested_needs_follow_up',
  'gatekeeper',
  'no_fit',
  'unknown',
] as const;

export type CallOutcome = typeof CALL_OUTCOMES[number];

/**
 * Default outcome assigned when the LLM cannot confidently classify a call.
 * Matches `CallActivity.ai_outcome.default` in the entity JSONC.
 */
export const DEFAULT_CALL_OUTCOME: CallOutcome = 'unknown';

/**
 * UI-friendly labels for each call outcome. Use these in the Queue Wrap
 * dialog, the CallActivity table, and anywhere else an outcome is rendered
 * to a rep.
 */
export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  demo_scheduled: 'Demo scheduled',
  not_reached: 'Not reached',
  wrong_contact: 'Wrong contact',
  not_interested_follow_up: 'Not interested — follow up later',
  not_interested: 'Not interested',
  interested_needs_follow_up: 'Interested — needs follow up',
  gatekeeper: 'Gatekeeper',
  no_fit: 'No fit',
  unknown: 'Unknown',
};

// ---------------------------------------------------------------------------
// Next-action types — the forward-looking action the LLM (or a rep) decides
// should happen next after a call. Stored on Lead.next_action_type and
// CallActivity.ai_next_action_type. Drives the call queue and follow-ups.
// ---------------------------------------------------------------------------

export const NEXT_ACTION_TYPES = [
  'callback',
  'send_info',
  'book_demo',
  'nurture',
  'dnc',
  'no_action',
] as const;

export type NextActionType = typeof NEXT_ACTION_TYPES[number];

/**
 * Default next-action when no other action is implied. Matches
 * `CallActivity.ai_next_action_type.default` in the entity JSONC.
 */
export const DEFAULT_NEXT_ACTION: NextActionType = 'no_action';

/**
 * UI-friendly labels for each next-action type. Use these in the Queue Wrap
 * dialog (the "what should happen next" picker), the Follow-ups view, and
 * anywhere else a next-action is rendered to a rep.
 */
export const NEXT_ACTION_LABEL: Record<NextActionType, string> = {
  callback: 'Call back',
  send_info: 'Send info',
  book_demo: 'Book a demo',
  nurture: 'Nurture',
  dnc: 'Do not contact',
  no_action: 'No action',
};
