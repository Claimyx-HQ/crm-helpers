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

/** Base URL of the Quo (OpenPhone) v1 API. */
export const QUO_API_BASE = 'https://api.openphone.com';

const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_REQUEST_GAP_MS = 150;

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
  /** Max retry attempts. Defaults to 6. */
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
        const retryAfter = Number(response.headers.get('retry-after')) || 0;
        const backoff = retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 2 ** attempt * 1000);
        // Cancel the unread body so the underlying connection can be
        // released back to keep-alive instead of being held open by an
        // un-drained stream — matters under sustained 429s.
        await response.body?.cancel().catch(() => {});
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
 */
export function normalizeSentiment(raw: unknown): CallSentiment {
  if (!raw) return 'neutral';
  const value = String(raw).toLowerCase();
  if (/(positive|happy|excited|enthusiastic|warm)/.test(value)) return 'positive';
  if (/(negative|angry|frustrat|upset|hostile)/.test(value)) return 'negative';
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
