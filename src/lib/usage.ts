import { supabaseAdmin } from '../db/supabase.js';
import { getPlanConfig } from '../config/plans.js';
import type { GenerationType, PlanTier } from '../types/domain.js';
import { ApiError } from '../middleware/error.js';

const CREDIT_COST: Record<GenerationType, number> = {
  BANNER_PLAN: 3,
  IMAGE_GENERATION: 5,
  IMAGE_EDIT: 5,
};

const startOfCurrentMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

export const getCreditCost = (kind: GenerationType) => CREDIT_COST[kind];

export const getUsageSummary = async (userId: string, plan: PlanTier) => {
  const monthStart = startOfCurrentMonth().toISOString();

  const { data, error } = await supabaseAdmin
    .from('usage_events')
    .select('credits')
    .eq('user_id', userId)
    .gte('created_at', monthStart);

  if (error) {
    throw new ApiError(500, `Failed to fetch usage summary: ${error.message}`);
  }

  const usedCredits = (data ?? []).reduce((total, row) => total + (row.credits ?? 0), 0);
  const limit = getPlanConfig(plan).monthlyCredits;
  const remainingCredits = Math.max(0, limit - usedCredits);

  return {
    usedCredits,
    remainingCredits,
    limit,
  };
};

export const assertCreditsAvailable = async (userId: string, plan: PlanTier, kind: GenerationType) => {
  const usage = await getUsageSummary(userId, plan);
  const requiredCredits = getCreditCost(kind);

  if (usage.remainingCredits < requiredCredits) {
    throw new ApiError(402, 'Monthly credit limit reached for your plan. Upgrade to continue generating assets.');
  }

  return {
    requiredCredits,
    usage,
  };
};

export const trackUsage = async (userId: string, kind: GenerationType) => {
  const credits = getCreditCost(kind);

  const { error } = await supabaseAdmin.from('usage_events').insert({
    user_id: userId,
    kind,
    credits,
  });

  if (error) {
    throw new ApiError(500, `Failed to track usage: ${error.message}`);
  }
};
