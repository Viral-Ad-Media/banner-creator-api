import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './error.js';

type LimiterOptions = {
  windowMs: number;
  max: number;
};

type Entry = {
  count: number;
  resetAt: number;
};

export const createRateLimiter = ({ windowMs, max }: LimiterOptions) => {
  const store = new Map<string, Entry>();

  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    const now = Date.now();
    const current = store.get(key);

    if (!current || current.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (current.count >= max) {
      next(new ApiError(429, 'Rate limit exceeded. Try again shortly.'));
      return;
    }

    current.count += 1;
    store.set(key, current);
    next();
  };
};
