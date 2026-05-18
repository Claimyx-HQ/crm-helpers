# @claimyx/crm-helpers

This repo is public because it can only work with Base44 this way. The code here is generic helper functions for the codebase of our main project, so it doesn't end up cluttered with duplicated code.

Used primarily by Base44 backend functions (Deno runtime), but written to work in any Deno or Node.js environment.

Published to JSR: <https://jsr.io/@claimyx/crm-helpers>

## Install

```ts
// Deno (Base44, scripts, etc.)
import { apolloPost } from 'jsr:@claimyx/crm-helpers/apollo';
import { withRetry } from 'jsr:@claimyx/crm-helpers/base44';
import { extractDomain } from 'jsr:@claimyx/crm-helpers/text';
```

```ts
// Node.js (if/when we add a frontend or non-Base44 consumer)
// npx jsr add @claimyx/crm-helpers
import { extractDomain } from '@claimyx/crm-helpers/text';
```

## Modules

| Module | What's inside |
|---|---|
| `apollo` | Apollo HTTP client (`apolloPost`), normalizers (`normalizeAccount`, `normalizeContact`), Apollo types, constants (`MAX_LEADS_HARD_CAP`, `DEFAULT_DISCOVERY_TITLES`). |
| `base44` | Chunked-function plumbing: `RetryState`, `withRetry`, `makeRetryState`, orchestrator auth (`isAuthorizedOrchestratorCall`, `chainingEnabled`). |
| `text` | Generic utilities: `extractDomain`, `normalizeOrgName`, `buildLocation`, `isUnchanged`, `equalEnough`, `sleep`. |

## Adding new helpers

Three options, in order of preference:

1. **Add to an existing module** if it fits the theme (e.g., a new email
   normalizer goes in `text.ts`).
2. **Create a new module file** (`src/dates.ts`, `src/validation.ts`) and
   register it in `deno.json` under `exports`.
3. **Carve a sub-module out of an existing file** if it's getting too large
   (split `apollo.ts` into `apollo/http.ts`, `apollo/normalizers.ts`, etc.).

Whichever you pick, write a doc comment above the function so JSR's auto-doc
picks it up.

## Releasing a new version

1. Bump `version` in `deno.json`.
2. Commit and push to `main`.
3. Tag the commit: `git tag v1.0.1 && git push --tags`.
4. GitHub Actions auto-publishes to JSR.

Consumers (Base44 functions) need to bump their import pin to pick up the new
version:
```ts
import { ... } from 'jsr:@claimyx/crm-helpers@^1.0.1/apollo';
```

Use `^1.0.0` for non-breaking updates, exact `1.0.0` if you want to pin.

## Development

```bash
deno task check         # typecheck everything
deno task publish:dry   # validate JSR publish without actually publishing
```
