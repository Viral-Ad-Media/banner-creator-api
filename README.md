# Banner Creator API

Authenticated TypeScript/Express API for [Banner Creator](https://github.com/Viral-Ad-Media/banner-creator). Supabase stores account data, projects, avatars, generation results, and transactional credit reservations. Gemini handles images and optional planning/video; OpenRouter supports optional planning/video.

## Setup

Use Node.js 22.12+ and npm. Clone this repository as `banner-creator-api` beside the frontend's `banner-creator` directory.

```bash
npm ci
cp .env.example .env
```

Set `GEMINI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. Keep service-role and provider keys on the server. Set `CORS_ORIGIN` to the exact frontend origin; comma-separated origins are supported. Local defaults are API `http://localhost:4000` and frontend `http://localhost:3000`.

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

### Database initialization and upgrade

**Apply the database changes before deploying this API.**

- New database: run [supabase/schema.sql](supabase/schema.sql) in the Supabase SQL editor. It includes the hardening migration.
- Existing database: back up first, then run [supabase/migrations/20261005_audit_hardening.sql](supabase/migrations/20261005_audit_hardening.sql). It is transactional and rerunnable.

Authenticated browser roles have owner-scoped read access only. Application writes and credit/quota/rate-limit RPCs require the service role. Existing write RLS policies do not grant table privileges. Server routes enforce account ownership, including video status/download and project references.

The migration reclassifies legacy pending videos previously marked successful. It retains historic usage records; review historic mock upgrades, foreign project references, and incorrectly charged video failures separately. Verify existing paid entitlements against actual payment records before enabling paid service. This migration cannot establish whether historic payments or provider jobs really completed.

```bash
npm run dev
npm run check
npm audit
npm run build
npm start
```

`check` runs type checking, regression tests, and compilation. Database tests use embedded PostgreSQL (PGlite), including migration replay, permissions, serialized concurrent reservation/quota requests, aggregation beyond 1000 rows, and rate buckets. Route tests cover ownership, billing, and validation. Run a staging smoke test against actual Supabase and provider accounts before production rollout; these tests do not make paid provider calls.

## API contract

Base path `/api`. All routes except `/health` require `Authorization: Bearer <Supabase access token>`. Bodies and responses use JSON unless downloading video.

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
Authorization: Bearer <token>
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

Run this with server credentials from a private scheduler periodically (for example, every minute):

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

Rollout order: back up/apply migration → deploy API → deploy matching frontend → configure private reconciliation scheduler. Verify health, login/profile, owned project save/load, one generation, idempotent retry, credit settlement, cross-account denial, and completed video recovery/download in staging. This repository does not deploy database migrations or schedule reconciliation automatically.

Limits are shared through PostgreSQL: 300 API requests/minute per IP, 30 auth requests/minute per IP, and 100 generation requests/minute per authenticated user. Expired buckets are pruned during requests. Limiter database failures fail closed with 503. Incorrect proxy-hop configuration can group users into one IP or trust spoofed forwarding headers.
