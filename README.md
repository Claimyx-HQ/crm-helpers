# @claimyx/crm-helpers

Shared TypeScript helpers for the Claimyx CRM. This repo holds the source code; the package itself is published to **[jsr.io/@claimyx/crm-helpers](https://jsr.io/@claimyx/crm-helpers)** and consumed by Base44 backend functions via `jsr:@claimyx/crm-helpers/...` imports.

This repo is public **on purpose**: the only way to share TypeScript modules between Base44 backend functions is to publish them somewhere Deno can fetch at deploy time, and JSR's free tier requires public packages. The helper code is utility plumbing (retry loops, normalizers, HTTP wrappers) — no secrets, no business IP. All real secrets live in Base44 environment variables and never touch this codebase.

---

## Quick reference

| Thing | Where |
|---|---|
| **Package** | https://jsr.io/@claimyx/crm-helpers |
| **Source repo** | https://github.com/Claimyx-HQ/crm-helpers (you're here) |
| **JSR scope** | `@claimyx` — owned by Ido (`ido.brosh@claimyx.com`) |
| **Consumer repo** | https://github.com/Claimyx-HQ/sales-crm — Base44 functions importing this |
| **Publish workflow** | `.github/workflows/publish.yml` — fires on every `vX.Y.Z` tag |
| **Versioning** | Single `version` field in `deno.json`; tags must match exactly |

---

## How to add a new helper

Three options, in order of preference:

### Option 1 — Add to an existing module

Best for helpers that fit the theme of an existing file. Examples:

- A new email normalizer → `src/text.ts`
- A new Apollo response normalizer → `src/apollo.ts`
- A new retry variant or Base44 SDK wrapper → `src/base44.ts`

Steps:
1. Edit the file in this repo.
2. Add a doc comment above the function (`/** ... */`) so JSR's auto-doc picks it up.
3. Export the function (must use `export` keyword).
4. Skip to the **Release a new version** section below.

### Option 2 — Create a new module file

Best for helpers in a new category that doesn't fit existing modules. Examples: `src/dates.ts`, `src/validation.ts`, `src/csv.ts`.

Steps:
1. Create `src/<name>.ts` with the new helpers.
2. Register the module in `deno.json` under `exports`:
   ```jsonc
   "exports": {
     "./apollo": "./src/apollo.ts",
     "./base44": "./src/base44.ts",
     "./text": "./src/text.ts",
     "./dates": "./src/dates.ts"   // ← new entry
   }
   ```
3. Skip to the **Release a new version** section below.

### Option 3 — Split a file that got too large

Best when one of the existing modules grows past ~500 lines and would be clearer as multiple files.

Example splitting `apollo.ts`:
```
src/apollo/
  http.ts          # apolloPost
  normalizers.ts   # normalizeAccount, normalizeContact, organizationAsAccount
  types.ts         # ApolloAccount, ApolloOrganization, etc.
  constants.ts     # APOLLO_BASE, MAX_LEADS_HARD_CAP, etc.
  index.ts         # re-exports everything so existing consumers still work
```

In `deno.json`, point `./apollo` at `./src/apollo/index.ts`. Consumers don't need to change anything.

---

## Release a new version

This is the runbook to publish a new version after editing helpers. Every step matters — JSR publishing is automated but has one gotcha (see below).

### Pre-flight

- All helper code uses `export` (private helpers don't need it).
- Every public function has a `/** doc comment */` above it.
- No `import { ... } from '../...'` references — modules only import from `./<other-module>.ts` or `npm:`/`jsr:` packages.

### Step 1 — Bump version

Edit `deno.json` and bump the `version` field. Use semver:

- **`1.0.0` → `1.0.1`** for bug fixes (no API change).
- **`1.0.0` → `1.1.0`** for new helpers or new modules (additive, no breaking changes).
- **`1.0.0` → `2.0.0`** for breaking changes (removed/renamed exports, changed signatures).

Most updates will be `1.x.y` (additive) — `2.0.0` would force every consumer to manually bump their import pin.

### Step 2 — Commit and push to `main`

Standard git workflow. The `main` branch should always contain the version that's about to be (or just was) tagged.

### Step 3 — Create a release on GitHub

This is what triggers the publish.

1. Go to https://github.com/Claimyx-HQ/crm-helpers/releases/new
2. **Choose a tag** → type the exact version with `v` prefix, e.g. `v1.0.1` → click "Create new tag: v1.0.1 on publish".
3. **Target** → `main` (should be the default).
4. **Release title** → `v1.0.1`.
5. **Description** → one or two lines on what changed. Optional but nice to have.
6. Click **Publish release**.

### Step 4 — Watch the workflow

Go to https://github.com/Claimyx-HQ/crm-helpers/actions and wait for "Publish to JSR" to complete (~30s). When it goes green, the new version is live at `https://jsr.io/@claimyx/crm-helpers@1.0.1`.

### Step 5 — Consumer side (sales-crm)

Consumers using a `^1.0.0` caret range automatically pick up `1.0.x` and `1.x.y` on next Base44 redeploy — **no PR needed**. For breaking changes (major version bump) or to pin an exact version, edit each `entry.ts` in `sales-crm/base44/functions/*/` to bump the version string in its `jsr:@claimyx/crm-helpers@^X.Y.Z/...` imports.

---

## Common gotchas

These are the things that bit us during the v1.0.0 setup. If a future session repeats one of these, this section is the FAQ.

### YAML indentation when uploading `.github/workflows/publish.yml`

If the workflow file gets pasted into the GitHub web editor from a terminal-rendered code block, every line after the first may end up with 2 spaces of leading whitespace from the terminal's visual padding. YAML parses that as the whole file being inside an invalid implicit mapping and the workflow fails with "Invalid workflow file ... line 12".

**Workaround**: copy from a file, not from terminal output. The safe one-liner on macOS is `cat .github/workflows/publish.yml | pbcopy`, then paste into the GitHub web editor.

### "Workflows" GitHub App permission

The GitHub Code app (the one Claude uses) doesn't have permission to write files under `.github/workflows/` even when it has full write access to the rest of the repo. This is a separate "workflows" scope that GitHub Apps must explicitly request.

Practical consequence: **a human has to manually edit `publish.yml` via the GitHub web UI**. The agent can read it, diagnose issues, and provide the corrected content, but can't push the file.

### Tag name must start with `v`

The workflow trigger is `tags: - 'v*'`. A tag named `1.0.0` (no `v` prefix) **does not fire the workflow**. Always create the tag as `v1.0.0`.

The workflow also asserts that the tag version (after stripping `v`) matches `deno.json`'s `version` field. Mismatch → workflow fails fast with a clear error. So if you bump `deno.json` to `1.0.1` but tag `v1.0.2`, you'll see the failure immediately.

### JSR scope owner

The `@claimyx` scope on JSR is owned by Ido. New maintainers need to be added as scope members on jsr.io. While "Restrict publishing to members" is on (the default), GitHub Actions can only publish on behalf of users that are scope members on JSR.

### GitHub repo MUST be linked to the JSR package

OIDC tokenless publishing requires the linked-repo relationship. If you ever create a new package under `@claimyx`, go to its Settings tab on JSR and link `Claimyx-HQ/crm-helpers` (or whichever GitHub repo holds its source).

---

## Modules

| Module | Import path | What's inside |
|---|---|---|
| `activity` | `jsr:@claimyx/crm-helpers/activity` | Write-source taxonomy and the `stampActivity` helper. Exports: `WRITE_SOURCES`, `WriteSource`, `isUserInitiated`, `stampActivity`. Only `source === 'user'` stamps `last_activity_at`; bulk admin and automation sources never stamp (PM decision D2, 2026-05-24). |
| `apollo` | `jsr:@claimyx/crm-helpers/apollo` | Apollo HTTP client (`apolloPost`), normalizers (`normalizeAccount`, `normalizeContact`, `organizationAsAccount`), Apollo types (`ApolloAccount`, `ApolloOrganization`, `NormalizedCompany`, `ApolloContactInput`, `NormalizedLead`), constants (`APOLLO_BASE`, `MAX_LEADS_HARD_CAP`, `DEFAULT_MAX_LEADS`, `DEFAULT_DISCOVERY_TITLES`). |
| `base44` | `jsr:@claimyx/crm-helpers/base44` | Chunked-function plumbing: `RetryState`, `DEFAULT_CHUNK_TIME_BUDGET_MS`, `makeRetryState`, `withRetry`, `isDeadlineError`. Orchestrator-auth pattern: `isAuthorizedOrchestratorCall`, `orchestratorPayload`, `chainingEnabled`. |
| `import-batch` | `jsr:@claimyx/crm-helpers/import-batch` | `appendImportBatchId(Company, companyId, batchId)` — read-merge-write helper for the `Company.import_batch_ids` array. Base44's `Entity.update` does not support `$addToSet` (only `updateMany` does), so we read the row, check membership, and write the merged array. Idempotent (re-running with the same batch id is a no-op). |
| `mutation-log` | `jsr:@claimyx/crm-helpers/mutation-log` | Logged-write helpers (`loggedUpdate`, `loggedCreate`, `loggedDelete`) that wrap Base44 entity writes and emit a `MutationLogRecord` to an injected log-entity client. Calls `stampActivity` to enforce D2 (bulk_admin doesn't stamp `last_activity_at`). Best-effort log writes (failures warn, don't throw). Foundation for the sales-crm audit log + undo. **Note:** there is no separate `silentUpdate` export — `loggedUpdate` already accepts `source` (any `WriteSource`), so `silentUpdate` is just `loggedUpdate({ source: 'cron' })` or `loggedUpdate({ source: 'llm' })`. |
| `phone` | `jsr:@claimyx/crm-helpers/phone` | Phone helpers consumed by sales-crm dedup paths. Re-exports the canonical `normalizePhone` from `./text` and adds `extractPrimaryPhone` (picks the most-trustworthy raw phone from an Apollo contact's `phone_numbers[0].raw_number → sanitized_number → sanitized_phone` chain). `PhoneSource` interface for the picker's input shape. |
| `settings` | `jsr:@claimyx/crm-helpers/settings` | `getSetting<T>(Setting, key, fallbackDefault, opts?)` — typed reader for the sales-crm Setting entity with a 60-second in-process cache, type validation against the declared `value_type`, and optional `min_value`/`max_value` range checks. Returns `fallbackDefault` for missing or invalid rows (without caching the fallback, so a fix takes effect immediately). Exports `clearSettingsCache` for tests + force-refresh call sites. |
| `task-run` | `jsr:@claimyx/crm-helpers/task-run` | `withTaskRun(TaskRun, taskType, options, fn)` — brackets an async function with a TaskRun lifecycle row (`running` → `succeeded` / `failed` / `partial`). Errors are caught and surfaced as `WithTaskRunResult.error`, never re-thrown — safe to compose inside batch loops. The post-work TaskRun.update is retried 3× with exponential backoff so transient SDK failures don't leave the row stuck in `running`. |
| `text` | `jsr:@claimyx/crm-helpers/text` | Generic utilities: `sleep`, `extractDomain`, `normalizeOrgName`, `buildLocation`, `normalizeEmailStatus`, `equalEnough`, `isUnchanged`. |
| `upsert` | `jsr:@claimyx/crm-helpers/upsert` | `upsertByKey(entity, { keys, data, merge?, immutableFields?, mergeArrays? })` — natural-key dedup primitive. Base44 has no unique-constraint primitive, so this is the canonical application-level upsert. Tries each key in priority order, updates on hit (`fill_blanks` or `overwrite`), creates on miss. Returns `{ action: 'created' \| 'updated' \| 'noop', record, matchedKey? }`. |

For exact function signatures and what each does, see the doc comments in `src/*.ts` or the auto-generated docs on JSR.

---

## Consumer usage (Base44 backend functions)

Example from `sales-crm/base44/functions/enrichCompanyFromApollo/entry.ts`:

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import {
  apolloPost,
  normalizeAccount,
  organizationAsAccount,
  type ApolloAccount,
  type NormalizedCompany,
} from 'jsr:@claimyx/crm-helpers@^1.0.0/apollo';
import {
  withRetry,
  makeRetryState,
  isAuthorizedOrchestratorCall,
  type RetryState,
} from 'jsr:@claimyx/crm-helpers@^1.0.0/base44';
import {
  extractDomain,
  isUnchanged,
} from 'jsr:@claimyx/crm-helpers@^1.0.0/text';

Deno.serve(async (req) => {
  // ... use helpers ...
});
```

Caret range (`^1.0.0`) means: any version that's `>=1.0.0` and `<2.0.0`. Minor and patch updates flow in automatically on the next Base44 redeploy. Major bumps require manually editing each consumer.

---

## Background — why JSR, not a private registry

Base44's Deno runtime only deploys files at `functions/<name>/entry.ts` (plus optional `function.jsonc`) per function. Subdirectories under `functions/` without their own `entry.ts` are silently dropped from the deploy bundle. That means:

- A `functions/shared/` directory for shared modules: **doesn't work**.
- A `base44/shared/` or `base44/lib/` directory at repo root: **doesn't work** (Base44 only knows the 5 named resource dirs: `entities/`, `functions/`, `agents/`, `connectors/`, `auth/`).
- A private npm registry (npm Pro/Teams, GitHub Packages, etc.): **doesn't work**, because Deno needs a `.npmrc` file at function runtime to authenticate, and Base44 has no way to deploy one alongside `entry.ts`.

The only way to share TS code between Base44 functions today is to publish it to a registry that doesn't need auth — JSR or public npm. JSR is the cleaner fit (Deno-native, TypeScript source published directly, no transpile step).

If Base44 ever ships first-class support for sidecar config files (`.npmrc` or equivalent), private GitHub Packages would become viable and this repo could go private.

---

## Development

```bash
deno task check         # typecheck everything
deno task test          # run all Deno test files in src/
deno task publish:dry   # validate JSR publish without actually publishing
```

Local-only — actual publishing happens via the GitHub Actions workflow when you tag a release.
