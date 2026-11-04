import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  PROVIDER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(45000)
    .default(40000),
  PORT: z.coerce.number().int().positive().default(4000),
  GEMINI_API_KEY: optionalNonEmptyString,
  TEXT_GENERATION_PROVIDER: z.enum(["gemini", "openrouter"]).default("gemini"),
  OPENROUTER_API_KEY: optionalNonEmptyString,
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_TEXT_MODEL: z.string().min(1).default("openai/gpt-5.2"),
  OPENROUTER_VIDEO_MODEL_FAST: z.string().min(1).default("google/veo-3.1"),
  OPENROUTER_VIDEO_MODEL_QUALITY: z.string().min(1).default("google/veo-3.1"),
  OPENROUTER_APP_URL: optionalNonEmptyString,
  OPENROUTER_APP_NAME: z.string().min(1).default("Social Studio"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().url().refine(v => /^postgres(ql)?:/.test(v), "Expected PostgreSQL URL"),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  RESEND_API_KEY: optionalNonEmptyString,
  AUTH_EMAIL_FROM: optionalNonEmptyString,
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "Invalid backend environment variables:",
    parsed.error.flatten().fieldErrors,
  );
  throw new Error("Backend environment validation failed.");
}

export const env = parsed.data;
