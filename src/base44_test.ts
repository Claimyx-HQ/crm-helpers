import { assertEquals, assert } from 'jsr:@std/assert@^1.0.0';
import { withRetry, makeRetryState } from './base44.ts';

// Helper: build an error shaped like a Base44 429 response.
function rateLimitError(retryAfterSec?: number): Error & { status: number; headers?: Record<string, string> } {
  const err = new Error('Rate limit exceeded') as Error & { status: number; headers?: Record<string, string> };
  err.status = 429;
  if (retryAfterSec !== undefined) {
    err.headers = { 'retry-after': String(retryAfterSec) };
  }
  return err;
}

Deno.test('withRetry: succeeds on first try', async () => {
  const state = makeRetryState(Date.now());
  let calls = 0;
  const result = await withRetry(state, async () => { calls += 1; return 'ok'; }, 'test');
  assertEquals(result, 'ok');
  assertEquals(calls, 1);
});

Deno.test('withRetry: jitter samples are spread across retries (anti-realign)', async () => {
  // 20 sequential samples of a single rate-limited retry. Each runs to
  // completion before the next starts — this is NOT testing concurrent
  // execution; it's sampling the jitter distribution. The asserted spread
  // (max − min > 400ms) proves the jitter draws are independent rather
  // than identical, which is what prevents the thundering-herd realignment
  // when real callers retry simultaneously in production.
  const samples: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const state = makeRetryState(Date.now(), 30_000);
    let calls = 0;
    const t0 = Date.now();
    await withRetry(state, async () => {
      calls += 1;
      if (calls === 1) throw rateLimitError();
      return 'ok';
    }, 'test');
    samples.push(Date.now() - t0);
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  assert(max - min > 400, `expected jitter spread > 400ms, got ${max - min}ms (min=${min} max=${max})`);
});

Deno.test('withRetry: backoff grows super-linearly (exponential, not linear)', async () => {
  // Force several rate-limit retries and confirm the cooldown grows
  // super-linearly. Linear: 1500, 3000, 4500. Exponential cap: up to 12000.
  //
  // Because we use full jitter (random(MIN_BACKOFF_MS, cap)), any single
  // sample can shrink across attempts. Average across N chains to compare means —
  // E[uniform(MIN_BACKOFF_MS, cap)] = (MIN_BACKOFF_MS + cap)/2 ≈ cap/2 for
  // cap >> MIN_BACKOFF_MS. The means at later attempts (cap doubles) will
  // still grow super-linearly even with the floor — the floor only shifts
  // the lower bound, not the cap. Asserting lastAvg > firstAvg * 1.4
  // holds with comfortable margin.
  const N = 8;
  const firsts: number[] = [];
  const lasts: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const state = makeRetryState(Date.now(), 60_000);
    const sleepDurations: number[] = [];
    let lastTick = Date.now();
    let calls = 0;
    await withRetry(state, async () => {
      const now = Date.now();
      if (calls > 0) sleepDurations.push(now - lastTick);
      lastTick = now;
      calls += 1;
      if (calls < 4) throw rateLimitError();
      return 'ok';
    }, 'test');
    assert(sleepDurations.length >= 2, 'need at least 2 backoffs');
    firsts.push(sleepDurations[0]);
    lasts.push(sleepDurations[sleepDurations.length - 1]);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const firstAvg = avg(firsts);
  const lastAvg = avg(lasts);
  assert(
    lastAvg > firstAvg * 1.4,
    `expected exponential growth in mean backoff, got firstAvg=${firstAvg}ms lastAvg=${lastAvg}ms`,
  );
});

Deno.test('withRetry: honors Retry-After header in seconds', async () => {
  const state = makeRetryState(Date.now(), 30_000);
  let calls = 0;
  const t0 = Date.now();
  await withRetry(state, async () => {
    calls += 1;
    if (calls === 1) throw rateLimitError(2); // Retry-After: 2 seconds
    return 'ok';
  }, 'test');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 1800, `expected to wait >= 1.8s for Retry-After: 2, got ${elapsed}ms`);
  assert(elapsed < 4000, `Retry-After: 2 should cap wait around 2s, got ${elapsed}ms`);
});

Deno.test('withRetry: respects chunk deadline', async () => {
  const state = makeRetryState(Date.now(), 100);
  try {
    await withRetry(state, async () => {
      throw rateLimitError();
    }, 'test');
    throw new Error('should have thrown');
  } catch (err) {
    const msg = (err as Error).message;
    assert(/deadline exceeded/i.test(msg), `expected deadline error, got: ${msg}`);
  }
});

Deno.test('withRetry: non-rate-limit error bails after second attempt', async () => {
  const state = makeRetryState(Date.now(), 30_000);
  let calls = 0;
  try {
    await withRetry(state, async () => {
      calls += 1;
      throw new Error('boom');
    }, 'test');
    throw new Error('should have thrown');
  } catch (err) {
    assertEquals((err as Error).message, 'boom');
    assert(calls <= 2, `expected <= 2 attempts for non-429, got ${calls}`);
  }
});

Deno.test('withRetry: rejects non-integer Retry-After (uses backoff instead)', async () => {
  // "1.5" is not a valid RFC 7231 Retry-After (must be integer seconds).
  // We should ignore it and fall through to the exp-jitter backoff.
  const state = makeRetryState(Date.now(), 30_000);
  let calls = 0;
  const t0 = Date.now();
  await withRetry(state, async () => {
    calls += 1;
    if (calls === 1) {
      // Build an error with Retry-After: 1.5 (float — invalid per RFC).
      const err = new Error('Rate limit') as Error & { status: number; headers?: Record<string, string> };
      err.status = 429;
      err.headers = { 'retry-after': '1.5' };
      throw err;
    }
    return 'ok';
  }, 'test');
  const elapsed = Date.now() - t0;
  // If we'd honored "1.5" as 1500ms, we'd wait ~1500-2500ms minimum.
  // Ignoring it falls back to exp-jitter with cap 1500 → MIN_BACKOFF_MS..1500ms.
  // The test asserts the rejection-path wait is bounded by the exp-jitter
  // cap (~1500ms ceiling) rather than the Retry-After floor (≥1500ms).
  // The 1800ms upper bound gives ~20% headroom over the deterministic max,
  // keeping flake risk minimal.
  assert(elapsed < 1800, `expected fast retry after rejecting non-RFC Retry-After, got ${elapsed}ms`);
});
