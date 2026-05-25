// Base44-runtime helpers: chunked-function retry/state plumbing, the
// orchestrator-secret auth pattern, and a generic chunked-entity-scan
// driver that consolidates the cursor/page/slice/time-budget loop shared
// by every backfill in the CRM.
//
// These helpers exist because Base44 backend functions:
//   - Have a ~80s gateway timeout per invocation (we use 55s as a safety budget).
//   - Need to self-chain when work exceeds the budget (return partial progress
//     and re-invoke).
//   - Share a single Apollo API key across the workspace, so rate-limit
//     backoff has to be coordinated within one request.
//   - Need a way for one function to safely invoke another with service-role
//     access — the {@link isAuthorizedOrchestratorCall} pattern gates that.

import { sleep } from './text.ts';
import { getEnv } from './env.ts';

// ---------------------------------------------------------------------------
// Chunked-function retry
// ---------------------------------------------------------------------------

/**
 * Per-request state container for {@link withRetry}. Created once per
 * `Deno.serve` invocation so concurrent requests in the same isolate can't
 * share or overwrite each other's deadline or rate-limit window.
 *
 * Pass the SAME `RetryState` instance to every `withRetry` call inside one
 * request so the rate-limit cooldown is honored across sibling calls.
 */
export interface RetryState {
  /** Absolute time (ms since epoch) at which this chunk MUST bail out. */
  chunkDeadline: number;
  /** Earliest absolute time (ms since epoch) we may make another request to
   *  the throttled resource. Shared across sibling `withRetry` calls. */
  rateLimitUntil: number;
}

/**
 * Default per-chunk time budget: 55s gives ~25s headroom under Base44's ~80s
 * gateway timeout — enough to write partial progress and self-chain without
 * tripping the deadline mid-write.
 */
export const DEFAULT_CHUNK_TIME_BUDGET_MS = 55_000;

/**
 * Construct a fresh {@link RetryState} for one request. Pass `chunkStartedAt`
 * = `Date.now()` at the very top of `Deno.serve` so the deadline measures
 * actual work time, not queue wait.
 */
export function makeRetryState(
  chunkStartedAt: number,
  budgetMs = DEFAULT_CHUNK_TIME_BUDGET_MS,
): RetryState {
  return { chunkDeadline: chunkStartedAt + budgetMs, rateLimitUntil: 0 };
}

/**
 * True iff `err` is the deadline-exceeded error thrown by {@link withRetry}.
 * Use this in your outer catch to distinguish "chunk ran out of time, please
 * call me back" (in_progress) from a real failure.
 */
export function isDeadlineError(err: unknown): boolean {
  return /chunk deadline exceeded/i.test(
    (err as { message?: string })?.message || '',
  );
}

// Upper bound on per-attempt exponential-jitter wait. The exponential
// growth (1500 * 2^attempt) is capped here so a stuck cooldown can't
// eat the whole chunk budget.
const EXP_BACKOFF_CAP_MS = 20_000;

// Upper bound on the Retry-After floor (server hint). Capped slightly
// higher than EXP_BACKOFF_CAP_MS because a server explicitly telling us
// to wait longer is more trustworthy than our local exponential schedule,
// but still bounded so a hostile/buggy server header can't park us
// indefinitely.
const RETRY_AFTER_CAP_MS = 30_000;

// Lower bound on per-attempt jitter so `Math.random()` near 0 doesn't
// produce a 0ms wait. A 0ms backoff would defeat the shared
// `state.rateLimitUntil` cooldown — sibling calls inside the same request
// would keep hammering the API even when one just hit a 429. 50ms is short
// enough to feel snappy on the rare case where retries succeed quickly,
// long enough to give the throttler a tick to settle between callers.
const MIN_BACKOFF_MS = 50;

/**
 * Retry a Base44 SDK call with rate-limit-aware exponential backoff.
 *
 * Uses **full jitter** so parallel callers don't realign on retry: each sleep
 * is `random(0, min(20s, 1500 * 2^attempt))`. When the server sends a
 * `Retry-After` header (seconds form), the wait is at least that value plus a
 * small randomized spread (≤1s) so parallel callers receiving the same
 * `Retry-After` still de-correlate — capped at 30s. So the EFFECTIVE max wait
 * per attempt is `max(20s exp-jitter cap, 30s Retry-After cap)` = 30s.
 *
 * - Only retries on 429-class errors. Other errors bail after the second
 *   attempt so we don't burn the chunk budget on a deterministic failure.
 * - Always respects the chunk deadline — if we're past it, throws so the
 *   outer loop can return a clean `in_progress` for the next chunk to retry.
 * - Honors and updates the shared `state.rateLimitUntil` cooldown, so
 *   parallel sibling calls inside the same request don't keep hammering the
 *   API while one is backing off.
 *
 * The `label` is included in the deadline-exceeded error message — pass
 * something descriptive ("Lead.filter(email)", "Apollo /accounts/search")
 * so deadline failures are debuggable.
 */
export async function withRetry<T>(
  state: RetryState,
  fn: () => Promise<T>,
  label = 'sdk',
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (Date.now() > state.chunkDeadline) {
      throw new Error(`${label} aborted: chunk deadline exceeded`);
    }
    const wait = state.rateLimitUntil - Date.now();
    if (wait > 0) {
      await sleep(Math.min(wait, Math.max(0, state.chunkDeadline - Date.now())));
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status =
        (error as { response?: { status?: number }; status?: number })?.response
          ?.status || (error as { status?: number })?.status;
      const isRateLimit =
        status === 429 ||
        /rate.?limit|429/i.test((error as { message?: string })?.message || '');
      if (!isRateLimit && attempt >= 1) break;

      // Full jitter exponential backoff: random(MIN_BACKOFF_MS, min(EXP_BACKOFF_CAP_MS,
      // 1500 * 2^attempt)). Capped at EXP_BACKOFF_CAP_MS so a stuck cooldown can't
      // eat the whole chunk budget. Floored at MIN_BACKOFF_MS so a `Math.random()`
      // result near 0 doesn't produce a 0ms wait that defeats the shared
      // `state.rateLimitUntil` cooldown (a 0ms entry means sibling calls inside
      // the same request would still hammer the API even when one just hit a 429).
      const exp = Math.min(EXP_BACKOFF_CAP_MS, 1500 * Math.pow(2, attempt));
      const jittered = MIN_BACKOFF_MS + Math.floor(Math.random() * Math.max(0, exp - MIN_BACKOFF_MS));

      // If the response carried a Retry-After header (seconds), use it as a
      // floor on the wait — server is telling us when the next call may
      // succeed. We add a small extra jitter window on top so parallel
      // callers receiving the same Retry-After value still de-correlate
      // instead of realigning at the floor. The added jitter spread is up
      // to 1s — bounded because Retry-After values are typically small
      // (server hinting at when to retry) and we don't want to inflate a 30s
      // hint into a 60s wait.
      const retryAfterMs = parseRetryAfterMs(error);
      // Add a small jitter spread (up to 1s) so parallel callers receiving
      // the same Retry-After value don't realign at the floor. Then re-cap to
      // RETRY_AFTER_CAP_MS so the final wait still respects the documented
      // upper bound (otherwise a 30s Retry-After could become 31s after jitter).
      const retryAfterJitter = retryAfterMs > 0
        ? Math.min(RETRY_AFTER_CAP_MS, retryAfterMs + Math.floor(Math.random() * Math.min(retryAfterMs, 1000)))
        : 0;
      const backoff = Math.max(jittered, retryAfterJitter);

      if (isRateLimit) {
        state.rateLimitUntil = Math.max(
          state.rateLimitUntil,
          Date.now() + backoff,
        );
      }
      const remaining = state.chunkDeadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`${label} aborted: chunk deadline exceeded`);
      }
      await sleep(Math.min(backoff, Math.max(0, remaining)));
    }
  }
  throw (lastError as Error) || new Error(`${label} failed`);
}

/**
 * Parse a `Retry-After` header (seconds form only) from a thrown error.
 * Returns 0 if absent or unparseable. HTTP-date form is intentionally
 * unsupported — it's rare for 429 responses and adds complexity for
 * marginal gain.
 *
 * Looks in two shapes: `error.headers` (plain object) and
 * `error.response.headers` (fetch Response.headers, with a `.get()` method).
 */
function parseRetryAfterMs(error: unknown): number {
  const e = error as {
    headers?: Record<string, string>;
    response?: { headers?: { get?: (k: string) => string | null } };
  };
  let raw: string | null | undefined;
  if (e?.headers && typeof e.headers === 'object') {
    raw = e.headers['retry-after'] ?? e.headers['Retry-After'];
  }
  if (!raw && e?.response?.headers && typeof e.response.headers.get === 'function') {
    raw = e.response.headers.get('retry-after');
  }
  if (typeof raw !== 'string') return 0;
  // RFC 7231: Retry-After is either a non-negative integer (seconds) or
  // an HTTP-date. We only support the integer form — HTTP-date is rare
  // for 429 responses and adds complexity for marginal gain. Reject forms
  // like "1e3", "0.5", "+5" by requiring strict integer digits. Surrounding
  // whitespace is trimmed (HTTP headers commonly carry it) before validation;
  // the digits-only check still applies after trimming.
  if (!/^\d+$/.test(raw.trim())) return 0;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(RETRY_AFTER_CAP_MS, seconds * 1000);
}

// ---------------------------------------------------------------------------
// Orchestrator auth — function-to-function invocation pattern
// ---------------------------------------------------------------------------

/**
 * Decide whether the caller is allowed to act as the orchestrator (service
 * role, no user auth).
 *
 * Trusting `triggered_by: 'orchestrator'` alone is unsafe — any caller could
 * set it. We additionally require a matching secret from a header
 * (`x-internal-secret`) or the payload (`_internal_secret`). If the env
 * secret (`INTERNAL_ORCHESTRATOR_SECRET`) is unset, orchestrator mode is
 * disabled entirely and the function falls back to authenticated-user mode.
 *
 * Pair with {@link orchestratorPayload} on the calling side.
 */
export function isAuthorizedOrchestratorCall(
  req: Request,
  payload: Record<string, unknown>,
): boolean {
  if (payload?.triggered_by !== 'orchestrator') return false;
  const expected = getEnv('INTERNAL_ORCHESTRATOR_SECRET');
  if (!expected) return false;
  const provided =
    req.headers.get('x-internal-secret') ||
    (typeof payload?._internal_secret === 'string'
      ? payload._internal_secret
      : '');
  return provided === expected;
}

/**
 * Build the payload extras needed for a self-chain or orchestrator invoke.
 * Returns an empty object if the secret is unset so callers can spread
 * unconditionally; gate the actual invoke on {@link chainingEnabled} to
 * avoid the empty no-op call.
 */
export function orchestratorPayload(): Record<string, string> {
  const secret = getEnv('INTERNAL_ORCHESTRATOR_SECRET');
  if (!secret) return {};
  return { triggered_by: 'orchestrator', _internal_secret: secret };
}

/**
 * True iff orchestrator-mode chaining is configured (i.e., the env secret is
 * set). Use this to skip downstream invokes when chaining is off, instead of
 * firing them and flipping queued rows to a state that will never be acted on.
 */
export function chainingEnabled(): boolean {
  return !!getEnv('INTERNAL_ORCHESTRATOR_SECRET');
}

// ---------------------------------------------------------------------------
// Chunked entity scan
// ---------------------------------------------------------------------------

/**
 * Row shape accepted by {@link chunkedEntityScan}. Both fields are required:
 * `id` is the row identifier; `created_date` is the immutable cursor used
 * to advance pagination across chunks. The type signature enforces this so
 * callers can't accidentally pass an entity without `created_date` and end
 * up stalling the cursor (which would re-scan the same page indefinitely).
 */
export interface ScannableEntity {
  id: string;
  created_date: string;
}

/** Sort order used for the cursor-paginated scan. Hard-coded because the
 *  cursor logic (`{ created_date: { $gt: cursor } }` + ascending order) only
 *  works correctly with `created_date` ASC; exposing a `sortBy` option would
 *  invite a footgun. */
const SCAN_SORT_BY = 'created_date';

/** Inputs for {@link chunkedEntityScan}. */
export interface ChunkedEntityScanOptions<T extends ScannableEntity> {
  /** Service-role entity client — e.g. `base44.asServiceRole.entities.Lead`.
   *  Must expose `list(sort, limit)` and `filter(where, sort, limit)`. */
  entity: {
    list: (sort: string, limit: number) => Promise<T[]>;
    filter: (
      where: Record<string, unknown>,
      sort: string,
      limit: number,
    ) => Promise<T[]>;
  };
  /** Cursor from the previous invocation — a `created_date` value. Empty
   *  string means start at the beginning. */
  cursor: string;
  /** Shared retry/cooldown state — from {@link makeRetryState}. */
  state: RetryState;
  /**
   * Per-item work. Return `processed=true` to count it toward the
   * "processed" tally and advance the cursor, `processed=false` to record
   * it as skipped (cursor still advances; we never want to re-scan a row
   * that's been intentionally skipped). Throw to record a failure (cursor
   * still advances so a poisoned row doesn't deadlock the backfill).
   */
  processItem: (item: T) => Promise<{ processed: boolean }>;
  /** Max items processed inside one chunk. Defaults to 200. */
  chunkSize?: number;
  /** Max rows fetched per Base44 page. Defaults to 500. */
  pageSize?: number;
  /** Label for {@link withRetry}'s deadline error message. */
  label?: string;
}

/** Result of one {@link chunkedEntityScan} invocation. */
export interface ChunkedEntityScanResult {
  /** `completed` only when the slice was exhausted, no more rows remain in
   *  the page, AND the page was shorter than `pageSize` (i.e., no more pages
   *  exist after it). */
  status: 'completed' | 'in_progress';
  /** Number of rows {@link processItem} ran against (regardless of skipped
   *  vs. processed). */
  processed: number;
  /** Rows still left in the current page after the slice cut. */
  remaining_in_page: number;
  /** True whenever there's more work to do — either rows remain unscanned
   *  in this page (chunkSize cap or time-budget bail-out), or the fetch
   *  came back full so another page certainly exists. False only when the
   *  scan is genuinely caught up at the cursor's tail. */
  more_pages_likely: boolean;
  /** Cursor for the next invocation. */
  next_cursor: string;
  /** Per-status counts: how many calls to processItem succeeded, were marked
   *  unprocessed, and how many threw. */
  counts: { processed: number; skipped: number; failures: number };
}

/**
 * Drive one chunk of a cursor-paginated backfill scan. The caller picks a
 * Base44 entity client and a `processItem` callback; this function handles
 * pagination, the time-budget bail-out, the cursor-advancement edge cases
 * (slice exhausted vs. mid-slice deadline-hit), and the status determination.
 *
 * Sort order is always `created_date` ascending — see {@link SCAN_SORT_BY}.
 * The cursor filter (`{ created_date: { $gt: cursor } }`) only works with
 * this order, so the sort key is not configurable.
 *
 * Typical usage:
 *
 * ```ts
 * const chunkStartedAt = Date.now();
 * const state = makeRetryState(chunkStartedAt);
 * const result = await chunkedEntityScan({
 *   entity: base44.asServiceRole.entities.Company,
 *   cursor: payload.cursor || '',
 *   state,
 *   processItem: async (company) => {
 *     // ... do the work ...
 *     return { processed: true };
 *   },
 *   label: 'backfillApolloCompanyFields',
 * });
 * return Response.json(result);
 * ```
 *
 * The cursor advancement is the load-bearing detail and matches the pattern
 * shipped in the original `backfillLeadCompanyLinks`:
 *
 * - If the slice fully covers the page AND the page covered all unprocessed
 *   rows, the cursor jumps to the last row of the page so the next call's
 *   filter strictly advances past it.
 * - Otherwise (mid-slice deadline, or more rows remain in this page than the
 *   chunk size allows), the cursor stays at the last successfully processed
 *   row so the next call re-fetches the same window and picks up the
 *   remainder.
 */
export async function chunkedEntityScan<T extends ScannableEntity>(
  options: ChunkedEntityScanOptions<T>,
): Promise<ChunkedEntityScanResult> {
  const {
    entity,
    cursor,
    state,
    processItem,
    chunkSize = 200,
    pageSize = 500,
    label = 'chunkedEntityScan',
  } = options;

  const page: T[] = cursor
    ? await withRetry(
        state,
        () => entity.filter({ created_date: { $gt: cursor } }, SCAN_SORT_BY, pageSize),
        `${label} entity.filter`,
      )
    : await withRetry(
        state,
        () => entity.list(SCAN_SORT_BY, pageSize),
        `${label} entity.list`,
      );

  if (page.length === 0) {
    return {
      status: 'completed',
      processed: 0,
      remaining_in_page: 0,
      more_pages_likely: false,
      next_cursor: cursor,
      counts: { processed: 0, skipped: 0, failures: 0 },
    };
  }

  const slice = page.slice(0, chunkSize);
  let processedCount = 0;
  let timeBudgetHit = false;
  let lastProcessedCreatedDate = cursor;
  const counts = { processed: 0, skipped: 0, failures: 0 };

  for (const item of slice) {
    // Simple absolute-time deadline check — reuses the same `chunkDeadline`
    // value `withRetry` consults, so this loop's bail-out aligns with the
    // retry helper's deadline error.
    if (Date.now() > state.chunkDeadline) {
      timeBudgetHit = true;
      break;
    }
    try {
      const { processed } = await processItem(item);
      if (processed) counts.processed += 1;
      else counts.skipped += 1;
      processedCount += 1;
      lastProcessedCreatedDate = item.created_date || lastProcessedCreatedDate;
    } catch (err) {
      counts.failures += 1;
      processedCount += 1;
      lastProcessedCreatedDate = item.created_date || lastProcessedCreatedDate;
      // Log the full error object as a second arg so the runtime keeps
      // the stack and any non-Error throw payload (e.g. plain strings)
      // — critical for diagnosing production backfill failures where
      // the only signal is this log line.
      console.error(`[${label}] row ${item.id} failed`, err);
    }
  }

  const sliceExhausted = !timeBudgetHit && processedCount >= slice.length;
  const sliceCoveredPage = slice.length >= page.length;
  if (sliceExhausted && sliceCoveredPage && page.length > 0) {
    const last = page[page.length - 1];
    if (last && last.created_date) lastProcessedCreatedDate = last.created_date;
  }

  // Compute remaining first so `morePagesLikely` can use it. The previous
  // formula (`page.length >= pageSize || page.length > slice.length`)
  // missed the time-budget mid-slice case: when the loop bails early
  // inside the slice, the page was a partial fetch (page.length < pageSize)
  // AND the chunkSize cap didn't apply (page.length === slice.length),
  // so both legs were false even though work remained.
  const remainingInPage = Math.max(0, page.length - processedCount);
  const morePagesLikely = remainingInPage > 0 || page.length >= pageSize;
  const completed = sliceExhausted && !morePagesLikely;

  return {
    status: completed ? 'completed' : 'in_progress',
    processed: processedCount,
    remaining_in_page: remainingInPage,
    more_pages_likely: morePagesLikely,
    next_cursor: lastProcessedCreatedDate,
    counts,
  };
}
