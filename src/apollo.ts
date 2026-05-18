// Apollo-specific helpers: HTTP client, response/entity types, and the
// normalizers that convert Apollo's payloads into the shape the Claimyx CRM
// stores in `Company` / `Lead` rows.
//
// Phase-06 expanded the type set and normalizers to cover ~50 additional
// Lead / Company fields (phones, funding, hiring, news, headcount,
// employment history, intent, social URLs, corporate family, etc.).

import { buildLocation, extractDomain, normalizeEmailStatus, sleep } from './text.ts';

// ---------------------------------------------------------------------------
// Apollo constants
// ---------------------------------------------------------------------------

/** Base URL for Apollo's REST API v1. */
export const APOLLO_BASE = 'https://api.apollo.io/api/v1';

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
 * extractors below so accounts with long histories don't blow row size past
 * the 50KB target. Tune here if a downstream consumer needs more depth.
 */
export const FUNDING_EVENTS_CAP = 10;
export const JOB_POSTINGS_CAP = 10;
export const NEWS_ARTICLES_CAP = 5;
export const HEADCOUNT_CHART_CAP = 36; // 3y of monthly points

// ---------------------------------------------------------------------------
// Apollo HTTP
// ---------------------------------------------------------------------------

/**
 * Result of an {@link apolloPost} call. `ok` mirrors `response.ok` (true for
 * 2xx). `data` is the parsed JSON body regardless of status — non-2xx
 * responses are returned instead of thrown so callers can surface a useful
 * error message from `data.error` / `data.message`.
 *
 * IMPORTANT: callers MUST check `res.ok` before reading `res.data` as
 * success-shaped. Treating non-2xx as empty results masks operator-actionable
 * failures (401 invalid key, 403 quota, 400 bad request).
 */
export interface ApolloResponse<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T & { message?: string; error?: string };
}

/**
 * POST to an Apollo endpoint with a built-in retry ladder for transient
 * failures (4 attempts max, 500ms → 1s → 2s ≈ 3.5s total). Retries on:
 *
 * - 429 (rate limit) — Apollo's per-second cap usually clears in well under
 *   a second, so the short ladder is the right shape.
 * - 5xx (gateway / upstream errors) — also transient, same backoff.
 * - Network errors — same backoff via the outer catch.
 *
 * Anything longer just burns the chunk budget. Returns the parsed JSON
 * regardless of HTTP status (see {@link ApolloResponse}).
 *
 * `path` can be a full URL or a path relative to {@link APOLLO_BASE}.
 */
export async function apolloPost<T = Record<string, unknown>>(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<ApolloResponse<T>> {
  const url = path.startsWith('http') ? path : `${APOLLO_BASE}${path}`;
  let lastError: ApolloResponse<T> | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as T & {
        message?: string;
        error?: string;
      };
      if (response.status === 429 && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (response.status >= 500 && response.status < 600 && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return { ok: response.ok, status: response.status, data };
    } catch (err) {
      lastError = {
        ok: false,
        status: 0,
        data: {
          message:
            (err as { message?: string })?.message || 'Apollo network error',
        } as T & { message?: string },
      };
      if (attempt >= 2) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  return (
    lastError || {
      ok: false,
      status: 0,
      data: { message: 'Apollo request failed after retries' } as T & {
        message?: string;
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Phone-number derivation
// ---------------------------------------------------------------------------

/**
 * Map Apollo's free-form phone-type strings (`type_cd`, `type`) onto our
 * fixed enum. Apollo isn't fully consistent — some payloads use `mobile`,
 * some `mobile_phone`, some `cell`. Buckets every entry into one of
 * {mobile, direct, hq, work, other} so the UI can label and pick.
 */
export function mapPhoneType(
  typeRaw: string | null | undefined,
): 'work' | 'mobile' | 'direct' | 'hq' | 'other' {
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
  if (t.includes('work') || t === 'office' || t === 'business') return 'work';
  return 'other';
}

/** Structured phone entry stored on Lead and Company rows. */
export interface PhoneNumberEntry {
  type: 'work' | 'mobile' | 'direct' | 'hq' | 'other';
  number: string;
  primary: boolean;
  status: string;
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
 * when Apollo doesn't flag one).
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
      status: p?.status || p?.dnc_status || '',
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

/** The entry flagged `primary` (or the first entry as fallback), or null. */
export function pickPrimary(numbers: PhoneNumberEntry[]): PhoneNumberEntry | null {
  return numbers.find((p) => p.primary) || numbers[0] || null;
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
 * {@link JOB_POSTINGS_CAP} entries.
 */
export function extractJobPostings(
  postings: ApolloJobPosting[] | null | undefined,
): JobPostingEntry[] {
  if (!Array.isArray(postings)) return [];
  const out: JobPostingEntry[] = [];
  for (const p of postings) {
    out.push({
      title: p?.title || '',
      location: p?.location || '',
      url: p?.url || '',
      posted_at: p?.posted_at || p?.date || '',
    });
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
 * {@link NEWS_ARTICLES_CAP} entries.
 */
export function extractNewsArticles(
  articles: ApolloNewsArticle[] | null | undefined,
): NewsArticleEntry[] {
  if (!Array.isArray(articles)) return [];
  const out: NewsArticleEntry[] = [];
  for (const a of articles) {
    out.push({
      title: a?.title || '',
      url: a?.url || '',
      published_at: a?.published_at || a?.publish_date || '',
      summary: a?.summary || a?.description || '',
    });
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
): { number: string; source: string; status: string } | undefined {
  const p = pickPrimary(numbers);
  if (!p) return undefined;
  return { number: p.number, source: p.type, status: p.status };
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
  phone_numbers?: ApolloPhoneEntry[];
  sanitized_phone?: string;
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
}

/** Shape of a Company row in the CRM, after normalization from Apollo. */
export interface NormalizedCompany {
  // Pre-Phase-06 fields ----------------------------------------------------
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

  // Phase-06 additions ----------------------------------------------------
  // Strings + arrays + objects always present (empty when Apollo didn't
  // return anything). Numeric / boolean / optional-date fields are set
  // conditionally so empty Apollo payloads don't clobber known-good values.
  long_description: string;
  seo_description: string;
  logo_url: string;
  crunchbase_url: string;
  angellist_url: string;
  twitter_url: string;
  facebook_url: string;
  blog_url: string;
  chief_executive_officer: string;
  headquarters_street_address: string;
  headquarters_postal_code: string;
  account_stage_name: string;
  account_owner_name: string;
  parent_organization_name: string;
  acquired_by: string;
  acquisition_status: string;
  latest_funding_stage: string;
  organization_revenue_printed: string;
  annual_revenue_printed: string;
  total_funding_printed: string;
  org_chart_sector: string;
  existence_level: string;
  secondary_industries: string[];
  naics_codes: string[];
  sic_codes: string[];
  languages: string[];
  linkedin_specialties: string[];
  linkedin_industries: string[];
  latest_job_posting_titles: string[];
  seo_keywords: string[];
  domain_categories: string[];
  domain_history: string[];
  intent_topics: string[];
  subsidiary_organization_ids: string[];
  subsidiary_organization_names: string[];
  current_technologies: { name: string; category: string; first_seen: string }[];
  funding_events: FundingEventEntry[];
  job_postings: JobPostingEntry[];
  news_articles: NewsArticleEntry[];
  headcount_chart: HeadcountChartEntry[];
  organization_locations: ApolloSecondaryLocation[];
  phone_numbers: PhoneNumberEntry[];
  primary_phone?: { number: string; source: string; status: string };
  departmental_head_count: Record<string, number>;
  persona_counts: Record<string, number>;
  intent_signal_account: Record<string, unknown>;
  owned_by_organization_id: string;
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
}

/** Shape of a Lead row in the CRM, after normalization from Apollo. */
export interface NormalizedLead {
  // Pre-Phase-06 fields ----------------------------------------------------
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

  // Phase-06 additions ----------------------------------------------------
  headline: string;
  bio: string;
  twitter_url: string;
  github_url: string;
  facebook_url: string;
  linkedin_uid: string;
  linkedin_id: string;
  seniority: string;
  departments: string[];
  subdepartments: string[];
  functions: string[];
  language_codes: string[];
  intent_topics: string[];
  employment_history: ApolloEmploymentHistoryEntry[];
  education: ApolloEducationEntry[];
  phone_numbers: PhoneNumberEntry[];
  mobile_phone: string;
  direct_phone: string;
  phone_status: string;
  time_zone: string;
  person_city: string;
  person_state: string;
  person_country: string;
  extrapolated_email: string;
  hubspot_id: string;
  salesforce_id: string;
  crm_owner_id: string;
  apollo_account_id: string;
  apollo_original_source: string;
  linkedin_followers_count?: number;
  extrapolated_email_confidence?: number;
  intent_strength?: number;
  is_likely_to_engage?: boolean;
  email_domain_catchall?: boolean;
  apollo_created_at?: string;
  apollo_updated_at?: string;
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
    departmental_head_count:
      org.departmental_head_count && typeof org.departmental_head_count === 'object'
        ? org.departmental_head_count
        : {},
    persona_counts:
      org.persona_counts && typeof org.persona_counts === 'object'
        ? org.persona_counts
        : {},
    intent_signal_account:
      org.intent_signal_account && typeof org.intent_signal_account === 'object'
        ? org.intent_signal_account
        : {},
    owned_by_organization_id: org.owned_by_organization_id || '',
  };

  if (primaryPhoneStructured) out.primary_phone = primaryPhoneStructured;
  if (org.founded_year != null) out.founded_year = Number(org.founded_year);
  if (org.publicly_traded_symbol) out.publicly_traded_symbol = org.publicly_traded_symbol;
  if (org.publicly_traded_exchange) out.publicly_traded_exchange = org.publicly_traded_exchange;
  if (org.market_cap != null) out.market_cap = Number(org.market_cap);
  if (org.organization_revenue != null) out.organization_revenue = Number(org.organization_revenue);
  if (org.total_funding != null) out.total_funding = Number(org.total_funding);
  if (org.latest_funding_amount != null) out.latest_funding_amount = Number(org.latest_funding_amount);
  else if (latestFunding) out.latest_funding_amount = latestFunding.amount;
  if (org.latest_funding_round_date) out.latest_funding_round_date = org.latest_funding_round_date;
  else if (latestFunding && latestFunding.date) out.latest_funding_round_date = latestFunding.date;
  if (org.organization_headcount_six_month_growth != null)
    out.headcount_growth_6m = Number(org.organization_headcount_six_month_growth);
  if (org.organization_headcount_twelve_month_growth != null)
    out.headcount_growth_12m = Number(org.organization_headcount_twelve_month_growth);
  if (org.organization_headcount_twenty_four_month_growth != null)
    out.headcount_growth_24m = Number(org.organization_headcount_twenty_four_month_growth);
  if (org.num_open_jobs != null) out.num_open_jobs = Number(org.num_open_jobs);
  if (org.num_suborganizations != null) out.num_suborganizations = Number(org.num_suborganizations);
  if (org.monthly_visits != null) out.monthly_visits = Number(org.monthly_visits);
  if (org.monthly_visits_change_pct != null) out.monthly_visits_change_pct = Number(org.monthly_visits_change_pct);
  if (org.alexa_ranking != null) out.alexa_ranking = Number(org.alexa_ranking);
  if (org.intent_strength != null) out.intent_strength = Number(org.intent_strength);
  if (org.show_intent != null) out.show_intent = !!org.show_intent;
  if (org.is_b2b != null) out.is_b2b = !!org.is_b2b;
  if (org.acquired_at) out.acquired_at = org.acquired_at;
  if (org.linkedin_uid) out.linkedin_uid = org.linkedin_uid;
  if (org.linkedin_employee_count != null) out.linkedin_employee_count = Number(org.linkedin_employee_count);

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
 */
export function normalizeContact(
  contact: ApolloContactInput,
  defaultStageId: string,
): NormalizedLead {
  const org = contact.organization || contact.account || {};
  const emailStatus = normalizeEmailStatus(contact.email_status);
  const phoneNumbers = derivePhoneNumbers(contact.phone_numbers);
  const fallbackPhone =
    phoneNumbers[0]?.number ||
    contact.phone_numbers?.[0]?.raw_number ||
    contact.phone_numbers?.[0]?.sanitized_number ||
    contact.sanitized_phone ||
    '';
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

  if (contact.linkedin_followers_count != null)
    out.linkedin_followers_count = Number(contact.linkedin_followers_count);
  if (contact.extrapolated_email_confidence != null)
    out.extrapolated_email_confidence = Number(contact.extrapolated_email_confidence);
  if (contact.intent_strength != null) out.intent_strength = Number(contact.intent_strength);
  if (contact.is_likely_to_engage != null) out.is_likely_to_engage = !!contact.is_likely_to_engage;
  if (contact.email_domain_catchall != null) out.email_domain_catchall = !!contact.email_domain_catchall;
  if (contact.apollo_created_at) out.apollo_created_at = contact.apollo_created_at;
  if (contact.apollo_updated_at) out.apollo_updated_at = contact.apollo_updated_at;

  return out;
}
