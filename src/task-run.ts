// crm-helpers/src/task-run.ts
// `withTaskRun` — wraps an async function so the work is bracketed by a
// TaskRun row that tracks lifecycle (running → succeeded/failed/partial),
// timing, attempt count, and error metadata. The TaskRun row itself is
// stored in a sales-crm-side entity (`TaskRun.jsonc`); this helper just
// owns the create-then-update protocol around the wrapped work.
//
// Intended call pattern in consumers (cron jobs, background syncs):
//
//   const result = await withTaskRun(
//     TaskRun,
//     'apollo_company_enrich',
//     { targetEntityType: 'Company', targetEntityId: companyId },
//     async (run) => {
//       const enriched = await fetchAndApply(companyId);
//       return { result: enriched, stats: { fields_updated: 5 } };
//     },
//   );
//   if (result.status === 'failed') console.error(result.error);
//
// Failure path: errors do NOT throw out of withTaskRun — they're attached
// to the returned `WithTaskRunResult.error` so the caller can choose
// whether to re-throw, retry, or just move on. This makes withTaskRun
// safe to compose inside batch loops without short-circuiting siblings.

/**
 * Canonical TaskRun status lifecycle. Order is part of the contract — any
 * downstream UI that filters by status uses these literals.
 *
 *   - `queued`: row exists but the work has not started yet (caller-owned;
 *     withTaskRun starts at 'running' and never writes 'queued').
 *   - `running`: work is in flight. Set by withTaskRun on entry.
 *   - `succeeded`: work completed cleanly.
 *   - `failed`: work threw an error. `last_error` + `last_error_at` set.
 *   - `partial`: work completed but explicitly reported partial success
 *     (e.g. enriched 8/10 companies). The wrapped fn must return
 *     `{ status: 'partial', ...stats }` to opt in.
 */
export type TaskRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'partial';

/**
 * The minimum shape of a TaskRun row written to the sales-crm TaskRun entity.
 * sales-crm's `TaskRun.jsonc` MUST mirror these field names — every name here
 * is part of the cross-repo contract.
 *
 * `id` is filled in by `Entity.create`; all other fields are written by
 * `withTaskRun` either on entry or on completion.
 */
export interface TaskRunRecord {
  id: string;
  task_type: string;
  status: TaskRunStatus;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  attempt_count: number;
  last_error?: string | null;
  last_error_at?: string | null;
  stats?: Record<string, unknown>;
  target_entity_type?: string | null;
  target_entity_id?: string | null;
  parent_task_id?: string | null;
  session_id?: string | null;
  triggered_by_user_id?: string | null;
  [key: string]: unknown;
}

/**
 * Optional context written into the TaskRun row at create-time. All fields
 * are nullable — leave any undefined ones out and they will be omitted from
 * the create payload (rather than written as null).
 *
 * - `targetEntityType` / `targetEntityId`: the entity this task is operating
 *   on (e.g. Company, Lead). Useful for "show me all task runs for this
 *   company" filters.
 * - `parentTaskId`: chains a child task back to a parent for fan-out/fan-in
 *   patterns (e.g. a bulk re-enrich kicks off N per-company tasks).
 * - `sessionId`: links the task to a higher-level sync session row (e.g. a
 *   nightly Apollo sync produces one SyncSession + many child TaskRuns).
 * - `triggeredByUserId`: who initiated the task (relevant for user-triggered
 *   bulk actions; cron-triggered tasks leave this undefined).
 */
export interface WithTaskRunOptions {
  targetEntityType?: 'Lead' | 'Company' | 'CallActivity' | 'SyncSession' | 'ImportBatch';
  targetEntityId?: string;
  parentTaskId?: string;
  sessionId?: string;
  triggeredByUserId?: string;
}

/**
 * Result of a `withTaskRun` invocation. Mirrors the resolved TaskRun status
 * (succeeded / failed / partial — 'running' and 'queued' are never returned).
 *
 * - `result`: the wrapped fn's return value (if it returned one). On a
 *   failed task this is undefined.
 * - `error`: the thrown error, attached non-thrown so callers can branch
 *   without try/catch. On succeeded/partial this is undefined.
 * - `taskRunId`: the id of the TaskRun row written to Base44. `null` when
 *   the initial `TaskRun.create` itself failed (no audit row exists). A
 *   non-null id means either the work, the wrapped fn, or the post-work
 *   update is what failed — there IS a row to inspect.
 */
export interface WithTaskRunResult<T> {
  status: 'succeeded' | 'failed' | 'partial';
  taskRunId: string | null;
  result?: T;
  error?: Error;
}

/**
 * Shape the wrapped fn can return. Three forms accepted:
 *
 *   1. Plain value `T` → treated as `{ result: T }`, status becomes 'succeeded'.
 *   2. `{ result?, stats? }` → 'succeeded', stats propagate to the TaskRun row.
 *   3. `{ status: 'partial', result?, stats? }` → 'partial' is honored.
 *
 * Returning `{ status: 'succeeded' }` explicitly is equivalent to omitting
 * status; returning `{ status: 'failed' }` is NOT honored — to fail, throw.
 */
export type TaskRunFnReturn<T> =
  | T
  | {
    status?: 'succeeded' | 'partial';
    result?: T;
    stats?: Record<string, unknown>;
  };

/**
 * Minimal entity-client surface required by `withTaskRun`. Matches the
 * Base44 SDK shape: `create` returns the row with an `id`, `update` patches
 * the row by id.
 */
export interface TaskRunEntity {
  create(data: Record<string, unknown>): Promise<TaskRunRecord>;
  update(id: string, data: Record<string, unknown>): Promise<TaskRunRecord>;
}

// Retry config for the post-work TaskRun.update call. Plan 15 explicitly
// calls this out: if the post-success update fails, the task is stuck
// in 'running' forever. Three attempts with exponential backoff is a
// pragmatic floor that doesn't pile on top of an already-flaky SDK.
const UPDATE_RETRY_ATTEMPTS = 3;
const UPDATE_RETRY_BASE_MS = 100;

/**
 * Retry an update operation with exponential backoff. Intermediate failures
 * are silently swallowed (the typical transient SDK error recovers on retry
 * and per-attempt noise would clutter cron logs); only the final failure is
 * re-thrown. The single caller (`withTaskRun`) wraps this in a try/catch and
 * emits one structured `console.warn` if all `UPDATE_RETRY_ATTEMPTS` attempts
 * are exhausted — see the catch blocks in `withTaskRun` below.
 */
async function updateWithRetry(
  entity: TaskRunEntity,
  id: string,
  data: Record<string, unknown>,
): Promise<TaskRunRecord> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < UPDATE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await entity.update(id, data);
    } catch (err) {
      lastErr = err;
      if (attempt < UPDATE_RETRY_ATTEMPTS - 1) {
        const backoff = UPDATE_RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  // Normalize to Error before re-throwing so the outer catch in withTaskRun
  // always sees an `Error` instance with a stack — mirrors the convention in
  // `withRetry` in src/base44.ts.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Wrap an async function with a TaskRun lifecycle row. On entry, a TaskRun
 * row is created with `status: 'running'`, `started_at: now`, and
 * `attempt_count: 1`. On exit, the row is updated with the final status
 * ('succeeded', 'failed', or 'partial'), `completed_at`, `duration_ms`, and
 * either `stats` (on success/partial) or `last_error` + `last_error_at`
 * (on failure).
 *
 * The wrapped `fn` may return one of:
 *
 *   - a plain value `T` — treated as success, T propagates to
 *     `WithTaskRunResult.result`.
 *   - `{ result, stats }` — success with stats merged onto the TaskRun row.
 *   - `{ status: 'partial', result, stats }` — explicit partial-success.
 *
 * Errors do NOT throw out of `withTaskRun` — at any phase. They are
 * attached to the returned `WithTaskRunResult.error` so caller code can
 * choose whether to re-throw or move on. This makes `withTaskRun` safe to
 * compose inside batch loops without short-circuiting siblings. Three
 * failure phases are possible:
 *
 *   1. `TaskRun.create` itself fails (transient SDK / schema / auth).
 *      Returns `{ status: 'failed', taskRunId: null, error }` — no audit
 *      row exists in Base44.
 *   2. The wrapped `fn` throws. Returns `{ status: 'failed', taskRunId,
 *      error }` and the existing TaskRun row is patched to status
 *      `'failed'` with `last_error` + `last_error_at`.
 *   3. The wrapped `fn` succeeds but the post-work `TaskRun.update` fails
 *      (e.g. cron lost network mid-write). Retried 3x with exponential
 *      backoff per plan 15 — if the retry exhausts, a console.warn is
 *      emitted but the success result is still returned (the work itself
 *      completed; only the audit row is stale).
 */
export async function withTaskRun<T>(
  taskRunEntity: TaskRunEntity,
  taskType: string,
  options: WithTaskRunOptions,
  fn: (run: TaskRunRecord) => Promise<TaskRunFnReturn<T>>,
): Promise<WithTaskRunResult<T>> {
  const startedAt = new Date();
  const createPayload: Record<string, unknown> = {
    task_type: taskType,
    status: 'running' as TaskRunStatus,
    started_at: startedAt.toISOString(),
    attempt_count: 1,
  };
  if (options.targetEntityType !== undefined) {
    createPayload.target_entity_type = options.targetEntityType;
  }
  if (options.targetEntityId !== undefined) {
    createPayload.target_entity_id = options.targetEntityId;
  }
  if (options.parentTaskId !== undefined) {
    createPayload.parent_task_id = options.parentTaskId;
  }
  if (options.sessionId !== undefined) {
    createPayload.session_id = options.sessionId;
  }
  if (options.triggeredByUserId !== undefined) {
    createPayload.triggered_by_user_id = options.triggeredByUserId;
  }

  // Phase 1: create the TaskRun audit row. If this fails, we can't write
  // a row at all — return a failed result with taskRunId: null so the
  // caller can branch on it without try/catch (preserves the
  // "never throws" contract documented above).
  let run: TaskRunRecord;
  try {
    run = await taskRunEntity.create(createPayload);
  } catch (createErr) {
    const error = createErr instanceof Error
      ? createErr
      : new Error(String(createErr));
    return { status: 'failed', taskRunId: null, error };
  }
  const taskRunId = run.id;

  try {
    const ret = await fn(run);
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    // Distinguish three possible return shapes:
    //   1. plain T (non-object or object without status/result/stats keys)
    //   2. { result, stats }
    //   3. { status: 'partial', result, stats }
    // We treat a return as the structured form only if it is a plain object
    // that has at least one of the recognized keys. This is a small heuristic
    // — callers returning a plain object that happens to have a `status` key
    // should wrap it via `{ result: theObject }`.
    let status: 'succeeded' | 'partial' = 'succeeded';
    let result: T | undefined;
    let stats: Record<string, unknown> | undefined;

    if (
      ret !== null &&
      typeof ret === 'object' &&
      !Array.isArray(ret) &&
      ('result' in ret || 'stats' in ret || 'status' in ret)
    ) {
      const structured = ret as {
        status?: 'succeeded' | 'partial';
        result?: T;
        stats?: Record<string, unknown>;
      };
      if (structured.status === 'partial') status = 'partial';
      result = structured.result;
      stats = structured.stats;
    } else {
      result = ret as T;
    }

    const updatePayload: Record<string, unknown> = {
      status,
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
    };
    if (stats !== undefined) updatePayload.stats = stats;

    try {
      await updateWithRetry(taskRunEntity, taskRunId, updatePayload);
    } catch (updateErr) {
      // The work itself succeeded — log loudly so the stuck-looking row is
      // discoverable, but do NOT mask the success.
      console.warn(
        `[task-run] failed to update TaskRun ${taskRunId} to '${status}' after ${UPDATE_RETRY_ATTEMPTS} attempts:`,
        updateErr,
      );
    }

    return { status, taskRunId, result };
  } catch (err) {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const error = err instanceof Error ? err : new Error(String(err));

    const updatePayload: Record<string, unknown> = {
      status: 'failed' as TaskRunStatus,
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      last_error: error.message,
      last_error_at: completedAt.toISOString(),
    };

    try {
      await updateWithRetry(taskRunEntity, taskRunId, updatePayload);
    } catch (updateErr) {
      console.warn(
        `[task-run] failed to update TaskRun ${taskRunId} to 'failed' after ${UPDATE_RETRY_ATTEMPTS} attempts:`,
        updateErr,
      );
    }

    return { status: 'failed', taskRunId, error };
  }
}
