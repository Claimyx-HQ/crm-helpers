// Apollo-specific helpers: HTTP client, response/entity types, and the
// normalizers that convert Apollo's payloads into the shape the Claimyx CRM
// stores in `Company` / `Lead` rows.
//
// Phase-06 expanded the type set and normalizers to cover ~50 additional
// Lead / Company fields (phones, funding, hiring, news, headcount,
// employment history, intent, social URLs, corporate family, etc.). Those
// fields are typed as OPTIONAL on the public `NormalizedCompany` /
// `NormalizedLead` interfaces so v1.0.x-shaped objects (which predate them)
// still satisfy the v1.1.0 type — v1.1.0 is purely additive at the type
// level. The normalizers themselves always populate every field, so reads
// from `normalizeAccount(...)` / `normalizeContact(...)` output are
// guaranteed to see real values for the optional-typed properties.
//
// Phase-2 (v1.2.0) additionally passes through Apollo workspace state —
// lists, labels, custom fields, account classifications, account/contact
// score, owner/stage names, engagement counters, and active sequence
// state. Workspace fields use the same optional-typed shape so the
// signature stays backward-compatible.

import { buildLocation, extractDomain, normalizeEmailStatus, normalizePhone } from './text.ts';
import { type PhoneType } from './enums.ts';
import {
  deriveAccountClassifications,
  deriveExistingCustomerStatus,
  extractAccountLists,
  extractContactLists,
  extractCustomFields,
  extractLabels,
  type ApolloAccountClassification,
  type ApolloList,
  type ExistingCustomerStatus,
} from './apollo-workspace.ts';
// Re-export the low-level Apollo HTTP primitives. They live in
// `./apollo-http.ts` to break the `apollo.ts` ↔ `apollo-workspace.ts` import
// cycle (workspace needs apolloPost; apollo.ts needs workspace derivations).
// Consumers can continue importing `apolloPost` / `ApolloResponse` / `APOLLO_BASE`
// from `@claimyx/crm-helpers/apollo` without code changes.
export { APOLLO_BASE, apolloPost, type ApolloResponse } from './apollo-http.ts';

/**
 * Maximum leads pulled per company in a single discovery run. Mirror this
 * value anywhere the cap is presented to the user (frontend chips, import
 * config) so they all agree.
 */
export const MAX_LEADS_HARD_CAP = 100;

/**
 * Default max leads per company when the caller doesn't specify. Used by
 * `discoverLeadsForCompany`, `importCompaniesFromFile`, and the frontend.
 */
export const DEFAULT_MAX_LEADS = 10;

/**
 * Default target titles for lead discovery when the caller doesn't supply a
 * list. Mirrored on the frontend so the UI's "default" chip set matches what
 * the backend will actually query.
 */
export const DEFAULT_DISCOVERY_TITLES: readonly string[] = [
  'VP',
  'Director of Operations',
  'Owner',
  'Administrator',
];

/**
 * Caps on raw array fields stored alongside a Company row. Enforced by the
 * extractors / mappers below so accounts with long histories don't blow row
 * size past the 50KB target. Tune here if a downstream consumer needs more
 * depth.
 */
export const FUNDING_EVENTS_CAP = 10;
export const JOB_POSTINGS_CAP = 10;
export const NEWS_ARTICLES_CAP = 5;
export const HEADCOUNT_CHART_CAP = 36; // 3y of monthly points
export const CURRENT_TECHNOLOGIES_CAP = 30; // ~3 categories × 10 entries

// ---------------------------------------------------------------------------
// Apollo HTTP
// ---------------------------------------------------------------------------
//
// `apolloPost`, `ApolloResponse`, and `APOLLO_BASE` are defined in
// `./apollo-http.ts` and re-exported from this module (see the import block
// at the top of the file). The extraction breaks the apollo ↔ apollo-workspace
// import cycle; the public surface from `@claimyx/crm-helpers/apollo` is
// unchanged.

// ---------------------------------------------------------------------------
// Phone-number derivation
// ---------------------------------------------------------------------------

/**
 * Map Apollo's free-form phone-type strings (`type_cd`, `type`) onto the
 * {@link PhoneType} enum shared with `./enums.ts`. Apollo isn't fully
 * consistent — some payloads use `mobile`, some `mobile_phone`, some
 * `cell`. Buckets every entry into one of {mobile, direct, hq, work,
 * home, other} so the UI can label and pick.
 */
export function mapPhoneType(typeRaw: string | null | undefined): PhoneType {
  if (!typeRaw) return 'other';
  const t = String(typeRaw).toLowerCase();
  if (t.includes('mobile') || t === 'cell' || t === 'cell_phone') return 'mobile';
  if (t.includes('direct')) return 'direct';
  if (
    t === 'corporate' ||
    t === 'corporate_phone' ||
    t === 'hq' ||
    t === 'headquarters' ||
    t === 'main'
  ) return 'hq';
  if (t.includes('home') || t === 'home_phone' || t === 'residential') return 'home';
  if (t.includes('work') || t === 'office' || t === 'business') return 'work';
  return 'other';
}

/**
 * The phone-verification status values accepted by the Lead/Company schema.
 * Apollo also returns `dnc_status` separately — that's a do-not-call flag,
 * NOT a verification status, so we deliberately don't conflate it into this
 * enum. If a downstream surface needs DNC info, read `dnc_status` from the
 * raw payload.
 */
export type PhoneStatus = 'verified' | 'unverified' | '';

/**
 * Coerce a raw Apollo phone status string into the narrow set the Lead/Company
 * schema accepts. Anything we don't recognize (including DNC-style statuses
 * like `'do_not_call'` or `'opted_out'`) becomes `''` so we never violate the
 * enum constraint on `phone_numbers[].status` at write time.
 */
export function normalizePhoneStatus(raw: string | null | undefined): PhoneStatus {
  if (!raw) return '';
  const v = String(raw).toLowerCase();
  if (v === 'verified') return 'verified';
  if (v === 'unverified') return 'unverified';
  return '';
}

/** Structured phone entry stored on Lead and Company rows. */
export interface PhoneNumberEntry {
  type: PhoneType;
  number: string;
  primary: boolean;
  status: PhoneStatus;
}

/** Raw Apollo phone payload shape (a contact / account `phone_numbers[]` entry). */
export interface ApolloPhoneEntry {
  raw_number?: string;
  sanitized_number?: string;
  type_cd?: string;
  type?: string;
  status?: string;
  dnc_status?: string;
  position?: number;
  is_primary?: boolean;
  source?: string;
}

/**
 * Build the structured phone list we store on Lead and Company. Walks
 * Apollo's raw `phone_numbers[]` entries, maps each to our enum, and
 * guarantees exactly one entry is marked primary (defaults to the first
 * when Apollo doesn't flag one). Phone status is whitelisted via
 * {@link normalizePhoneStatus} — unknown / DNC values collapse to `''`.
 */
export function derivePhoneNumbers(
  rawPhones: ApolloPhoneEntry[] | undefined | null,
): PhoneNumberEntry[] {
  const raw = Array.isArray(rawPhones) ? rawPhones : [];
  const out: PhoneNumberEntry[] = [];
  for (const p of raw) {
    const num = p?.raw_number || p?.sanitized_number || '';
    if (!num) continue;
    out.push({
      type: mapPhoneType(p?.type_cd || p?.type),
      number: String(num),
      primary: !!p?.is_primary,
      status: normalizePhoneStatus(p?.status),
    });
  }
  let primarySet = false;
  for (const p of out) {
    if (p.primary && !primarySet) primarySet = true;
    else p.primary = false;
  }
  if (!primarySet && out.length > 0) out[0].primary = true;
  return out;
}

/** First `mobile`-typed entry from `derivePhoneNumbers`, or empty string. */
export function pickMobile(numbers: PhoneNumberEntry[]): string {
  const m = numbers.find((p) => p.type === 'mobile');
  return m ? m.number : '';
}

/** First `direct`-typed entry from `derivePhoneNumbers`, or empty string. */
export function pickDirect(numbers: PhoneNumberEntry[]): string {
  const d = numbers.find((p) => p.type === 'direct');
  return d ? d.number : '';
}

/**
 * First entry of the given type from the provided phone-number list, or
 * empty string. Works on lists from either `derivePhoneNumbers` or
 * `mergePhoneShortcuts` — both produce the same `PhoneNumberEntry[]` shape.
 */
export function pickByType(numbers: PhoneNumberEntry[], type: PhoneType): string {
  const m = numbers.find((p) => p.type === type);
  return m ? m.number : '';
}

/** The entry flagged `primary` (or the first entry as fallback), or null. */
export function pickPrimary(numbers: PhoneNumberEntry[]): PhoneNumberEntry | null {
  return numbers.find((p) => p.primary) || numbers[0] || null;
}

/** Shortcut phone fields Apollo returns at the top level of a contact. */
export interface ApolloPhoneShortcuts {
  phone?: string;
  corporate_phone?: string;
  mobile_phone?: string;
  direct_phone?: string;
  home_phone?: string;
  other_phone?: string;
}

const SHORTCUT_TO_TYPE: Record<keyof ApolloPhoneShortcuts, PhoneType> = {
  corporate_phone: 'hq',
  mobile_phone: 'mobile',
  direct_phone: 'direct',
  home_phone: 'home',
  other_phone: 'other',
  phone: 'other',
};

function dedupKey(num: string): string {
  // Reuse the project's `normalizePhone` join key (a `+<digits>` form that
  // prefixes a bare 10-digit input with `+1`) so "+1 (415) 555-0000" and
  // "4155550000" dedupe. Without this Apollo's shortcut fields (which often
  // arrive without the country code) would never match the array entries
  // (which usually include it). This is the same normalization used as the
  // contact-merge join key elsewhere in the pipeline, not strict E.164.
  return normalizePhone(num);
}

/**
 * Merge Apollo's flat shortcut phone fields (`corporate_phone`,
 * `mobile_phone`, `direct_phone`, `home_phone`, `other_phone`, `phone`) into
 * an existing list derived from `phone_numbers[]`. Apollo doesn't always
 * include the shortcut value as an array entry — e.g. `corporate_phone` is
 * the employer's HQ line attributed to the contact and is sometimes only
 * exposed via the shortcut — so reading the array alone loses data.
 *
 * Dedupes via the project's `normalizePhone` join key (a `+<digits>` form
 * that adds `+1` to a bare 10-digit input) so different formattings of the
 * same number ("+1 (415) 555-0000" vs "415-555-0000") don't both land. The
 * first occurrence wins, and the primary flag from the structured array is
 * preserved; appended shortcut entries are never marked primary, but a
 * primary is assigned to the first entry if none was set.
 */
export function mergePhoneShortcuts(
  numbers: PhoneNumberEntry[],
  shortcuts: ApolloPhoneShortcuts,
): PhoneNumberEntry[] {
  const out: PhoneNumberEntry[] = numbers.map((p) => ({ ...p }));
  const seen = new Set<string>();
  for (const p of out) {
    const k = dedupKey(p.number);
    if (k) seen.add(k);
  }
  for (const field of Object.keys(SHORTCUT_TO_TYPE) as Array<keyof ApolloPhoneShortcuts>) {
    const value = shortcuts[field];
    if (!value) continue;
    // Trim once and reuse for both dedup and the stored number — otherwise
    // a whitespace-padded shortcut ("  4155550000  ") would dedupe to the
    // same key as the clean form but land in `phone_numbers[]` with the
    // padding intact.
    const sanitized = String(value).trim();
    if (!sanitized) continue;
    const k = dedupKey(sanitized);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({
      type: SHORTCUT_TO_TYPE[field],
      number: sanitized,
      primary: false,
      status: '',
    });
  }
  if (out.length > 0 && !out.some((p) => p.primary)) out[0].primary = true;
  return out;
}

// ---------------------------------------------------------------------------
// Sub-payload extractors (funding, hiring, news, headcount, locations)
// ---------------------------------------------------------------------------

/** Raw Apollo funding-event payload. */
export interface ApolloFundingEvent {
  date?: string;
  funded_at?: string;
  type?: string;
  stage?: string;
  amount?: number | string;
  investors?: string[] | { name?: string }[];
  news_url?: string;
}

/** Normalized funding event stored on Company.funding_events[]. */
export interface FundingEventEntry {
  date: string;
  stage: string;
  amount: number;
  investors: string[];
  news_url?: string;
}

/**
 * Normalize Apollo's `funding_events` array onto the storage shape. Sorted
 * reverse-chronologically (latest first) so `funding_events[0]` is the
 * canonical "latest round" everywhere downstream relies on it. Capped at
 * {@link FUNDING_EVENTS_CAP} entries.
 */
export function extractFundingEvents(
  events: ApolloFundingEvent[] | null | undefined,
): FundingEventEntry[] {
  if (!Array.isArray(events)) return [];
  const out: FundingEventEntry[] = [];
  for (const e of events) {
    const date = e?.date || e?.funded_at || '';
    const stage = e?.stage || e?.type || '';
    const amount = e?.amount != null ? Number(e.amount) : NaN;
    const investorsRaw = e?.investors;
    let investors: string[] = [];
    if (Array.isArray(investorsRaw)) {
      investors = investorsRaw
        .map((i) => (typeof i === 'string' ? i : i?.name || ''))
        .filter(Boolean);
    }
    if (!date && !stage && !Number.isFinite(amount)) continue;
    out.push({
      date: date || '',
      stage,
      amount: Number.isFinite(amount) ? amount : 0,
      investors,
      news_url: e?.news_url || undefined,
    });
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return out.slice(0, FUNDING_EVENTS_CAP);
}

/** Raw Apollo job-posting payload. */
export interface ApolloJobPosting {
  title?: string;
  location?: string;
  url?: string;
  posted_at?: string;
  date?: string;
}

/** Normalized job posting stored on Company.job_postings[]. */
export interface JobPostingEntry {
  title: string;
  location: string;
  url: string;
  posted_at: string;
}

/**
 * Normalize Apollo's `job_postings` array. Sorted newest-first; capped at
 * {@link JOB_POSTINGS_CAP} entries. Entries with no title / location / url
 * / posted_at are skipped so we don't waste cap slots on empty rows.
 */
export function extractJobPostings(
  postings: ApolloJobPosting[] | null | undefined,
): JobPostingEntry[] {
  if (!Array.isArray(postings)) return [];
  const out: JobPostingEntry[] = [];
  for (const p of postings) {
    const entry: JobPostingEntry = {
      title: p?.title || '',
      location: p?.location || '',
      url: p?.url || '',
      posted_at: p?.posted_at || p?.date || '',
    };
    if (!entry.title && !entry.location && !entry.url && !entry.posted_at) continue;
    out.push(entry);
  }
  out.sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''));
  return out.slice(0, JOB_POSTINGS_CAP);
}

/** Raw Apollo news-article payload. */
export interface ApolloNewsArticle {
  title?: string;
  url?: string;
  published_at?: string;
  publish_date?: string;
  summary?: string;
  description?: string;
}

/** Normalized news article stored on Company.news_articles[]. */
export interface NewsArticleEntry {
  title: string;
  url: string;
  published_at: string;
  summary: string;
}

/**
 * Normalize Apollo's `news_articles` array. Sorted newest-first; capped at
 * {@link NEWS_ARTICLES_CAP} entries. Entries with no title / url /
 * published_at / summary are skipped so the cap isn't consumed by empty rows.
 */
export function extractNewsArticles(
  articles: ApolloNewsArticle[] | null | undefined,
): NewsArticleEntry[] {
  if (!Array.isArray(articles)) return [];
  const out: NewsArticleEntry[] = [];
  for (const a of articles) {
    const entry: NewsArticleEntry = {
      title: a?.title || '',
      url: a?.url || '',
      published_at: a?.published_at || a?.publish_date || '',
      summary: a?.summary || a?.description || '',
    };
    if (!entry.title && !entry.url && !entry.published_at && !entry.summary) continue;
    out.push(entry);
  }
  out.sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
  return out.slice(0, NEWS_ARTICLES_CAP);
}

/** Raw Apollo headcount-chart point. */
export interface ApolloHeadcountPoint {
  month?: string;
  date?: string;
  count?: number;
  employees?: number;
}

/** Normalized headcount point stored on Company.headcount_chart[]. */
export interface HeadcountChartEntry {
  month: string;
  count: number;
}

/**
 * Normalize Apollo's headcount-chart array. Sorted oldest-first (so a
 * consumer can render left-to-right time-series). Kept to the most recent
 * {@link HEADCOUNT_CHART_CAP} months when the source has a longer history.
 */
export function extractHeadcountChart(
  points: ApolloHeadcountPoint[] | null | undefined,
): HeadcountChartEntry[] {
  if (!Array.isArray(points)) return [];
  const out: HeadcountChartEntry[] = [];
  for (const p of points) {
    const month = p?.month || p?.date || '';
    const count = p?.count ?? p?.employees;
    if (!month || count == null) continue;
    out.push({ month: String(month), count: Number(count) });
  }
  out.sort((a, b) => (a.month || '').localeCompare(b.month || ''));
  return out.length > HEADCOUNT_CHART_CAP
    ? out.slice(out.length - HEADCOUNT_CHART_CAP)
    : out;
}

/** Raw Apollo secondary-office shape. */
export interface ApolloSecondaryLocation {
  city?: string;
  state?: string;
  country?: string;
  postal_code?: string;
  type?: string;
}

/**
 * Normalize Apollo's `organization_locations` array — keeps only entries
 * with at least one of city/state/country populated.
 */
export function buildOrganizationLocations(
  locations: ApolloSecondaryLocation[] | null | undefined,
): ApolloSecondaryLocation[] {
  if (!Array.isArray(locations)) return [];
  return locations
    .map((l) => ({
      city: l?.city || '',
      state: l?.state || '',
      country: l?.country || '',
      postal_code: l?.postal_code || '',
      type: l?.type || '',
    }))
    .filter((l) => l.city || l.state || l.country);
}

/**
 * Build the company-level phone_numbers[] from an account + organization
 * pair. Falls back to a single synthesized `hq`-typed entry from the legacy
 * single phone string when Apollo returns no structured array. Returns an
 * empty array when nothing usable is present.
 */
export function buildCompanyPhoneNumbers(
  account: ApolloAccount,
  org: ApolloOrganization,
): PhoneNumberEntry[] {
  const accountPhones = (account as { phone_numbers?: ApolloPhoneEntry[] })
    ?.phone_numbers;
  const orgPhones = (org as { phone_numbers?: ApolloPhoneEntry[] })
    ?.phone_numbers;
  const raw =
    Array.isArray(accountPhones) && accountPhones.length
      ? accountPhones
      : Array.isArray(orgPhones) && orgPhones.length
        ? orgPhones
        : null;
  if (raw) return derivePhoneNumbers(raw);
  const legacy = account?.phone || account?.sanitized_phone || org?.phone || '';
  if (!legacy) return [];
  return [
    {
      type: 'hq',
      number: String(legacy),
      primary: true,
      status: '',
    },
  ];
}

/** Build the structured `primary_phone` object stored on Company, or undefined. */
export function buildPrimaryPhone(
  numbers: PhoneNumberEntry[],
): { number: string; source: string; status: PhoneStatus } | undefined {
  const p = pickPrimary(numbers);
  if (!p) return undefined;
  return { number: p.number, source: p.type, status: p.status };
}

// True iff `v` is a plain object record (not null, not an array). Used to
// guard the Apollo `Record<string, ...>` fields below — without the
// `!Array.isArray` check, an unexpected array payload would type-pass
// the `typeof === 'object'` check and surprise downstream consumers.
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Coerce raw to a finite number, or undefined when it's null/undefined,
 * an empty/whitespace string, or non-finite after coercion. Used to gate
 * optional numeric assignments in the normalizers below — without this,
 * `Number('')` returns 0 and an Apollo "" can persist as a real zero,
 * clobbering a previously-known-good value.
 */
function finiteNumber(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Apollo entity types
// ---------------------------------------------------------------------------

/** Raw Apollo `/accounts/search` row. Subset of fields we actually use. */
export interface ApolloAccount {
  id?: string;
  organization_id?: string;
  name?: string;
  domain?: string;
  organization?: ApolloOrganization;
  owner_id?: string;
  account_stage_id?: string;
  account_stage_name?: string;
  account_owner_name?: string;
  label_ids?: string[];
  num_contacts?: number;
  last_activity_date?: string;
  created_at?: string;
  updated_at?: string;
  phone?: string;
  sanitized_phone?: string;
  phone_numbers?: ApolloPhoneEntry[];
  linkedin_url?: string;
  country?: string;
  state?: string;
  city?: string;

  // Phase-2 workspace additions (Plan 05 Phase 2 Half B) -----------------
  creator_id?: string;
  account_classifications?: string[];
  is_target?: boolean;
  is_customer?: boolean;
  is_competitor?: boolean;
  is_partner?: boolean;
  typed_labels?: Array<{ id?: string; name?: string }>;
  labels?: Array<{ id?: string; name?: string } | string>;
  account_list_memberships?: Array<{ id?: string; name?: string; list_id?: string; list_name?: string }>;
  account_lists?: Array<{ id?: string; name?: string; list_id?: string; list_name?: string }>;
  typed_custom_fields?: Array<{ id?: string; name?: string; value?: unknown }>;
  custom_fields?: Record<string, unknown>;
  account_score?: number;
  apollo_score?: number;
}

/** Raw Apollo organization payload (nested under accounts, contacts, etc.). */
export interface ApolloOrganization {
  id?: string;
  name?: string;
  primary_domain?: string;
  website_url?: string;
  domain?: string;
  industry?: string;
  estimated_num_employees?: number | string;
  annual_revenue?: number | string;
  phone?: string;
  linkedin_url?: string;
  country?: string;
  state?: string;
  city?: string;
  short_description?: string;
  description?: string;
  technology_names?: string[];
  keywords?: string[];

  // Phase-06 additions ----------------------------------------------------
  linkedin_uid?: string;
  linkedin_employee_count?: number;
  linkedin_specialties?: string[];
  linkedin_industries?: string[];
  languages?: string[];
  logo_url?: string;
  crunchbase_url?: string;
  angellist_url?: string;
  twitter_url?: string;
  facebook_url?: string;
  blog_url?: string;
  founded_year?: number;
  publicly_traded_symbol?: string;
  publicly_traded_exchange?: string;
  alexa_ranking?: number;
  sic_codes?: string[];
  naics_codes?: string[];
  secondary_industries?: string[];
  industries?: string[];
  organization_revenue?: number;
  organization_revenue_printed?: string;
  annual_revenue_printed?: string;
  total_funding?: number;
  total_funding_printed?: string;
  latest_funding_stage?: string;
  latest_funding_round_date?: string;
  latest_funding_amount?: number;
  funding_events?: ApolloFundingEvent[];
  market_cap?: number;
  owned_by_organization_id?: string;
  parent_organization_name?: string;
  subsidiary_organization_ids?: string[];
  subsidiary_organization_names?: string[];
  num_suborganizations?: number;
  org_chart_sector?: string;
  acquisition_status?: string;
  acquired_at?: string;
  acquired_by?: string;
  is_b2b?: boolean;
  organization_headcount_six_month_growth?: number;
  organization_headcount_twelve_month_growth?: number;
  organization_headcount_twenty_four_month_growth?: number;
  departmental_head_count?: Record<string, number>;
  headcount_chart?: ApolloHeadcountPoint[];
  num_open_jobs?: number;
  latest_job_posting_titles?: string[];
  job_postings?: ApolloJobPosting[];
  news_articles?: ApolloNewsArticle[];
  current_technologies?: { name?: string; category?: string; first_seen?: string }[];
  seo_description?: string;
  long_description?: string;
  seo_keywords?: string[];
  domain_categories?: string[];
  domain_history?: string[];
  monthly_visits?: number;
  monthly_visits_change_pct?: number;
  intent_strength?: number;
  intent_topics?: string[];
  show_intent?: boolean;
  has_intent_signal_account?: boolean;
  intent_signal_account?: Record<string, unknown>;
  persona_counts?: Record<string, number>;
  existence_level?: string;
  headquarters_street_address?: string;
  headquarters_postal_code?: string;
  street_address?: string;
  postal_code?: string;
  organization_locations?: ApolloSecondaryLocation[];
  chief_executive_officer?: string;
  primary_phone?: { number?: string; source?: string; status?: string };
  phone_numbers?: ApolloPhoneEntry[];
}

/** Apollo employment-history entry (Phase 6). */
export interface ApolloEmploymentHistoryEntry {
  organization_name?: string;
  title?: string;
  start_date?: string;
  end_date?: string;
  current?: boolean;
}

/** Apollo education entry (Phase 6). */
export interface ApolloEducationEntry {
  school?: string;
  degree?: string;
  field_of_study?: string;
  start_year?: number;
  end_year?: number;
}

/** Raw Apollo `/mixed_people/search` person row. Subset of fields we use. */
export interface ApolloContactInput {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  email_status?: string;
  personal_emails?: string[];
  phone_numbers?: ApolloPhoneEntry[];
  sanitized_phone?: string;
  // Shortcut phone fields Apollo returns alongside `phone_numbers[]`. The
  // shortcuts and the structured array don't always overlap — Apollo can
  // populate `corporate_phone` (the employer's HQ line attributed to the
  // person) without listing it as an entry, so we read both and dedupe.
  phone?: string;
  corporate_phone?: string;
  mobile_phone?: string;
  direct_phone?: string;
  home_phone?: string;
  other_phone?: string;
  title?: string;
  headline?: string;
  organization?: ApolloOrganization;
  account?: ApolloOrganization;
  organization_name?: string;
  linkedin_url?: string;
  photo_url?: string;
  present_raw_address?: string;
  city?: string;
  state?: string;
  country?: string;
  last_activity_date?: string;
  updated_at?: string;
  created_at?: string;

  // Phase-06 additions ----------------------------------------------------
  bio?: string;
  twitter_url?: string;
  github_url?: string;
  facebook_url?: string;
  linkedin_uid?: string;
  linkedin_id?: string;
  linkedin_followers_count?: number;
  seniority?: string;
  departments?: string[];
  subdepartments?: string[];
  functions?: string[];
  employment_history?: ApolloEmploymentHistoryEntry[];
  education?: ApolloEducationEntry[];
  time_zone?: string;
  language_codes?: string[];
  email_domain_catchall?: boolean;
  extrapolated_email?: string;
  extrapolated_email_confidence?: number;
  is_likely_to_engage?: boolean;
  intent_strength?: number;
  intent_topics?: string[];
  hubspot_id?: string;
  salesforce_id?: string;
  crm_owner_id?: string;
  apollo_account_id?: string;
  apollo_created_at?: string;
  apollo_updated_at?: string;
  original_source?: string;
  apollo_original_source?: string;
  person_city?: string;
  person_state?: string;
  person_country?: string;

  // Phase-2 workspace additions (Plan 05 Phase 2 Half B) -----------------
  contact_stage_id?: string;
  contact_stage_name?: string;
  owner_id?: string;
  owner_name?: string;
  creator_id?: string;
  typed_labels?: Array<{ id?: string; name?: string }>;
  labels?: Array<{ id?: string; name?: string } | string>;
  contact_list_memberships?: Array<{ id?: string; name?: string; list_id?: string; list_name?: string }>;
  contact_lists?: Array<{ id?: string; name?: string; list_id?: string; list_name?: string }>;
  typed_custom_fields?: Array<{ id?: string; name?: string; value?: unknown }>;
  custom_fields?: Record<string, unknown>;
  apollo_score?: number;
  contact_score?: number;
  account_playbook_statuses?: unknown;
  emails_sent_count?: number;
  emails_opened_count?: number;
  emails_clicked_count?: number;
  emails_replied_count?: number;
  emails_bounced_count?: number;
  last_emailed_at?: string;
  last_email_opened_at?: string;
  last_email_replied_at?: string;
  active_sequence_id?: string;
  active_sequence_name?: string;
  active_sequence_step?: number;
  active_sequence_paused?: boolean;
  open_tasks_count?: number;
  overdue_tasks_count?: number;
  notes_count?: number;
  latest_note_snippet?: string;
}

/**
 * Shape of a Company row in the CRM, after normalization from Apollo.
 *
 * The pre-Phase-06 fields are required. The Phase-06 + Phase-2 additions
 * (everything below the markers) are typed as OPTIONAL so v1.0.x-shaped
 * objects remain assignable to this type — the normalizer always populates
 * them at runtime (with `''` / `[]` / `{}` defaults) so reads from
 * `normalizeAccount(...)` output don't need null checks for these fields
 * in practice, only when constructing the type by hand.
 */
export interface NormalizedCompany {
  // Pre-Phase-06 fields (required) ----------------------------------------
  name: string;
  domain: string;
  website: string;
  industry: string;
  employees: string;
  annual_revenue: string;
  phone: string;
  linkedin_url: string;
  location: string;
  country: string;
  state: string;
  city: string;
  description: string;
  technologies: string[];
  keywords: string[];
  apollo_account_id: string;
  apollo_organization_id: string;
  apollo_owner_id: string;
  apollo_stage_id: string;
  apollo_label_ids: string[];
  source: string;
  num_contacts: number;
  last_activity_at: string | null;
  apollo_created_at: string | null;
  apollo_updated_at: string | null;
  raw: ApolloAccount;

  // Phase-06 additions (optional for TS-level backcompat with v1.0.x) ----
  long_description?: string;
  seo_description?: string;
  logo_url?: string;
  crunchbase_url?: string;
  angellist_url?: string;
  twitter_url?: string;
  facebook_url?: string;
  blog_url?: string;
  chief_executive_officer?: string;
  headquarters_street_address?: string;
  headquarters_postal_code?: string;
  account_stage_name?: string;
  account_owner_name?: string;
  parent_organization_name?: string;
  acquired_by?: string;
  acquisition_status?: string;
  latest_funding_stage?: string;
  organization_revenue_printed?: string;
  annual_revenue_printed?: string;
  total_funding_printed?: string;
  org_chart_sector?: string;
  existence_level?: string;
  secondary_industries?: string[];
  naics_codes?: string[];
  sic_codes?: string[];
  languages?: string[];
  linkedin_specialties?: string[];
  linkedin_industries?: string[];
  latest_job_posting_titles?: string[];
  seo_keywords?: string[];
  domain_categories?: string[];
  domain_history?: string[];
  intent_topics?: string[];
  subsidiary_organization_ids?: string[];
  subsidiary_organization_names?: string[];
  current_technologies?: { name: string; category: string; first_seen: string }[];
  funding_events?: FundingEventEntry[];
  job_postings?: JobPostingEntry[];
  news_articles?: NewsArticleEntry[];
  headcount_chart?: HeadcountChartEntry[];
  organization_locations?: ApolloSecondaryLocation[];
  phone_numbers?: PhoneNumberEntry[];
  primary_phone?: { number: string; source: string; status: PhoneStatus };
  departmental_head_count?: Record<string, number>;
  persona_counts?: Record<string, number>;
  intent_signal_account?: Record<string, unknown>;
  owned_by_organization_id?: string;
  founded_year?: number;
  publicly_traded_symbol?: string;
  publicly_traded_exchange?: string;
  market_cap?: number;
  organization_revenue?: number;
  total_funding?: number;
  latest_funding_amount?: number;
  latest_funding_round_date?: string;
  headcount_growth_6m?: number;
  headcount_growth_12m?: number;
  headcount_growth_24m?: number;
  num_open_jobs?: number;
  num_suborganizations?: number;
  monthly_visits?: number;
  monthly_visits_change_pct?: number;
  alexa_ranking?: number;
  intent_strength?: number;
  show_intent?: boolean;
  is_b2b?: boolean;
  acquired_at?: string;
  linkedin_uid?: string;
  linkedin_employee_count?: number;

  // Phase-2 workspace additions (Plan 05 Phase 2 Half B) -----------------
  apollo_account_lists?: ApolloList[];
  apollo_account_label_names?: string[];
  apollo_account_custom_fields?: Record<string, unknown>;
  apollo_account_score?: number;
  apollo_account_classifications?: ApolloAccountClassification[];
  existing_customer_status?: ExistingCustomerStatus;
  apollo_account_creator_id?: string;
}

/**
 * Shape of a Lead row in the CRM, after normalization from Apollo.
 *
 * Same approach as {@link NormalizedCompany}: pre-Phase-06 fields are
 * required; Phase-06 + Phase-2 additions are optional for TS-level backcompat.
 */
export interface NormalizedLead {
  // Pre-Phase-06 fields (required) ----------------------------------------
  first_name: string;
  last_name: string;
  email: string;
  email_status: string;
  phone: string;
  title: string;
  company_name: string;
  company_website: string;
  company_industry: string;
  company_size: string;
  company_revenue: string;
  apollo_id: string;
  linkedin_url: string;
  photo_url: string;
  location: string;
  stage_id: string;
  source: string;
  score: number;
  last_activity_at: string;

  // Phase-06 additions (optional for TS-level backcompat with v1.0.x) ----
  headline?: string;
  bio?: string;
  twitter_url?: string;
  github_url?: string;
  facebook_url?: string;
  linkedin_uid?: string;
  linkedin_id?: string;
  seniority?: string;
  departments?: string[];
  subdepartments?: string[];
  functions?: string[];
  language_codes?: string[];
  intent_topics?: string[];
  employment_history?: ApolloEmploymentHistoryEntry[];
  education?: ApolloEducationEntry[];
  phone_numbers?: PhoneNumberEntry[];
  mobile_phone?: string;
  direct_phone?: string;
  corporate_phone?: string;
  home_phone?: string;
  other_phone?: string;
  personal_emails?: string[];
  phone_status?: PhoneStatus;
  time_zone?: string;
  person_city?: string;
  person_state?: string;
  person_country?: string;
  extrapolated_email?: string;
  hubspot_id?: string;
  salesforce_id?: string;
  crm_owner_id?: string;
  apollo_account_id?: string;
  apollo_original_source?: string;
  linkedin_followers_count?: number;
  extrapolated_email_confidence?: number;
  intent_strength?: number;
  is_likely_to_engage?: boolean;
  email_domain_catchall?: boolean;
  apollo_created_at?: string;
  apollo_updated_at?: string;

  // Phase-2 workspace additions (Plan 05 Phase 2 Half B) -----------------
  apollo_owner_id?: string;
  apollo_owner_name?: string;
  apollo_contact_stage_id?: string;
  apollo_contact_stage_name?: string;
  apollo_lists?: ApolloList[];
  apollo_label_ids?: string[];
  apollo_label_names?: string[];
  apollo_custom_fields?: Record<string, unknown>;
  apollo_score?: number;
  apollo_creator_id?: string;
  apollo_account_playbook_statuses?: unknown;
  apollo_emails_sent_count?: number;
  apollo_emails_opened_count?: number;
  apollo_emails_clicked_count?: number;
  apollo_emails_replied_count?: number;
  apollo_emails_bounced_count?: number;
  apollo_last_emailed_at?: string;
  apollo_last_email_opened_at?: string;
  apollo_last_email_replied_at?: string;
  apollo_active_sequence_id?: string;
  apollo_active_sequence_name?: string;
  apollo_active_sequence_step?: number;
  apollo_active_sequence_paused?: boolean;
  apollo_open_tasks_count?: number;
  apollo_overdue_tasks_count?: number;
  apollo_notes_count?: number;
  apollo_latest_note_snippet?: string;
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/**
 * Convert an Apollo `/accounts/search` row (or an `/organizations/enrich` row
 * reshaped via {@link organizationAsAccount}) into the Company payload we
 * store. Matches the shape produced by `syncApolloLeads` so re-running the
 * Apollo full sync over a row written by this helper is a no-op (the
 * `isUnchanged` check from `./text.ts` short-circuits).
 *
 * The Phase-06 + Phase-2 additions on the return type are typed optional,
 * but this function ALWAYS populates them (with `''` / `[]` / `{}` defaults
 * when Apollo returned nothing) so callers reading the result can rely on
 * real values being present.
 */
export function normalizeAccount(account: ApolloAccount): NormalizedCompany {
  const org = account.organization || {};
  const domain =
    extractDomain(account.domain) ||
    extractDomain(org.primary_domain) ||
    extractDomain(org.website_url) ||
    extractDomain(org.domain);

  const fundingEvents = extractFundingEvents(org.funding_events);
  const latestFunding = fundingEvents[0];
  const jobPostings = extractJobPostings(org.job_postings);
  const newsArticles = extractNewsArticles(org.news_articles);
  const headcountChart = extractHeadcountChart(org.headcount_chart);
  const orgLocations = buildOrganizationLocations(org.organization_locations);
  const phoneNumbers = buildCompanyPhoneNumbers(account, org);
  const primaryPhoneStructured = buildPrimaryPhone(phoneNumbers);
  const currentTechnologies = Array.isArray(org.current_technologies)
    ? org.current_technologies
        .map((t) => ({
          name: t?.name || '',
          category: t?.category || '',
          first_seen: t?.first_seen || '',
        }))
        .filter((t) => t.name)
        .slice(0, CURRENT_TECHNOLOGIES_CAP)
    : [];

  const out: NormalizedCompany = {
    name: account.name || org.name || 'Unknown',
    domain,
    website: org.website_url || (domain ? `https://${domain}` : ''),
    industry: org.industry || '',
    employees:
      org.estimated_num_employees != null
        ? String(org.estimated_num_employees)
        : '',
    annual_revenue:
      org.annual_revenue != null ? String(org.annual_revenue) : '',
    phone: account.phone || account.sanitized_phone || org.phone || '',
    linkedin_url: account.linkedin_url || org.linkedin_url || '',
    location: buildLocation(org) || buildLocation(account),
    country: org.country || account.country || '',
    state: org.state || account.state || '',
    city: org.city || account.city || '',
    description: org.short_description || org.description || '',
    technologies: Array.isArray(org.technology_names) ? org.technology_names : [],
    keywords: Array.isArray(org.keywords) ? org.keywords : [],
    apollo_account_id: account.id || '',
    apollo_organization_id: account.organization_id || org.id || '',
    apollo_owner_id: account.owner_id || '',
    apollo_stage_id: account.account_stage_id || '',
    apollo_label_ids: Array.isArray(account.label_ids) ? account.label_ids : [],
    source: 'apollo',
    num_contacts: account.num_contacts || 0,
    last_activity_at: account.last_activity_date || null,
    apollo_created_at: account.created_at || null,
    apollo_updated_at: account.updated_at || null,
    raw: account,

    long_description: org.long_description || '',
    seo_description: org.seo_description || '',
    logo_url: org.logo_url || '',
    crunchbase_url: org.crunchbase_url || '',
    angellist_url: org.angellist_url || '',
    twitter_url: org.twitter_url || '',
    facebook_url: org.facebook_url || '',
    blog_url: org.blog_url || '',
    chief_executive_officer: org.chief_executive_officer || '',
    headquarters_street_address:
      org.headquarters_street_address || org.street_address || '',
    headquarters_postal_code:
      org.headquarters_postal_code || org.postal_code || '',
    account_stage_name: account.account_stage_name || '',
    account_owner_name: account.account_owner_name || '',
    parent_organization_name: org.parent_organization_name || '',
    acquired_by: org.acquired_by || '',
    acquisition_status: org.acquisition_status || '',
    latest_funding_stage:
      org.latest_funding_stage || (latestFunding ? latestFunding.stage : ''),
    organization_revenue_printed: org.organization_revenue_printed || '',
    annual_revenue_printed: org.annual_revenue_printed || '',
    total_funding_printed: org.total_funding_printed || '',
    org_chart_sector: org.org_chart_sector || '',
    existence_level: org.existence_level || '',
    secondary_industries: Array.isArray(org.secondary_industries)
      ? org.secondary_industries
      : Array.isArray(org.industries) ? org.industries : [],
    naics_codes: Array.isArray(org.naics_codes) ? org.naics_codes : [],
    sic_codes: Array.isArray(org.sic_codes) ? org.sic_codes : [],
    languages: Array.isArray(org.languages) ? org.languages : [],
    linkedin_specialties: Array.isArray(org.linkedin_specialties)
      ? org.linkedin_specialties
      : [],
    linkedin_industries: Array.isArray(org.linkedin_industries)
      ? org.linkedin_industries
      : [],
    latest_job_posting_titles: Array.isArray(org.latest_job_posting_titles)
      ? org.latest_job_posting_titles
      : [...new Set(jobPostings.map((j) => j.title).filter(Boolean))].slice(0, 10),
    seo_keywords: Array.isArray(org.seo_keywords) ? org.seo_keywords : [],
    domain_categories: Array.isArray(org.domain_categories) ? org.domain_categories : [],
    domain_history: Array.isArray(org.domain_history) ? org.domain_history : [],
    intent_topics: Array.isArray(org.intent_topics) ? org.intent_topics : [],
    subsidiary_organization_ids: Array.isArray(org.subsidiary_organization_ids)
      ? org.subsidiary_organization_ids
      : [],
    subsidiary_organization_names: Array.isArray(org.subsidiary_organization_names)
      ? org.subsidiary_organization_names
      : [],
    current_technologies: currentTechnologies,
    funding_events: fundingEvents,
    job_postings: jobPostings,
    news_articles: newsArticles,
    headcount_chart: headcountChart,
    organization_locations: orgLocations,
    phone_numbers: phoneNumbers,
    departmental_head_count: isPlainRecord(org.departmental_head_count)
      ? (org.departmental_head_count as Record<string, number>)
      : {},
    persona_counts: isPlainRecord(org.persona_counts)
      ? (org.persona_counts as Record<string, number>)
      : {},
    intent_signal_account: isPlainRecord(org.intent_signal_account)
      ? org.intent_signal_account
      : {},
    owned_by_organization_id: org.owned_by_organization_id || '',
  };

  if (primaryPhoneStructured) out.primary_phone = primaryPhoneStructured;
  const foundedYear = finiteNumber(org.founded_year);
  if (foundedYear !== undefined) out.founded_year = foundedYear;
  if (org.publicly_traded_symbol) out.publicly_traded_symbol = org.publicly_traded_symbol;
  if (org.publicly_traded_exchange) out.publicly_traded_exchange = org.publicly_traded_exchange;
  const marketCap = finiteNumber(org.market_cap);
  if (marketCap !== undefined) out.market_cap = marketCap;
  const orgRevenue = finiteNumber(org.organization_revenue);
  if (orgRevenue !== undefined) out.organization_revenue = orgRevenue;
  const totalFunding = finiteNumber(org.total_funding);
  if (totalFunding !== undefined) out.total_funding = totalFunding;
  const latestFundingAmount = finiteNumber(org.latest_funding_amount);
  if (latestFundingAmount !== undefined) out.latest_funding_amount = latestFundingAmount;
  else if (latestFunding) out.latest_funding_amount = latestFunding.amount;
  if (org.latest_funding_round_date) out.latest_funding_round_date = org.latest_funding_round_date;
  else if (latestFunding && latestFunding.date) out.latest_funding_round_date = latestFunding.date;
  const growth6 = finiteNumber(org.organization_headcount_six_month_growth);
  if (growth6 !== undefined) out.headcount_growth_6m = growth6;
  const growth12 = finiteNumber(org.organization_headcount_twelve_month_growth);
  if (growth12 !== undefined) out.headcount_growth_12m = growth12;
  const growth24 = finiteNumber(org.organization_headcount_twenty_four_month_growth);
  if (growth24 !== undefined) out.headcount_growth_24m = growth24;
  const numOpenJobs = finiteNumber(org.num_open_jobs);
  if (numOpenJobs !== undefined) out.num_open_jobs = numOpenJobs;
  const numSubs = finiteNumber(org.num_suborganizations);
  if (numSubs !== undefined) out.num_suborganizations = numSubs;
  const monthlyVisits = finiteNumber(org.monthly_visits);
  if (monthlyVisits !== undefined) out.monthly_visits = monthlyVisits;
  const monthlyChange = finiteNumber(org.monthly_visits_change_pct);
  if (monthlyChange !== undefined) out.monthly_visits_change_pct = monthlyChange;
  const alexa = finiteNumber(org.alexa_ranking);
  if (alexa !== undefined) out.alexa_ranking = alexa;
  const intent = finiteNumber(org.intent_strength);
  if (intent !== undefined) out.intent_strength = intent;
  if (org.show_intent != null) out.show_intent = !!org.show_intent;
  if (org.is_b2b != null) out.is_b2b = !!org.is_b2b;
  if (org.acquired_at) out.acquired_at = org.acquired_at;
  if (org.linkedin_uid) out.linkedin_uid = org.linkedin_uid;
  const linkedinEmployees = finiteNumber(org.linkedin_employee_count);
  if (linkedinEmployees !== undefined) out.linkedin_employee_count = linkedinEmployees;

  // ---- Phase-2 workspace state (Plan 05 Phase 2 Half B) ----------------
  // Always assign workspace-state arrays / objects, even when empty. If
  // Apollo later removes a list, label, classification, or custom-field
  // value, the next sync MUST clear the stale CRM row — guarding on
  // `length > 0` would freeze the previous value in place. The interface
  // types stay `?:` for v1.0.x-shaped consumers (Phase-06 additive
  // backcompat); the runtime contract is "always present, possibly empty".
  out.apollo_account_lists = extractAccountLists(account as unknown as Record<string, unknown>);
  const accountLabelInfo = extractLabels(account as unknown as Record<string, unknown>);
  out.apollo_account_label_names = accountLabelInfo.names;
  out.apollo_account_custom_fields = extractCustomFields(account as unknown as Record<string, unknown>);
  const accountScore = finiteNumber(account.account_score) ?? finiteNumber(account.apollo_score);
  if (accountScore !== undefined) out.apollo_account_score = accountScore;
  const classifications = deriveAccountClassifications(account as unknown as Record<string, unknown>);
  out.apollo_account_classifications = classifications;
  out.existing_customer_status = deriveExistingCustomerStatus(
    classifications,
    account.last_activity_date || null,
  );
  if (account.creator_id) out.apollo_account_creator_id = account.creator_id;

  return out;
}

/**
 * Reshape an `/organizations/enrich` response so the rest of the pipeline can
 * treat it like an `/accounts/search` row. The endpoint doesn't return an
 * `account_id` because the org isn't in the workspace yet, so we deliberately
 * leave `apollo_account_id` empty — that signals "found in Apollo's global
 * directory but not yet added to your workspace" and is what
 * `enrichCompanyFromApollo` uses to decide whether to recommend
 * `apollo_accounts_create`.
 */
export function organizationAsAccount(org: ApolloOrganization): ApolloAccount {
  return {
    id: '',
    name: org.name || '',
    domain: org.primary_domain || org.domain || extractDomain(org.website_url),
    organization_id: org.id || '',
    organization: org,
  };
}

/**
 * Convert an Apollo `/mixed_people/search` row into the Lead payload we
 * store. Same shape `syncApolloLeads` produces, so re-syncing a
 * discovery-imported Lead via the full Apollo sync is a no-op.
 *
 * The Phase-06 + Phase-2 additions on the return type are typed optional,
 * but this function ALWAYS populates them so callers reading the result
 * can rely on real values being present.
 */
export function normalizeContact(
  contact: ApolloContactInput,
  defaultStageId: string,
): NormalizedLead {
  const org = contact.organization || contact.account || {};
  const emailStatus = normalizeEmailStatus(contact.email_status);
  // Build the structured phone list from the array, then fold in any
  // shortcut fields (corporate_phone, mobile_phone, etc.) that Apollo
  // populated separately. See `mergePhoneShortcuts` for the rationale.
  const phoneNumbers = mergePhoneShortcuts(derivePhoneNumbers(contact.phone_numbers), {
    phone: contact.phone,
    corporate_phone: contact.corporate_phone,
    mobile_phone: contact.mobile_phone,
    direct_phone: contact.direct_phone,
    home_phone: contact.home_phone,
    other_phone: contact.other_phone,
  });
  // Walk the fallback chain trimming each candidate so a whitespace-only
  // shortcut (e.g. `contact.phone === '   '`) doesn't end up on the row
  // — `mergePhoneShortcuts` already drops blanks from `phone_numbers[]`,
  // so the legacy `phone` column needs the same guard for consistency.
  const fallbackPhone = (
    [
      pickPrimary(phoneNumbers)?.number,
      contact.phone_numbers?.[0]?.raw_number,
      contact.phone_numbers?.[0]?.sanitized_number,
      contact.sanitized_phone,
      contact.phone,
    ]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v.length > 0)
  ) || '';
  // Trim entries, drop blanks, and case-insensitively exclude the primary
  // `contact.email` so the array never carries the same address twice in
  // different casings. De-dupe across the array itself by the same lowercase
  // key so Apollo dupes don't leak through either.
  const primaryEmailKey = (contact.email || '').trim().toLowerCase();
  const personalEmails = Array.isArray(contact.personal_emails)
    ? (() => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const raw of contact.personal_emails) {
          if (typeof raw !== 'string') continue;
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (key === primaryEmailKey) continue;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(trimmed);
        }
        return out;
      })()
    : [];
  const employmentHistory = Array.isArray(contact.employment_history)
    ? contact.employment_history.map((e) => ({
        organization_name: e?.organization_name || '',
        title: e?.title || '',
        start_date: e?.start_date || '',
        end_date: e?.end_date || '',
        current: !!e?.current,
      }))
    : [];
  const education = Array.isArray(contact.education)
    ? contact.education
        .map((e) => ({
          school: e?.school || '',
          degree: e?.degree || '',
          field_of_study: e?.field_of_study || '',
          start_year: e?.start_year ?? undefined,
          end_year: e?.end_year ?? undefined,
        }))
        .filter((e) => e.school || e.degree)
    : [];

  const out: NormalizedLead = {
    first_name: contact.first_name || '',
    last_name: contact.last_name || '',
    email: contact.email || '',
    email_status: emailStatus,
    phone: fallbackPhone,
    title: contact.title || contact.headline || '',
    company_name: org.name || contact.organization_name || '',
    company_website: org.website_url || org.primary_domain || org.domain || '',
    company_industry: org.industry || '',
    company_size:
      org.estimated_num_employees != null
        ? String(org.estimated_num_employees)
        : '',
    company_revenue:
      org.annual_revenue != null ? String(org.annual_revenue) : '',
    apollo_id: contact.id || '',
    linkedin_url: contact.linkedin_url || '',
    photo_url: contact.photo_url || '',
    location: contact.present_raw_address || buildLocation(contact),
    stage_id: defaultStageId || '',
    source: 'apollo',
    score: 75,
    last_activity_at:
      contact.last_activity_date ||
      contact.updated_at ||
      contact.created_at ||
      new Date().toISOString(),

    headline: contact.headline || '',
    bio: contact.bio || '',
    twitter_url: contact.twitter_url || '',
    github_url: contact.github_url || '',
    facebook_url: contact.facebook_url || '',
    linkedin_uid: contact.linkedin_uid || '',
    linkedin_id: contact.linkedin_id || '',
    seniority: contact.seniority || '',
    departments: Array.isArray(contact.departments) ? contact.departments : [],
    subdepartments: Array.isArray(contact.subdepartments) ? contact.subdepartments : [],
    functions: Array.isArray(contact.functions) ? contact.functions : [],
    language_codes: Array.isArray(contact.language_codes) ? contact.language_codes : [],
    intent_topics: Array.isArray(contact.intent_topics) ? contact.intent_topics : [],
    employment_history: employmentHistory,
    education,
    phone_numbers: phoneNumbers,
    mobile_phone: pickMobile(phoneNumbers),
    direct_phone: pickDirect(phoneNumbers),
    corporate_phone: pickByType(phoneNumbers, 'hq'),
    home_phone: pickByType(phoneNumbers, 'home'),
    other_phone: pickByType(phoneNumbers, 'other'),
    personal_emails: personalEmails,
    phone_status: pickPrimary(phoneNumbers)?.status || '',
    time_zone: contact.time_zone || '',
    person_city: contact.person_city || contact.city || '',
    person_state: contact.person_state || contact.state || '',
    person_country: contact.person_country || contact.country || '',
    extrapolated_email: contact.extrapolated_email || '',
    hubspot_id: contact.hubspot_id || '',
    salesforce_id: contact.salesforce_id || '',
    crm_owner_id: contact.crm_owner_id || '',
    apollo_account_id: contact.apollo_account_id || '',
    apollo_original_source: contact.apollo_original_source || contact.original_source || '',
  };

  const followersCount = finiteNumber(contact.linkedin_followers_count);
  if (followersCount !== undefined) out.linkedin_followers_count = followersCount;
  const extrapolatedConfidence = finiteNumber(contact.extrapolated_email_confidence);
  if (extrapolatedConfidence !== undefined) out.extrapolated_email_confidence = extrapolatedConfidence;
  const contactIntent = finiteNumber(contact.intent_strength);
  if (contactIntent !== undefined) out.intent_strength = contactIntent;
  if (contact.is_likely_to_engage != null) out.is_likely_to_engage = !!contact.is_likely_to_engage;
  if (contact.email_domain_catchall != null) out.email_domain_catchall = !!contact.email_domain_catchall;
  if (contact.apollo_created_at) out.apollo_created_at = contact.apollo_created_at;
  if (contact.apollo_updated_at) out.apollo_updated_at = contact.apollo_updated_at;

  // ---- Phase-2 workspace state (Plan 05 Phase 2 Half B) ----------------
  if (contact.owner_id) out.apollo_owner_id = contact.owner_id;
  if (contact.owner_name) out.apollo_owner_name = contact.owner_name;
  if (contact.contact_stage_id) out.apollo_contact_stage_id = contact.contact_stage_id;
  if (contact.contact_stage_name) out.apollo_contact_stage_name = contact.contact_stage_name;
  // Same "always-assign, possibly-empty" contract as the account normalizer
  // above — see the comment in `normalizeAccount` for the full rationale.
  // If a label / list / custom-field is removed in Apollo, the next sync
  // must clear the CRM row; guarding on `length > 0` would freeze stale data.
  out.apollo_lists = extractContactLists(contact as unknown as Record<string, unknown>);
  const contactLabelInfo = extractLabels(contact as unknown as Record<string, unknown>);
  out.apollo_label_ids = contactLabelInfo.ids;
  out.apollo_label_names = contactLabelInfo.names;
  out.apollo_custom_fields = extractCustomFields(contact as unknown as Record<string, unknown>);
  const contactScore = finiteNumber(contact.apollo_score) ?? finiteNumber(contact.contact_score);
  if (contactScore !== undefined) out.apollo_score = contactScore;
  if (contact.creator_id) out.apollo_creator_id = contact.creator_id;
  if (contact.account_playbook_statuses !== undefined) {
    out.apollo_account_playbook_statuses = contact.account_playbook_statuses;
  }
  const emailsSent = finiteNumber(contact.emails_sent_count);
  if (emailsSent !== undefined) out.apollo_emails_sent_count = emailsSent;
  const emailsOpened = finiteNumber(contact.emails_opened_count);
  if (emailsOpened !== undefined) out.apollo_emails_opened_count = emailsOpened;
  const emailsClicked = finiteNumber(contact.emails_clicked_count);
  if (emailsClicked !== undefined) out.apollo_emails_clicked_count = emailsClicked;
  const emailsReplied = finiteNumber(contact.emails_replied_count);
  if (emailsReplied !== undefined) out.apollo_emails_replied_count = emailsReplied;
  const emailsBounced = finiteNumber(contact.emails_bounced_count);
  if (emailsBounced !== undefined) out.apollo_emails_bounced_count = emailsBounced;
  if (contact.last_emailed_at) out.apollo_last_emailed_at = contact.last_emailed_at;
  if (contact.last_email_opened_at) out.apollo_last_email_opened_at = contact.last_email_opened_at;
  if (contact.last_email_replied_at) out.apollo_last_email_replied_at = contact.last_email_replied_at;
  if (contact.active_sequence_id) out.apollo_active_sequence_id = contact.active_sequence_id;
  if (contact.active_sequence_name) out.apollo_active_sequence_name = contact.active_sequence_name;
  const seqStep = finiteNumber(contact.active_sequence_step);
  if (seqStep !== undefined) out.apollo_active_sequence_step = seqStep;
  if (contact.active_sequence_paused != null) {
    out.apollo_active_sequence_paused = !!contact.active_sequence_paused;
  }
  const openTasks = finiteNumber(contact.open_tasks_count);
  if (openTasks !== undefined) out.apollo_open_tasks_count = openTasks;
  const overdueTasks = finiteNumber(contact.overdue_tasks_count);
  if (overdueTasks !== undefined) out.apollo_overdue_tasks_count = overdueTasks;
  const notesCount = finiteNumber(contact.notes_count);
  if (notesCount !== undefined) out.apollo_notes_count = notesCount;
  if (contact.latest_note_snippet) out.apollo_latest_note_snippet = contact.latest_note_snippet;

  return out;
}
