// Base44-runtime helpers: chunked-function retry/state plumbing and the
// orchestrator-secret auth pattern used by every chunked function in the CRM.
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

/**
 * Retry a Base44 SDK call with rate-limit-aware exponential backoff.
 *
 * - Only retries on 429-class errors. Other errors bail after the second
 *   attempt so we don't burn the chunk budget on a deterministic failure.
 * - Always respects the chunk deadline — if we're past it, throws so the
 *   outer loop can return a clean `in_progress` for the next chunk to retry.
 * - Honors and updates the shared `state.rateLimitUntil` cooldown, so
 *   parallel sibling calls don't keep hammering the API while one is backing
 *   off.
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
      // Non-rate-limit errors: try once more, then bail. Saves chunk budget.
      if (!isRateLimit && attempt >= 1) break;
      const backoff = Math.min(20_000, 1500 * (attempt + 1));
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
  const expected = Deno.env.get('INTERNAL_ORCHESTRATOR_SECRET') || '';
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
  const secret = Deno.env.get('INTERNAL_ORCHESTRATOR_SECRET') || '';
  if (!secret) return {};
  return { triggered_by: 'orchestrator', _internal_secret: secret };
}

/**
 * True iff orchestrator-mode chaining is configured (i.e., the env secret is
 * set). Use this to skip downstream invokes when chaining is off, instead of
 * firing them and flipping queued rows to a state that will never be acted on.
 */
export function chainingEnabled(): boolean {
  return !!Deno.env.get('INTERNAL_ORCHESTRATOR_SECRET');
}
