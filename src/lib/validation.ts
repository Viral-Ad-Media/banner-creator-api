import { ApiError } from "../middleware/error.js";
import { z } from "zod";
export const imageDataUrlSchema = z
  .string()
  .max(1_000_000)
  .regex(
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
    "Use a PNG, JPEG, or WebP image under 750 KB.",
  );
export const bannerPlanSchema = z.object({
  main_banner: z.object({
    headline: z.string().min(1),
    subheadline: z.string(),
    image_prompt: z.string().min(1),
    description: z.string(),
    cta: z.string().min(1),
  }),
  additional_banners: z
    .array(
      z.object({
        title: z.string().min(1),
        subtitle: z.string(),
        image_prompt: z.string().min(1),
        description: z.string(),
        cta: z.string().min(1),
      }),
    )
    .max(5),
  seo: z.object({
    caption: z.string(),
    hashtags: z.array(z.string()),
    keywords: z.array(z.string()),
  }),
});

export const parseProviderOutput = <T>(
  schema: z.ZodType<T>,
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(502, "Provider returned invalid output.");
  return result.data;
};
