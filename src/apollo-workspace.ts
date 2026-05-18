// Apollo-workspace helpers: types and HTTP wrappers for the Phase 2 set of
// Apollo endpoints that drive the "Apollo workspace" cards (lists, labels,
// custom fields, account stages, classifications) and the paid on-demand
// reveals (mobile / personal email via apollo_people_match +
// apollo_people_phone_enrichment_status).
//
// Lives in a separate module from `apollo.ts` because:
//   - apollo.ts already exports the normalizers; this is purely workspace
//     state + engagement counters + sequence state. Two modules keep the
//     compile graph clean and let consumers import only what they need.
//   - Engagement + sequence calls are batched per page after the contact
//     write loop in syncApolloLeads — those helpers belong with the other
//     workspace plumbing, not the row-shape normalizers.
//
// Functions in this module accept either the raw Apollo response or a
// pre-extracted slice; callers in the sales-crm functions can mix and match
// without re-implementing the shape adapters.

// Import the HTTP client directly from `./apollo-http.ts` (not `./apollo.ts`)
// to avoid an apollo ↔ apollo-workspace circular import — apollo.ts now also
// depends on this module, so it cannot be the source of `apolloPost`.
import { apolloPost, type ApolloResponse } from './apollo-http.ts';
import { sleep } from './text.ts';

// ---------------------------------------------------------------------------
// Workspace types — labels, lists, custom fields, stages, classifications
// ---------------------------------------------------------------------------

/**
 * Apollo workspace label (the colored tags you apply to contacts / accounts
 * in the Apollo UI). Distinct from custom fields — labels are workspace-wide
 * enums; custom fields are key/value rows.
 */
export interface ApolloLabel {
  id: string;
  name: string;
  color?: string;
}

/**
 * Apollo saved list — a workspace-defined collection of contacts or accounts.
 * The CRM stores `{id, name}` pairs on Lead.apollo_lists / Company.apollo_account_lists.
 */
export interface ApolloList {
  id: string;
  name: string;
  cached_target_count?: number;
}

/**
 * Apollo account-stage definition. Resolved server-side to a stage name so
 * the frontend never has to render an opaque id.
 */
export interface ApolloAccountStage {
  id: string;
  name: string;
  position?: number;
}

/**
 * Apollo workspace user (account owner / creator). The CRM only needs id +
 * display name for the "Apollo owner" chip; everything else (email, role) is
 * left in the raw payload for callers that want it.
 */
export interface ApolloWorkspaceUser {
  id: string;
  name: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

/**
 * Typed custom-field definition from `/v1/typed_custom_fields`. Keyed on
 * `id` (not `name`) because users can rename custom fields without breaking
 * sync — the id is stable.
 */
export interface ApolloTypedCustomField {
  id: string;
  name: string;
  field_type: string;
  modality: 'contact' | 'account';
  options?: string[];
}

/**
 * Account classification flag. Apollo's UI exposes four mutually-non-exclusive
 * flags on each account; we store the active ones as a string array so a
 * single company can be "Target + Customer" without modeling four bools.
 */
export type ApolloAccountClassification = 'target' | 'competitor' | 'partner' | 'customer';

/**
 * Existing-customer status, derived server-side from the active set of
 * classifications + `last_activity_date`:
 *   - `customer` flag present, recent activity ........ active_customer
 *   - `customer` flag present, no recent activity ..... churned_customer
 *   - `target` flag present, no customer flag ......... prospect
 *   - neither flag ..................................... never_engaged
 */
export type ExistingCustomerStatus =
  | 'prospect'
  | 'active_customer'
  | 'churned_customer'
  | 'never_engaged';

// ---------------------------------------------------------------------------
// Workspace-state derivations
// ---------------------------------------------------------------------------

/**
 * Resolve an account's classifications array from an Apollo account payload.
 * Apollo represents these as either an explicit `account_classifications`
 * array (newer endpoint) or per-flag booleans (`is_target`, `is_customer`,
 * etc., older shape). This helper accepts both and normalizes to our enum.
 */
export function deriveAccountClassifications(
  account: Record<string, unknown> | null | undefined,
): ApolloAccountClassification[] {
  if (!account) return [];
  const out: ApolloAccountClassification[] = [];
  // Explicit array form (preferred).
  const raw = (account as { account_classifications?: unknown }).account_classifications;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const v = typeof item === 'string' ? item.toLowerCase() : '';
      if (v === 'target' || v === 'competitor' || v === 'partner' || v === 'customer') {
        if (!out.includes(v)) out.push(v);
      }
    }
  }
  // Per-flag boolean form (fallback).
  if ((account as { is_target?: boolean }).is_target && !out.includes('target')) out.push('target');
  if ((account as { is_customer?: boolean }).is_customer && !out.includes('customer')) out.push('customer');
  if ((account as { is_competitor?: boolean }).is_competitor && !out.includes('competitor')) out.push('competitor');
  if ((account as { is_partner?: boolean }).is_partner && !out.includes('partner')) out.push('partner');
  return out;
}

/**
 * Days that count as "recent activity" when deriving `existing_customer_status`.
 * 180d is a reasonable churn window for B2B SaaS — adjust here once instead
 * of in each call site.
 */
export const CUSTOMER_ACTIVITY_WINDOW_DAYS = 180;

/**
 * Derive a single `existing_customer_status` enum value from the active
 * classifications + `last_activity_date`. See {@link ExistingCustomerStatus}
 * for the decision table.
 */
export function deriveExistingCustomerStatus(
  classifications: ApolloAccountClassification[],
  lastActivityIso?: string | null,
): ExistingCustomerStatus {
  const hasCustomer = classifications.includes('customer');
  const hasTarget = classifications.includes('target');
  if (hasCustomer) {
    if (!lastActivityIso) return 'churned_customer';
    const lastMs = new Date(lastActivityIso).getTime();
    if (!Number.isFinite(lastMs)) return 'churned_customer';
    const ageMs = Date.now() - lastMs;
    return ageMs <= CUSTOMER_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
      ? 'active_customer'
      : 'churned_customer';
  }
  if (hasTarget) return 'prospect';
  return 'never_engaged';
}

/**
 * Extract the `{id, name}[]` shape we store on Lead.apollo_lists from a raw
 * Apollo contact payload. Apollo returns this as `contact_list_memberships`,
 * `contact_lists`, or `labels` depending on endpoint vintage — try all three.
 */
export function extractContactLists(
  contact: Record<string, unknown> | null | undefined,
): ApolloList[] {
  if (!contact) return [];
  const candidates = [
    (contact as { contact_list_memberships?: unknown }).contact_list_memberships,
    (contact as { contact_lists?: unknown }).contact_lists,
  ];
  for (const cand of candidates) {
    if (Array.isArray(cand) && cand.length > 0) {
      const out: ApolloList[] = [];
      for (const item of cand) {
        if (!item || typeof item !== 'object') continue;
        const id = String((item as { id?: unknown }).id || (item as { list_id?: unknown }).list_id || '');
        const name = String((item as { name?: unknown }).name || (item as { list_name?: unknown }).list_name || '');
        if (id || name) out.push({ id, name });
      }
      if (out.length > 0) return out;
    }
  }
  return [];
}

/**
 * Same shape as {@link extractContactLists} but for account-level lists
 * (Apollo's "Saved searches" / "Account lists"). Mostly mirrors the contact
 * version; kept separate for clarity at call sites.
 */
export function extractAccountLists(
  account: Record<string, unknown> | null | undefined,
): ApolloList[] {
  if (!account) return [];
  const candidates = [
    (account as { account_list_memberships?: unknown }).account_list_memberships,
    (account as { account_lists?: unknown }).account_lists,
  ];
  for (const cand of candidates) {
    if (Array.isArray(cand) && cand.length > 0) {
      const out: ApolloList[] = [];
      for (const item of cand) {
        if (!item || typeof item !== 'object') continue;
        const id = String((item as { id?: unknown }).id || (item as { list_id?: unknown }).list_id || '');
        const name = String((item as { name?: unknown }).name || (item as { list_name?: unknown }).list_name || '');
        if (id || name) out.push({ id, name });
      }
      if (out.length > 0) return out;
    }
  }
  return [];
}

/**
 * Extract label IDs + names from a raw Apollo contact/account payload.
 * Apollo's response shape: an array of either ID strings, or `{id, name}`
 * objects (newer endpoints). Returns `{ids, names}` so consumers can store
 * both without re-traversing.
 */
export function extractLabels(
  entity: Record<string, unknown> | null | undefined,
): { ids: string[]; names: string[] } {
  if (!entity) return { ids: [], names: [] };
  const raw =
    (entity as { labels?: unknown }).labels ??
    (entity as { typed_labels?: unknown }).typed_labels ??
    [];
  if (!Array.isArray(raw)) return { ids: [], names: [] };
  const ids: string[] = [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      ids.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const id = (item as { id?: unknown }).id;
      const name = (item as { name?: unknown }).name;
      if (typeof id === 'string' && id) ids.push(id);
      if (typeof name === 'string' && name) names.push(name);
    }
  }
  return { ids, names };
}

/**
 * Extract Apollo workspace custom fields from a contact/account row. Returns
 * a `{ [field_id]: value }` map keyed on the field ID (not the label) so
 * renames in Apollo don't orphan the stored values.
 *
 * Apollo serializes this as `typed_custom_fields` (array of
 * `{id, value, name}`) on newer endpoints, or `custom_fields` (flat object,
 * keyed by id) on older ones. Both shapes collapse to the same id-keyed map.
 */
export function extractCustomFields(
  entity: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!entity) return {};
  const typed = (entity as { typed_custom_fields?: unknown }).typed_custom_fields;
  if (Array.isArray(typed)) {
    const out: Record<string, unknown> = {};
    for (const item of typed) {
      if (!item || typeof item !== 'object') continue;
      const id = (item as { id?: unknown }).id;
      const value = (item as { value?: unknown }).value;
      if (typeof id === 'string' && id) out[id] = value;
    }
    return out;
  }
  const flat = (entity as { custom_fields?: unknown }).custom_fields;
  if (flat && typeof flat === 'object' && !Array.isArray(flat)) {
    return flat as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Typed custom fields — one-shot per sync run, cached in state
// ---------------------------------------------------------------------------

/**
 * Fetch the workspace's typed custom-field schema definitions. Call ONCE per
 * sync run, cache the result in `SyncRun.stats.typed_custom_fields` so the
 * frontend can render label-aware key/value tables without each contact
 * sync re-fetching the schema.
 *
 * Returns an empty array on any failure — the caller can still write the
 * id-keyed custom-field values via {@link extractCustomFields}; the labels
 * just won't render until the next successful schema fetch.
 */
export async function fetchTypedCustomFields(
  apiKey: string,
): Promise<ApolloTypedCustomField[]> {
  const res = await apolloPost<{ typed_custom_fields?: unknown[] }>(
    '/typed_custom_fields/search',
    apiKey,
    { page: 1, per_page: 100 },
  );
  if (!res.ok || !Array.isArray(res.data.typed_custom_fields)) return [];
  const out: ApolloTypedCustomField[] = [];
  for (const item of res.data.typed_custom_fields) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    const name = (item as { name?: unknown }).name;
    if (typeof id !== 'string' || !id) continue;
    out.push({
      id,
      name: typeof name === 'string' ? name : id,
      field_type: String((item as { field_type?: unknown }).field_type || ''),
      modality: ((item as { modality?: unknown }).modality === 'account' ? 'account' : 'contact') as
        | 'contact'
        | 'account',
      options: Array.isArray((item as { options?: unknown }).options)
        ? ((item as { options: unknown[] }).options.filter((o) => typeof o === 'string') as string[])
        : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engagement counters — batched per page after contact write loop
// ---------------------------------------------------------------------------

/**
 * Per-contact engagement counters derived from `/v1/emailer_messages`. All
 * counts are window-bounded by the caller; the default sync window is the
 * last 180 days (engagement older than that rarely changes mid-sync and
 * isn't worth re-aggregating every 5 min).
 */
export interface ApolloContactEngagement {
  apollo_contact_id: string;
  emails_sent_count: number;
  emails_opened_count: number;
  emails_clicked_count: number;
  emails_replied_count: number;
  emails_bounced_count: number;
  last_emailed_at?: string;
  last_email_opened_at?: string;
  last_email_replied_at?: string;
}

/**
 * Default engagement-window in days. 180 mirrors {@link CUSTOMER_ACTIVITY_WINDOW_DAYS}
 * and the plan-05 spec: "engagement counters bounded to last 180 days of
 * emailer_messages".
 */
export const DEFAULT_ENGAGEMENT_WINDOW_DAYS = 180;

/**
 * Fetch engagement counters for a batch of contact ids in a single Apollo
 * call. Used by syncApolloLeads after each contact write loop and by
 * backfillApolloWorkspace.
 *
 * Apollo's `/v1/emailer_messages/search` accepts `contact_ids[]` + a date
 * filter; the response is paginated. This helper walks every page within the
 * window so the returned counts are exact, not partial.
 *
 * Returns one entry per contact id from `contact_ids`; contacts with zero
 * messages in the window are STILL returned with all-zero counters so the
 * write step can clear stale counters from a previous sync (a contact that
 * stopped getting emails should show 0, not the last non-zero count).
 */
export async function fetchEngagementBatch(
  apiKey: string,
  contact_ids: string[],
  options?: { window_days?: number; max_pages?: number },
): Promise<ApolloContactEngagement[]> {
  if (contact_ids.length === 0) return [];
  const windowDays = options?.window_days ?? DEFAULT_ENGAGEMENT_WINDOW_DAYS;
  const maxPages = options?.max_pages ?? 20; // 20 * 100 = 2000 messages cap per batch
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Seed every requested contact with a zero row so contacts with no
  // messages still get written (clears stale counters from a previous sync).
  const counters = new Map<string, ApolloContactEngagement>();
  for (const id of contact_ids) {
    counters.set(id, {
      apollo_contact_id: id,
      emails_sent_count: 0,
      emails_opened_count: 0,
      emails_clicked_count: 0,
      emails_replied_count: 0,
      emails_bounced_count: 0,
    });
  }

  let page = 1;
  while (page <= maxPages) {
    const res = await apolloPost<{
      emailer_messages?: Record<string, unknown>[];
      pagination?: { total_pages?: number };
    }>('/emailer_messages/search', apiKey, {
      contact_ids,
      sent_at_after: sinceIso,
      per_page: 100,
      page,
    });
    if (!res.ok) break;
    const messages = res.data.emailer_messages || [];
    for (const m of messages) {
      const cid = String((m as { contact_id?: unknown }).contact_id || '');
      if (!cid || !counters.has(cid)) continue;
      const entry = counters.get(cid)!;
      const sentAt = String((m as { sent_at?: unknown }).sent_at || '');
      const openedAt = String((m as { opened_at?: unknown }).opened_at || '');
      const repliedAt = String((m as { replied_at?: unknown }).replied_at || '');
      const clicked = !!(m as { clicked_at?: unknown }).clicked_at;
      const bouncedAt = (m as { bounced_at?: unknown }).bounced_at;
      const status = String((m as { state?: unknown }).state || '');
      if (sentAt) {
        entry.emails_sent_count += 1;
        if (!entry.last_emailed_at || sentAt > entry.last_emailed_at) entry.last_emailed_at = sentAt;
      }
      if (openedAt) {
        entry.emails_opened_count += 1;
        if (!entry.last_email_opened_at || openedAt > entry.last_email_opened_at) {
          entry.last_email_opened_at = openedAt;
        }
      }
      if (clicked) entry.emails_clicked_count += 1;
      if (repliedAt) {
        entry.emails_replied_count += 1;
        if (!entry.last_email_replied_at || repliedAt > entry.last_email_replied_at) {
          entry.last_email_replied_at = repliedAt;
        }
      }
      if (bouncedAt || status === 'bounced') entry.emails_bounced_count += 1;
    }
    const totalPages = res.data.pagination?.total_pages || 1;
    if (page >= totalPages || messages.length === 0) break;
    page += 1;
  }
  return Array.from(counters.values());
}

// ---------------------------------------------------------------------------
// Sequence state
// ---------------------------------------------------------------------------

/**
 * Active-sequence enrollment state for a single contact. `null` means the
 * contact isn't currently enrolled in any sequence (or every enrollment has
 * `finished_at` set).
 */
export interface ApolloSequenceState {
  apollo_contact_id: string;
  sequence_id?: string;
  sequence_name?: string;
  current_step?: number;
  is_paused?: boolean;
}

/**
 * Fetch the active sequence enrollment for a single contact. Uses
 * `/v1/emailer_campaigns/contact/{contact_id}`. Returns null when:
 *  - the contact has no enrollments
 *  - every enrollment is finished
 *  - the request fails (best-effort; we'd rather miss a sequence chip than
 *    fail the whole sync chunk)
 */
export async function fetchSequenceState(
  apiKey: string,
  contact_id: string,
): Promise<ApolloSequenceState | null> {
  if (!contact_id) return null;
  const res = await apolloPost<{ emailer_campaign_contacts?: Record<string, unknown>[] }>(
    `/emailer_campaigns/contact/${encodeURIComponent(contact_id)}`,
    apiKey,
    {},
  );
  if (!res.ok) return null;
  const enrollments = res.data.emailer_campaign_contacts || [];
  // Prefer the most recently started enrollment that isn't finished.
  const active = enrollments
    .filter((e) => !(e as { finished_at?: unknown }).finished_at)
    .sort((a, b) => {
      const aIso = String((a as { added_at?: unknown }).added_at || '');
      const bIso = String((b as { added_at?: unknown }).added_at || '');
      return bIso.localeCompare(aIso);
    })[0];
  if (!active) return null;
  const campaign = (active as { emailer_campaign?: Record<string, unknown> }).emailer_campaign;
  return {
    apollo_contact_id: contact_id,
    sequence_id: String((active as { emailer_campaign_id?: unknown }).emailer_campaign_id || ''),
    sequence_name: campaign ? String((campaign as { name?: unknown }).name || '') : '',
    current_step: Number((active as { current_step_number?: unknown }).current_step_number || 0) || undefined,
    is_paused: !!(active as { paused?: unknown }).paused,
  };
}

// ---------------------------------------------------------------------------
// Phone reveal — apollo_people_match + phone_enrichment_status polling
// ---------------------------------------------------------------------------

/**
 * Status payload returned by `/people/phone_enrichment_status/{request_id}`.
 * Apollo's mobile-reveal is async on some plans — we poll until the request
 * transitions to `completed` or `failed`.
 */
export interface ApolloEnrichmentStatus {
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unknown';
  phone_numbers?: Array<{ raw_number?: string; type?: string; sanitized_number?: string }>;
  error?: string;
}

/**
 * Sleep step + cap for the phone-reveal poll loop. Apollo typically resolves
 * within 2-5s; we retry every 1.5s up to ~15s total before giving up. Failure
 * here is non-fatal — the caller stores whatever phones came back from the
 * initial `apollo_people_match` call.
 */
export const PHONE_POLL_INTERVAL_MS = 1500;
export const PHONE_POLL_MAX_ATTEMPTS = 10;

/**
 * Poll Apollo's phone-enrichment status endpoint until the request settles
 * or we hit {@link PHONE_POLL_MAX_ATTEMPTS} attempts. Returns the final
 * status payload (which may be `processing` if we time out — caller decides
 * what to do with that).
 *
 * Pass the `request_id` returned by `apollo_people_match` when called with
 * `reveal_phone_number: true`.
 */
export async function pollPhoneEnrichmentStatus(
  apiKey: string,
  request_id: string,
): Promise<ApolloEnrichmentStatus> {
  if (!request_id) return { status: 'unknown' };
  for (let attempt = 0; attempt < PHONE_POLL_MAX_ATTEMPTS; attempt += 1) {
    const res: ApolloResponse<{
      status?: string;
      phone_numbers?: Array<{ raw_number?: string; type?: string; sanitized_number?: string }>;
      error?: string;
    }> = await apolloPost(
      `/people/phone_enrichment_status/${encodeURIComponent(request_id)}`,
      apiKey,
      {},
    );
    if (!res.ok) {
      // Distinguish transient vs persistent failures so we don't give up
      // on a slow-but-healthy poll:
      //  - 404 (any attempt): Apollo materializes the enrichment status row
      //    asynchronously, so 404 early in the poll is normal — keep polling
      //    until we either get a real status or hit PHONE_POLL_MAX_ATTEMPTS.
      //  - Other 4xx (>= attempt 2): client error that won't fix itself
      //    (bad request_id, auth, plan limit) — bail with `failed`.
      //  - 5xx / network (status 0): `apolloPost` already retried these with
      //    its own backoff ladder; if we still got !ok, treat as transient
      //    here too and keep polling. On final timeout the function falls
      //    through to the `processing` return so the caller can decide.
      const isNotFound = res.status === 404;
      const isClientError = res.status >= 400 && res.status < 500;
      if (!isNotFound && isClientError && attempt >= 2) {
        return { status: 'failed', error: res.data?.message || `status ${res.status}` };
      }
      await sleep(PHONE_POLL_INTERVAL_MS);
      continue;
    }
    const status = String(res.data.status || '').toLowerCase();
    if (status === 'completed') {
      return {
        status: 'completed',
        phone_numbers: res.data.phone_numbers,
      };
    }
    if (status === 'failed') {
      return { status: 'failed', error: res.data.error };
    }
    await sleep(PHONE_POLL_INTERVAL_MS);
  }
  return { status: 'processing' };
}
