// Low-level Apollo HTTP client + shared response type. Extracted from
// `apollo.ts` so `apollo-workspace.ts` can import the HTTP primitives
// without pulling the normalizers — and `apollo.ts` can import workspace
// helpers (classifications, label / list / custom-field extractors) from
// `apollo-workspace.ts` without forming an import cycle.
//
// Both `./apollo` and `./apollo-workspace` now depend on this module; this
// module depends on nothing inside `src/` except `./text` (for `sleep`).
//
// `apollo.ts` re-exports `apolloPost`, `ApolloResponse`, and `APOLLO_BASE`
// so existing consumers (sales-crm functions, anything pinning `@claimyx/crm-helpers/apollo`)
// keep working without code changes. New consumers can also import directly
// from `@claimyx/crm-helpers/apollo-http` via the `./apollo-http` entry in
// `deno.json` exports.

import { sleep } from './text.ts';

// ---------------------------------------------------------------------------
// Apollo HTTP constants
// ---------------------------------------------------------------------------

/** Base URL for Apollo's REST API v1. */
export const APOLLO_BASE = 'https://api.apollo.io/api/v1';

// ---------------------------------------------------------------------------
// Apollo HTTP response shape
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

// ---------------------------------------------------------------------------
// Apollo HTTP client
// ---------------------------------------------------------------------------

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
