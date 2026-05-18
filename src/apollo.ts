// Apollo-specific helpers: HTTP client, response/entity types, and the
// normalizers that convert Apollo's payloads into the shape the Claimyx CRM
// stores in `Company` / `Lead` rows.

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
        // Apollo gateway / upstream errors are transient — same short
        // backoff as 429. Beyond attempt < 3, give up and let the caller
        // decide whether to fail the run.
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
  label_ids?: string[];
  num_contacts?: number;
  last_activity_date?: string;
  created_at?: string;
  updated_at?: string;
  phone?: string;
  sanitized_phone?: string;
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
}

/** Shape of a Company row in the CRM, after normalization from Apollo. */
export interface NormalizedCompany {
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
}

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
  return {
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
  };
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
    id: '', // no account id — see comment above
    name: org.name || '',
    domain:
      org.primary_domain || org.domain || extractDomain(org.website_url),
    organization_id: org.id || '',
    organization: org,
  };
}

/** Raw Apollo `/mixed_people/search` person row. Subset of fields we use. */
export interface ApolloContactInput {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  email_status?: string;
  phone_numbers?: { raw_number?: string; sanitized_number?: string }[];
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
}

/** Shape of a Lead row in the CRM, after normalization from Apollo. */
export interface NormalizedLead {
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
  const firstPhone =
    contact.phone_numbers?.[0]?.raw_number ||
    contact.phone_numbers?.[0]?.sanitized_number ||
    contact.sanitized_phone ||
    '';
  return {
    first_name: contact.first_name || '',
    last_name: contact.last_name || '',
    email: contact.email || '',
    email_status: emailStatus,
    phone: firstPhone,
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
  };
}
