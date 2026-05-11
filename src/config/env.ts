import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  GEMINI_API_KEY: z.string().min(1),
  TEXT_GENERATION_PROVIDER: z.enum(['gemini', 'openrouter']).default('gemini'),
  OPENROUTER_API_KEY: optionalNonEmptyString,
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_TEXT_MODEL: z.string().min(1).default('openai/gpt-5.2'),
  OPENROUTER_VIDEO_MODEL_FAST: z.string().min(1).default('google/veo-3.1'),
  OPENROUTER_VIDEO_MODEL_QUALITY: z.string().min(1).default('google/veo-3.1'),
  OPENROUTER_APP_URL: optionalNonEmptyString,
  OPENROUTER_APP_NAME: z.string().min(1).default('Social Studio'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid backend environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Backend environment validation failed.');
}

export const env = parsed.data;
