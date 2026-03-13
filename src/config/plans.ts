import type { PlanTier } from '../types/domain.js';

export type PlanConfig = {
  tier: PlanTier;
  monthlyCredits: number;
  projectLimit: number;
  maxTeamMembers: number;
};

export const PLAN_CONFIGS: Record<PlanTier, PlanConfig> = {
  FREE: {
    tier: 'FREE',
    monthlyCredits: 120,
    projectLimit: 5,
    maxTeamMembers: 1,
  },
  PRO: {
    tier: 'PRO',
    monthlyCredits: 3000,
    projectLimit: 100,
    maxTeamMembers: 5,
  },
  ENTERPRISE: {
    tier: 'ENTERPRISE',
    monthlyCredits: 50000,
    projectLimit: 1000,
    maxTeamMembers: 100,
  },
};

export const getPlanConfig = (tier: PlanTier) => PLAN_CONFIGS[tier];
