export type PlanTier = 'FREE' | 'PRO' | 'ENTERPRISE';

export const PLAN_TIERS: PlanTier[] = ['FREE', 'PRO', 'ENTERPRISE'];

export type TextGenerationProvider = 'gemini' | 'openrouter';

export type VideoGenerationProvider = 'gemini' | 'openrouter';

export const TEXT_GENERATION_PROVIDERS: TextGenerationProvider[] = ['gemini', 'openrouter'];

export const VIDEO_GENERATION_PROVIDERS: VideoGenerationProvider[] = ['gemini', 'openrouter'];

export type GenerationType = 'BANNER_PLAN' | 'IMAGE_GENERATION' | 'IMAGE_EDIT' | 'VIDEO_GENERATION';

export type GenerationStatus = 'SUCCESS' | 'FAILED';

export const GENERATION_TYPES: GenerationType[] = ['BANNER_PLAN', 'IMAGE_GENERATION', 'IMAGE_EDIT', 'VIDEO_GENERATION'];

export type AppUser = {
  id: string;
  email: string;
  name: string;
  plan: PlanTier;
};
