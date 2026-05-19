// Quo (OpenPhone) integration helpers: HTTP client, sentiment/direction/
// status normalizers, the call-outcome / next-action enums, and the webhook
// authorization check used by the scheduled processor.
//
// These exist because the Quo integration sprawls across three Base44
// functions today (`syncQuoCalls`, `processQuoActivity`,
// `backfillCallNextActions`) — each independently re-implementing the HTTP
// client and copy-pasting the OUTCOMES / NEXT_ACTION_TYPES enums with a
// "keep in sync with..." comment. Centralizing here removes the sync debt
// and gives downstream surfaces (the Lead schema, the call queue UI) a
// single import for the canonical enum values.

import { sleep } from './text.ts';
import { getEnv } from './env.ts';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Base host for the Quo (OpenPhone) API. Does NOT include the `/v1`
 * version prefix — callers supply the full path (e.g. `/v1/calls`) and
 * {@link quoFetch} concatenates them.
 */
export const QUO_API_BASE = 'https://api.openphone.com';

const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * Default retry count. Chosen so the worst-case total backoff fits inside
 * Base44's `DEFAULT_CHUNK_TIME_BUDGET_MS` (55s).
 *
 * With `2 ** attempt * 1000` capped per-sleep at 30s, the worst-case
 * cumulative backoff is `1 + 2 + 4 + 8 + 16 = 31s` — well under the
 * chunk budget so the function still has time to record progress before
 * the gateway timeout. Bumping to 6 would push worst-case to 61s and
 * blow the budget.
 *
 * Callers in a Node / non-chunked context can override with a larger
 * value via `QuoFetchOptions.maxRetries`.
 */
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_REQUEST_GAP_MS = 150;

/**
 * Parse an HTTP `Retry-After` header value into a backoff-millisecond
 * count. Per RFC 9110, the header is either a non-negative integer (seconds)
 * OR an HTTP-date — this handles both. Returns `null` when the header is
 * missing or unparseable, so the caller can fall back to exponential backoff.
 */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Seconds form: per RFC 9110 this is strictly a non-negative integer.
  // Don't accept Number()'s extra forms (`"1e3"`, `"0.5"`) — those would
  // be invalid Retry-After values and silently mis-honoring them is worse
  // than falling through to the date parse / exponential backoff.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-date form: parse via Date.parse, clamp at 0 so a date already in
  // the past returns "retry immediately" rather than a negative sleep.
  const asTs = Date.parse(trimmed);
  if (Number.isFinite(asTs)) {
    return Math.max(0, asTs - Date.now());
  }
  return null;
}

/** Response envelope returned by {@link quoFetch}. */
export interface QuoResponse<T = Record<string, unknown>> {
  /** True iff the HTTP status was 2xx. */
  ok: boolean;
  /** HTTP status code. 0 indicates the request never completed (network error). */
  status: number;
  /** Parsed JSON body, or an error-shaped object when the request failed. */
  data: T & { message?: string; error?: string };
}

/** Optional knobs for {@link quoFetch}. */
export interface QuoFetchOptions {
  /**
   * Max retries AFTER the initial request, matching HTTP/RFC convention.
   * `maxRetries = 5` means 1 initial attempt + up to 5 retries = 6 total
   * attempts before bailing. Defaults to 5 — chosen so the worst-case
   * cumulative backoff (1+2+4+8+16 = 31s) fits inside Base44's 55s chunk
   * budget. See {@link DEFAULT_MAX_RETRIES} comment for the math.
   */
  maxRetries?: number;
  /**
   * Sleep applied after every terminal response — successful or not — to
   * smooth burst traffic toward Quo's 10 req/sec limit. Not applied on the
   * retry path (the retry's own backoff covers that gap). Defaults to 150ms.
   */
  requestGapMs?: number;
}

/**
 * GET a Quo (OpenPhone) endpoint with retry on 429/5xx. Honors the
 * `Retry-After` header when present and falls back to exponential backoff
 * (capped at 30s) otherwise.
 *
 * On every terminal response (whether `ok` or a non-retry 4xx) sleeps
 * `requestGapMs` before returning — this is the shared cooldown that keeps
 * parallel sibling calls under Quo's 10 req/sec limit.
 *
 * Errors are returned as `{ ok: false, status: 0 | 4xx | 5xx, data: { message } }`
 * rather than thrown, so the caller can decide per-endpoint whether a 404
 * is fatal or a soft miss.
 */
export async function quoFetch<T = Record<string, unknown>>(
  path: string,
  apiKey: string,
  options: QuoFetchOptions = {},
): Promise<QuoResponse<T>> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requestGapMs = options.requestGapMs ?? DEFAULT_REQUEST_GAP_MS;
  // Mirror apolloPost: accept full URLs verbatim, otherwise treat `path` as
  // relative to QUO_API_BASE and auto-prefix `/` so callers can pass either
  // `/v1/calls` or `v1/calls` without producing `api.openphone.comv1/calls`.
  const url = path.startsWith('http')
    ? path
    : `${QUO_API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: apiKey },
      });
      if (RETRY_STATUSES.has(response.status) && attempt < maxRetries) {
        // Cap both Retry-After and the exponential fallback at 30s so a
        // pathological server response (e.g. an HTTP-date far in the
        // future) can't stall a worker past its function time budget.
        const requested = parseRetryAfter(response.headers.get('retry-after'))
          ?? 2 ** attempt * 1000;
        const backoff = Math.min(30_000, requested);
        // Cancel the unread body so the underlying connection can be
        // released back to keep-alive instead of being held open by an
        // un-drained stream — matters under sustained 429s. Chain the
        // optional on `.catch` too: in Fetch impls that report
        // `response.body === null` (some Node versions), `body?.cancel()`
        // is `undefined` and `.catch` would throw without the second `?`.
        await response.body?.cancel()?.catch(() => {});
        await sleep(backoff);
        continue;
      }
      const data = await response.json().catch(() => ({})) as T & { message?: string; error?: string };
      // On non-2xx, guarantee `data.message` is set so callers can surface
      // a useful error string without inspecting `data.error` or the
      // status code. Don't overwrite a message the body already provided.
      if (!response.ok && !data.message) {
        data.message = `Quo request failed: ${response.status} ${response.statusText || ''}`.trim();
      }
      await sleep(requestGapMs);
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;
      await sleep(Math.min(30_000, 2 ** attempt * 1000));
    }
  }
  const message = (lastError as { message?: string })?.message || 'Quo request failed';
  return { ok: false, status: 0, data: { message } as T & { message?: string; error?: string } };
}

// ---------------------------------------------------------------------------
// Call-metadata normalizers
// ---------------------------------------------------------------------------

/** Call sentiment values stored on CallActivity. */
export type CallSentiment = 'positive' | 'neutral' | 'negative';

/**
 * Bucket an arbitrary Quo sentiment string into the narrow set the
 * CallActivity schema accepts. Unknown / missing values collapse to
 * `'neutral'` so we never violate the schema enum.
 *
 * Uses word-boundary matching so prefix collisions like "unhappy" don't
 * spuriously match `happy`. Quo emits single-word sentiment labels in
 * practice — phrase-form inputs like "not positive" still match the
 * keyword and aren't negation-detected; treat negation in the caller if
 * Quo's contract ever changes.
 */
export function normalizeSentiment(raw: unknown): CallSentiment {
  if (!raw) return 'neutral';
  const value = String(raw).toLowerCase();
  if (/\b(positive|happy|excited|enthusiastic|warm)\b/.test(value)) return 'positive';
  // `frustrat` is a stem (matches "frustrated", "frustrating", "frustration");
  // the leading `\b` still blocks prefix collisions, no trailing boundary.
  if (/\b(negative|angry|upset|hostile)\b|\bfrustrat/.test(value)) return 'negative';
  return 'neutral';
}

/** Call direction values stored on CallActivity. */
export type CallDirection = 'incoming' | 'outgoing' | 'unknown';

/**
 * Bucket an arbitrary Quo direction string into the CallActivity enum.
 * Apollo / Quo aren't consistent ("incoming"/"inbound", "outgoing"/"outbound")
 * — this maps both spellings.
 */
export function normalizeDirection(raw: unknown): CallDirection {
  const value = String(raw || '').toLowerCase();
  if (value === 'incoming' || value === 'inbound') return 'incoming';
  if (value === 'outgoing' || value === 'outbound') return 'outgoing';
  return 'unknown';
}

/** Call status values stored on CallActivity. */
export type CallStatus =
  | 'completed'
  | 'missed'
  | 'voicemail'
  | 'in_progress'
  | 'no_answer'
  | 'unknown';

/**
 * Bucket an arbitrary Quo status string into the CallActivity enum. Folds
 * known synonyms (`no-answer`/`unanswered` → `no_answer`, `ringing` →
 * `in_progress`) into the canonical values; unknown values collapse to
 * `'unknown'`.
 */
export function normalizeStatus(raw: unknown): CallStatus {
  const value = String(raw || '').toLowerCase();
  if (
    value === 'completed' ||
    value === 'missed' ||
    value === 'voicemail' ||
    value === 'in_progress'
  ) {
    return value;
  }
  if (value === 'no-answer' || value === 'no_answer' || value === 'unanswered') return 'no_answer';
  if (value === 'ringing' || value === 'in-progress') return 'in_progress';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Outcome + next-action enums
// ---------------------------------------------------------------------------

/**
 * AI-classified call outcomes. Drives reporting and the "what happened on
 * this call" surface. Must stay in sync with `Lead.jsonc` /
 * `CallActivity.jsonc` enum definitions — change here, change there.
 */
export const OUTCOMES = [
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

/** Union type of {@link OUTCOMES} values. */
export type Outcome = typeof OUTCOMES[number];

/**
 * Forward-looking categorical next action. Drives the call queue /
 * follow-ups view. Must stay in sync with `Lead.jsonc` /
 * `CallActivity.jsonc` enum definitions.
 */
export const NEXT_ACTION_TYPES = [
  'callback',
  'send_info',
  'book_demo',
  'nurture',
  'dnc',
  'no_action',
] as const;

/** Union type of {@link NEXT_ACTION_TYPES} values. */
export type NextActionType = typeof NEXT_ACTION_TYPES[number];

// ---------------------------------------------------------------------------
// Webhook auth
// ---------------------------------------------------------------------------

/**
 * True iff the request carries a valid `x-webhook-secret` header matching
 * the configured `QUO_WEBHOOK_SECRET` env var. Use this to gate scheduled /
 * webhook-driven invocations of Quo activity processors so a casual caller
 * can't trigger work outside the user-auth path.
 *
 * The env var is read via a runtime-agnostic shim, so this works in both
 * Deno (Base44) and Node consumers.
 */
export function isAuthorizedScheduledRun(req: Request): boolean {
  const expected = getEnv('QUO_WEBHOOK_SECRET');
  if (!expected) return false;
  const provided = req.headers.get('x-webhook-secret');
  return Boolean(provided) && provided === expected;
}
