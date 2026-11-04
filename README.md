# Banner Creator API

Authenticated TypeScript/Express API using Neon and Better Auth for [Banner Creator](https://github.com/Viral-Ad-Media/banner-creator). Neon PostgreSQL stores account data, projects, avatars, generation results, and transactional credit reservations. Gemini handles images and optional planning/video; OpenRouter supports optional planning/video.

## Setup

Use Node.js 22.12+ and npm. Clone this repository as `banner-creator-api` beside the frontend's `banner-creator` directory.

```bash
npm ci
cp .env.example .env
```

Set `DATABASE_URL` to the Banner Creator Neon **pooled PostgreSQL URL** (with verified TLS), `BETTER_AUTH_SECRET` to a persistent random secret of at least 32 characters, and `BETTER_AUTH_URL` to the API's public origin (Render: `https://banner-creator-api.onrender.com`). Generate the secret once, for example with `openssl rand -hex 32`; store it in Render environment variables and keep it stable across deployments.

Set `CORS_ORIGIN` to the exact frontend origin; comma-separated origins are supported. Better Auth uses the same list as trusted origins and rejects cross-origin auth requests from other sites. Local defaults are API `http://localhost:4000` and frontend `http://localhost:3000`. Keep all database, auth and provider keys on the server. **No Supabase credentials or SDK are used by either running app.**

Gemini generation needs `GEMINI_API_KEY`; optional OpenRouter generation needs `OPENROUTER_API_KEY`. Missing provider keys do not prevent login or project operations. A generation attempted without its provider key fails and releases its credit reservation without calling a provider.

Better Auth provides email/password signup, login, database-backed HttpOnly session cookies, and sign-out. Account linking by email is disabled. Existing plans are read from server-controlled `app_users`, never signup fields or browser claims. Password recovery revokes sessions and requires `RESEND_API_KEY` plus `AUTH_EMAIL_FROM` using a verified sender. Without these, recovery returns an unavailable error; reset tokens are never logged. Email confirmation and social login are not enabled by this configuration.

Optional configuration:

| Variable                                                        | Behavior                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `TEXT_GENERATION_PROVIDER`                                      | `gemini` (default) or `openrouter`                                                              |
| `OPENROUTER_API_KEY`                                            | Required when using OpenRouter                                                                  |
| `OPENROUTER_BASE_URL`, `OPENROUTER_TEXT_MODEL`                  | Provider endpoint and planning model; defaults in `.env.example`                                |
| `OPENROUTER_VIDEO_MODEL_FAST`, `OPENROUTER_VIDEO_MODEL_QUALITY` | Video model IDs                                                                                 |
| `OPENROUTER_APP_URL`, `OPENROUTER_APP_NAME`                     | Attribution headers                                                                             |
| `PROVIDER_TIMEOUT_MS`                                           | Default 40000; allowed 1000–45000; keep below the host deadline                                 |
| `TRUST_PROXY_HOPS`                                              | Default 0; change only to the verified trusted proxy count, with no shorter route to the server |

### Database initialization

Use a dedicated Neon project. Initialize an empty database before deploying the API:

```bash
npm run db:migrate
```

This runs Better Auth's migrations for the pinned dependency version and then the rerunnable application schema in [db/schema.sql](db/schema.sql). [db/auth-schema.sql](db/auth-schema.sql) is a generated snapshot for review/manual bootstrap of an empty database; normal upgrades use `db:migrate`, not replaying that snapshot. Application queries and accounting functions run through `pg` with bound parameters. Browser clients receive no database credentials. An unprivileged database role has no access to application tables or accounting functions; the server database owner operates the private schema. API routes enforce account ownership and SQL functions serialize credit reservations, resource quotas and settlement.

### Import existing accounts and saved work

The new Neon project starts empty. **Do not open signup or cut over until deciding whether to import existing users.** Back up the old database and stop old app writes for the final import. Keep the source intact for rollback. Run the import once from a private environment with direct PostgreSQL access to both databases:

```bash
# DATABASE_URL points to the initialized, empty Neon destination.
# Set SOURCE_DATABASE_URL securely to the old database's direct PostgreSQL URL.
npm run db:import-legacy
```

The importer uses a read-only consistent source snapshot and one transaction at the destination. It refuses any nonempty destination auth table and never links accounts by email. It preserves user UUIDs, profiles, paid plans, projects, avatars, generations, usage, billing records and existing credit reservations. Bcrypt password hashes remain usable through an explicit legacy verifier; newly created/reset passwords use Better Auth's default hash. Browser sessions and OAuth provider links are not imported: users sign in again; accounts without a password use configured email recovery. Banned/deleted accounts or unsupported password hashes stop the entire import for operator review. Check imported paid entitlements against payment records before reopening paid access. Historic pending videos are reclassified for reconciliation; importing cannot recover lost provider output or prove historical charges were correct.

The `supabase/` SQL files are retained as historical source-schema references only; do not execute them on Neon. The offline importer is the sole code that reads the old `auth.users` schema. Never place `SOURCE_DATABASE_URL` in the deployed runtime.

```bash
npm run dev
npm run check
npm audit
npm run build
npm start
```

`check` runs type checking, regression tests, and compilation. Database tests use embedded PostgreSQL (PGlite), including migration replay, permissions, serialized concurrent reservation/quota requests, aggregation beyond 1000 rows, and rate buckets. Route tests cover ownership, billing, and validation. Run a staging smoke test against actual Neon and provider accounts before production rollout; these tests do not make paid provider calls.

## API contract

Base path `/api`. Application routes except `/health` require a Better Auth session cookie. Authentication endpoints live below `/api/auth/session/*` and accept unauthenticated signup/login/reset requests where appropriate. The handler mounts before JSON parsing. The matching frontend proxies `/api/*` through its own origin, so HttpOnly cookies work without third-party-cookie support. Bodies and responses use JSON unless downloading video.

| Routes                                                       | Purpose                                                |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `GET /health`                                                | Health response; also subject to shared API limiter    |
| `GET /auth/me`, `PATCH /auth/me`                             | Profile lookup; update name only                       |
| `GET /projects?offset=0`, `POST /projects`                   | List/create projects; 50 per page                      |
| `GET`, `PATCH`, `DELETE /projects/:projectId`                | Owner-scoped project operations                        |
| `GET /avatars`, `POST /avatars`, `DELETE /avatars/:avatarId` | Owner-scoped avatar library; maximum 12                |
| `GET /generations?offset=0`                                  | Activity metadata, usage and `nextOffset`; 50 per page |
| `GET /generations/:generationId`                             | Owner-scoped stored output; reconciles video state     |
| `POST /generations/plan`, `/image`, `/edit`, `/video`        | Reserve credits and dispatch generation                |
| `GET /generations/video/status?generationId=<uuid>`          | Reconcile an owned video job                           |
| `GET /generations/video/download?generationId=<uuid>`        | Download completed owned video                         |
| `GET /billing/summary`                                       | Current plan and usage                                 |
| `POST /billing/checkout-session`, `/billing/portal-session`  | Return 501; paid billing is unavailable                |

Every generation POST requires a UUID `Idempotency-Key`. Reuse the same key and same parsed payload after an interrupted request. Changing payload with the same key returns 409. A successful replay returns the stored result without buying another generation. Pending/uncertain dispatch returns 409; recorded failures return 422, allowing a new key for an intentional retry. Existing clients must switch video requests from `operationName`/`provider` to `generationId`.

Example:

```http
POST /api/generations/plan
Cookie: <HttpOnly Better Auth session cookie>
Idempotency-Key: <uuid>
Content-Type: application/json

{"userPrompt":"Summer product launch","aspectRatio":"1:1","bannerCount":3,"textProvider":"gemini"}
```

Optional `projectId` must belong to the caller. Image generation takes `prompt`, `aspectRatio`, and at most two `referenceImages`; editing takes `prompt` and `base64Image`. Images must be PNG/JPEG/WebP data URLs with at most 1,000,000 encoded characters each. The entire JSON request is limited to 4 MB. Planner output is validated before storage/return.

Video takes `prompt`, `provider` (`gemini`/`openrouter`), `aspectRatio` (`16:9`/`9:16`), `durationSeconds`, `modelPreset` (`fast`/`quality`), `includeAudio`, and optional `negativePrompt`/`sourceImageDataUrl`. Gemini accepts 4/6/8 seconds; Gemini image-to-video requires 8. Model availability remains provider-dependent. Downloads use HTTPS, bounded redirects/deadlines, and a **4,000,000-byte limit** to fit the response budget. Oversized clips return 413; larger outputs require a future object-storage/streaming delivery path. Gemini 4:5 banner requests use 3:4 backgrounds, cropped to the final 4:5 document in the frontend.

Invalid input/JSON returns 400, unauthorized requests 401, quotas 402, foreign/missing objects 404, pending/conflicting work 409, size limits 413, failed replays 422, and rate limits 429 with `Retry-After`. Internal/provider errors return generic 5xx messages and are logged server-side.

## Credits and reconciliation

| Tier       | Monthly credits | Projects |
| ---------- | --------------: | -------: |
| FREE       |             120 |        5 |
| PRO        |            3000 |      100 |
| ENTERPRISE |           50000 |     1000 |

Planning costs 3 credits; images/edits 5; video 25. SQL reservations lock the account before checking available balance. Usage is aggregated in SQL, without a Data API row cap. Months use UTC; successful settlement charges the month in which the generation was created. Pending reservations reduce available credits in that month. Confirmed failures release reservations; success settles once.

`QUEUED` means dispatch has been reserved; `RUNNING` means a known provider job is pending; `UNKNOWN` means dispatch outcome needs investigation; `SUCCESS`/`FAILED` are terminal. Provider requests have deadlines and no automatic image-generation retry. A timeout/network failure can occur after the provider accepted work, so its reservation stays held rather than authorizing duplicate paid work.

Run this with private database credentials from a private scheduler periodically (for example, every minute):

```bash
npm run reconcile
```

Known video jobs are polled and settled/released even when the browser is closed. Jobs without a stored provider operation require operator review; synchronous plan/image outcomes can also become uncertain. **Check the provider's actual outcome before resolving a reservation:**

```bash
RECONCILE_ID=<generation-uuid> RECONCILE_OUTCOME=FAILED npm run reconcile
# Use SUCCESS only after verifying the provider completed the paid work.
```

Manual reconciliation updates accounting/state; it cannot reconstruct output lost before persistence. There is no automatic expiry/refund of uncertain reservations. Watch scheduler logs and alert on old `QUEUED`/`UNKNOWN` records.

Paid checkout and portal flows are deliberately disabled. They never mutate plans or create fake sessions. PRO/ENTERPRISE are operator-controlled entitlements until verified payment integration, signed webhooks, and subscription lifecycle handling are implemented. Team-size configuration is not an implemented team feature. Keep SQL limits and `src/config/plans.ts` synchronized if changing tiers.

## Deployment

Deploy this repository independently of the frontend. Use the repository root, Node 22.12+, `npm ci`, and `npm run build`; `npm start` runs the compiled Express server. [vercel.json](vercel.json) specifies a 60-second function budget. Set production server environment values from `.env.example`, including the frontend origin. Supply raw values in dashboards without surrounding shell quotes.

Render environment: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NODE_ENV=production`, `CORS_ORIGIN`, plus provider and recovery-mail keys when using those features. Use `npm ci && npm run build` and `npm start`. The Render service must receive the new code and the frontend must deploy the matching cookie client; adding Neon variables to the old Supabase build will not fix it.

Rollout order: initialize Neon → optionally import existing accounts/data → configure API environment → deploy API → deploy matching frontend with the same-origin `/api` proxy → configure private reconciliation scheduler. Verify health, signup/login, sign-out revocation, profile, project save/load, generation/retry/credits, foreign-account denial, password recovery and video recovery/download in staging. Keep the old database intact until account/data counts and ownership match. This repository does not run migrations or schedule reconciliation automatically.

Limits are shared through PostgreSQL: 300 API requests/minute per IP, 30 auth requests/minute per IP, and 100 generation requests/minute per authenticated user. Expired buckets are pruned during requests. Limiter database failures fail closed with 503. Incorrect proxy-hop configuration can group users into one IP or trust spoofed forwarding headers.

## Follow-up review fixes (October 6, 2026)

Authentication-provider network failures, throttling, and server outages return 503 rather than invalid-token 401. Confirmed invalid credentials still return 401. Terminal video state is returned even if no provider operation was persisted; a completed video with missing output returns an explicit recovery conflict instead of an internal exception.

Video reconciliation keeps the stored operation ID when a provider poll omits it. OpenRouter job payloads are validated, unknown statuses are rejected without settling credits, and malformed provider plans/jobs return an upstream 502 rather than user-input 400. This keeps interrupted/uncertain dispatch keys and credit holds intact. Gemini video errors retain their provider HTTP status so confirmed rejections can release reservations. Image generation no longer treats a phrase in the prompt as a successful empty/bypassed generation.

Provider JSON reads are capped at 1,000,000 bytes; redirect/error response bodies are cancelled and credentials are discarded when redirects cross origins. Regression tests cover these limits, authentication outages, terminal jobs, retained operation IDs, and malformed planner output. These changes require no additional migration beyond the hardening migration above.
