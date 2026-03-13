# Banner Creator Backend

TypeScript + Express API for the Banner Creator app. This service handles authenticated app data, Gemini-powered generations, usage tracking, and mock billing flows.

## Stack

- Node.js 20+
- npm 10+
- Express 4
- TypeScript
- Supabase
- Gemini via `@google/genai`
- Zod

## Features

- `GET /api/health` health check
- Supabase token validation and profile bootstrap
- Project CRUD endpoints
- Banner plan, image generation, and image edit endpoints
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

Required variables:

```bash
NODE_ENV=development
PORT=4000
GEMINI_API_KEY=your-gemini-api-key
CORS_ORIGIN=http://localhost:3000
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

`CORS_ORIGIN` accepts a comma-separated list, so you can allow local development and Vercel at the same time. Example: `http://localhost:3000,https://your-web.vercel.app`.

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
- `CORS_ORIGIN=https://your-frontend-domain.vercel.app`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`

If you want the same backend to work for local development and production, set `CORS_ORIGIN` to a comma-separated list such as `http://localhost:3000,https://your-frontend-domain.vercel.app`.

After deploy, verify:

- `GET https://<your-api-domain>/api/health`
- Authenticated `GET /api/auth/me`
- One generation request, especially `POST /api/generations/plan`

## Notes

- The Gemini API key stays server-side only.
- `CORS_ORIGIN` must match the frontend origin in local and production environments.
- Billing routes are placeholders and do not create real Stripe sessions.
