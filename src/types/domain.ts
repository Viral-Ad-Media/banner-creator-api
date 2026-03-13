export type PlanTier = 'FREE' | 'PRO' | 'ENTERPRISE';

export const PLAN_TIERS: PlanTier[] = ['FREE', 'PRO', 'ENTERPRISE'];

export type GenerationType = 'BANNER_PLAN' | 'IMAGE_GENERATION' | 'IMAGE_EDIT';

export type GenerationStatus = 'SUCCESS' | 'FAILED';

export const GENERATION_TYPES: GenerationType[] = ['BANNER_PLAN', 'IMAGE_GENERATION', 'IMAGE_EDIT'];

export type AppUser = {
  id: string;
  email: string;
  name: string;
  plan: PlanTier;
};
