import type { PlanTier } from './domain.js';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        plan: PlanTier;
      };
    }
  }
}

export {};
