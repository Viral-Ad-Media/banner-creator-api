# Banner Creator Backend

TypeScript + Express API for the Banner Creator app. This service handles authenticated app data, Gemini/OpenRouter-powered generations, usage tracking, and mock billing flows.

## Stack

- Node.js 20+
- npm 10+
- Express 4
- TypeScript
- Supabase
- Gemini via `@google/genai`
- OpenRouter via the OpenAI-compatible chat API and async video API
- Zod

## Features

- `GET /api/health` health check
- Supabase token validation and profile bootstrap
- Project CRUD endpoints
- Banner plan, image generation, image edit, and video generation endpoints
- Monthly usage tracking by plan tier
- Mock billing summary and checkout/portal routes
- Centralized error handling and API rate limiting

## Project Layout

```text
.
├── .env.example
├── package.json
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/
│   ├── db/
│   ├── lib/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   └── types/
├── supabase/
│   └── schema.sql
└── tsconfig.json
```

## Environment

Create a local env file:

```bash
cp .env.example .env
```

Use raw values, not shell-style quoted assignments copied into the Vercel dashboard. For example, set `SUPABASE_URL` to `https://your-project-ref.supabase.co`, not `"https://your-project-ref.supabase.co"`.

Required variables and optional OpenRouter overrides:

```bash
NODE_ENV=development
PORT=4000
GEMINI_API_KEY=your-gemini-api-key
TEXT_GENERATION_PROVIDER=gemini
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_TEXT_MODEL=openai/gpt-5.2
OPENROUTER_VIDEO_MODEL_FAST=google/veo-3.1
OPENROUTER_VIDEO_MODEL_QUALITY=google/veo-3.1
OPENROUTER_APP_URL=http://localhost:3000
OPENROUTER_APP_NAME=Social Studio
CORS_ORIGIN=http://localhost:3000
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

`CORS_ORIGIN` accepts a comma-separated list, so you can allow local development and Vercel at the same time. Example: `http://localhost:3000,https://your-web.vercel.app`.

OpenRouter is optional unless you choose it in the app or set `TEXT_GENERATION_PROVIDER=openrouter`. OpenRouter API keys stay server-side; the frontend only sends provider names.

## Local Development

Install dependencies:

```bash
npm install
```

Start the API in watch mode:

```bash
npm run dev
```

Type-check the project:

```bash
npm run typecheck
```

Build and run the compiled server:

```bash
npm run build
npm run start
```

The server listens on `http://localhost:4000` by default.

## API Overview

Base path: `/api`

- `GET /health`
- `GET /auth/me`
- `PATCH /auth/me`
- `GET /projects`
- `POST /projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`
- `DELETE /projects/:projectId`
- `GET /generations`
- `POST /generations/plan`
- `POST /generations/image`
- `POST /generations/edit`
- `POST /generations/video`
- `GET /generations/video/status`
- `GET /generations/video/download`
- `GET /billing/summary`
- `POST /billing/checkout-session`
- `POST /billing/portal-session`

All routes except `/api/health` require `Authorization: Bearer <supabase-access-token>`.

## Database Setup

Run [`supabase/schema.sql`](./supabase/schema.sql) in your Supabase SQL editor before using authenticated app flows.

## Deploying to Vercel

The backend can be deployed directly to Vercel as an Express project. Vercel's current Express guide supports `src/server.ts` as a valid entrypoint and allows either a default export or an `app.listen(...)` server pattern. I also added [`vercel.json`](./vercel.json) to raise the function timeout to 60 seconds for Gemini-backed routes.

Recommended project settings:

- Root Directory: `banner-creator-backend`
- Framework Preset: `Express`
- Install Command: `npm install`
- Build Command: `npm run build`

Required Vercel environment variables:

- `NODE_ENV=production`
- `PORT=4000`
- `GEMINI_API_KEY=...`
- `TEXT_GENERATION_PROVIDER=gemini`
- `OPENROUTER_API_KEY=...` if using OpenRouter
- `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`
- `OPENROUTER_TEXT_MODEL=openai/gpt-5.2`
- `OPENROUTER_VIDEO_MODEL_FAST=google/veo-3.1`
- `OPENROUTER_VIDEO_MODEL_QUALITY=google/veo-3.1`
- `OPENROUTER_APP_URL=https://your-frontend-domain.vercel.app`
- `OPENROUTER_APP_NAME=Social Studio`
- `CORS_ORIGIN=https://your-frontend-domain.vercel.app`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`

Enter the values only. Do not include surrounding quotes in the Vercel UI.

If you want the same backend to work for local development and production, set `CORS_ORIGIN` to a comma-separated list such as `http://localhost:3000,https://your-frontend-domain.vercel.app`.

After deploy, verify:

- `GET https://<your-api-domain>/api/health`
- Authenticated `GET /api/auth/me`
- One generation request, especially `POST /api/generations/plan`

## Notes

- The Gemini API key stays server-side only.
- `CORS_ORIGIN` must match the frontend origin in local and production environments.
- Billing routes are placeholders and do not create real Stripe sessions.
