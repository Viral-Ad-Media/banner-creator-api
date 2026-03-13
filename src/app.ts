import cors from 'cors';
import express from 'express';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import type { HelmetOptions } from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { projectRouter } from './routes/projects.js';
import { generationRouter } from './routes/generations.js';
import { billingRouter } from './routes/billing.js';

export const app = express();

const allowedOrigins = env.CORS_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
type HelmetFactory = (options?: Readonly<HelmetOptions>) => RequestHandler;

// Vercel's TS build can resolve `helmet` as a module namespace even though the
// runtime ESM default import is the callable middleware factory.
const helmetMiddleware = helmet as unknown as HelmetFactory;

app.use(helmetMiddleware());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: false,
  })
);
app.use(morgan('dev'));
app.use(express.json({ limit: '12mb' }));

app.use('/api', createRateLimiter({ windowMs: 60_000, max: 300 }));
app.use('/api/auth', createRateLimiter({ windowMs: 60_000, max: 30 }));

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/projects', projectRouter);
app.use('/api/generations', generationRouter);
app.use('/api/billing', billingRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
