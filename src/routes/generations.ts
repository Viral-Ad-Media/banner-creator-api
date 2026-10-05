import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../db/supabase.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/error.js";
import {
  databaseError,
  finishGeneration,
  getUsageSummary,
  reserveGeneration,
} from "../lib/usage.js";
import { withProviderDeadline } from "../lib/providerFetch.js";
import { imageDataUrlSchema } from "../lib/validation.js";
import {
  downloadGeneratedVideo,
  editImage,
  generateBannerPlan,
  generateImage,
  getVideoGenerationStatus,
  startVideoGeneration,
} from "../services/gemini.js";
import {
  downloadOpenRouterGeneratedVideo,
  generateBannerPlanWithOpenRouter,
  getOpenRouterVideoGenerationStatus,
  startOpenRouterVideoGeneration,
} from "../services/openrouter.js";
import type { GenerationType } from "../types/domain.js";

const aspectRatioSchema = z.enum(["1:1", "16:9", "9:16", "3:4", "4:5"]);
const common = { projectId: z.string().uuid().optional() };
const planSchema = z.object({
  ...common,
  userPrompt: z.string().trim().min(3).max(5000),
  aspectRatio: aspectRatioSchema,
  bannerCount: z.number().int().min(1).max(6).optional(),
  hasBackgroundImage: z.boolean().optional(),
  hasAssetImage: z.boolean().optional(),
  textProvider: z.enum(["gemini", "openrouter"]).optional(),
});
const imageSchema = z.object({
  ...common,
  prompt: z.string().trim().min(3).max(5000),
  aspectRatio: aspectRatioSchema,
  referenceImages: z.array(imageDataUrlSchema).max(2).optional(),
});
const editSchema = z.object({
  ...common,
  base64Image: imageDataUrlSchema,
  prompt: z.string().trim().min(3).max(5000),
});
const videoSchema = z
  .object({
    ...common,
    prompt: z.string().trim().min(10).max(5000),
    negativePrompt: z.string().trim().max(1000).optional(),
    aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
    durationSeconds: z
      .union([z.literal(4), z.literal(5), z.literal(6), z.literal(8)])
      .default(8),
    modelPreset: z.enum(["fast", "quality"]).default("fast"),
    includeAudio: z.boolean().default(false),
    sourceImageDataUrl: imageDataUrlSchema.optional(),
    provider: z.enum(["gemini", "openrouter"]).default("gemini"),
  })
  .superRefine((p, ctx) => {
    if (p.provider === "gemini" && p.durationSeconds === 5)
      ctx.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: "Gemini supports 4, 6, or 8 seconds.",
      });
    if (
      p.sourceImageDataUrl &&
      p.provider === "gemini" &&
      p.durationSeconds !== 8
    )
      ctx.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: "Image-to-video requires 8 seconds.",
      });
  });
const idQuery = z.object({ generationId: z.string().uuid() });
const generationRouter = Router();
generationRouter.use(requireAuth);
generationRouter.use(
  createRateLimiter({
    windowMs: 60_000,
    max: 100,
    scope: "generations",
    authenticated: true,
  }),
);
generationRouter.use((_req, _res, next) => withProviderDeadline(next));

export const loadOwnedGeneration = async (userId: string, id: string) => {
  const { data, error } = await supabaseAdmin
    .from("generations")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) databaseError(error);
  if (!data) throw new ApiError(404, "Generation not found.");
  return data;
};
const publicJob = (g: any) => ({
  ...g.result?.job,
  generationId: g.id,
  status:
    g.status === "SUCCESS"
      ? "SUCCEEDED"
      : g.status === "FAILED"
        ? "FAILED"
        : (g.result?.job?.status ?? "PENDING"),
  done: g.status === "SUCCESS" || g.status === "FAILED",
  errorMessage: g.error_message ?? undefined,
});
export const reconcileVideo = async (userId: string, g: any) => {
  const job = g.result?.job;
  if (!job?.operationName)
    throw new ApiError(
      409,
      "Job dispatch is pending reconciliation. Retry this request later; do not start a duplicate.",
    );
  if (g.status === "SUCCESS" || g.status === "FAILED") return g;
  const status =
    job.provider === "openrouter"
      ? await getOpenRouterVideoGenerationStatus(
          job.operationName,
          job.modelPreset,
        )
      : await getVideoGenerationStatus(job.operationName, job.modelPreset);
  return finishGeneration(
    userId,
    g.id,
    status.status === "SUCCEEDED"
      ? "SUCCESS"
      : status.status === "FAILED"
        ? "FAILED"
        : "RUNNING",
    { ...g.result, job: { ...job, ...status } },
    status.status === "FAILED"
      ? "Video generation failed. Reserved credits were released."
      : undefined,
  );
};
const sendReplay = (res: any, kind: GenerationType, g: any, usage: any) => {
  const { result: _result, input: _input, ...metadata } = g;
  if (g.status === "FAILED")
    throw new ApiError(
      422,
      "This generation failed. Submit a new request to try again.",
    );
  if (kind === "VIDEO_GENERATION" && g.result?.job) {
    res.status(202).json({ job: publicJob(g), generation: metadata, usage });
    return;
  }
  if (g.status !== "SUCCESS")
    throw new ApiError(
      409,
      "This request is still running or awaiting reconciliation. Keep its request key and check activity.",
    );
  res.json({ data: g.result?.data, generation: metadata, usage });
};
const handler =
  (
    schema: z.ZodTypeAny,
    kind: GenerationType,
    generate: (p: any) => Promise<any>,
  ) =>
  async (req: any, res: any, next: any) => {
    let g: any;
    let providerReturned = false;
    let dispatchedHere = false;
    try {
      const payload = schema.parse(req.body);
      const key = z.string().uuid().parse(req.get("Idempotency-Key"));
      const input = {
        ...payload,
        referenceImages: payload.referenceImages?.map(() => "[image]"),
        base64Image: payload.base64Image ? "[image]" : undefined,
        sourceImageDataUrl: payload.sourceImageDataUrl ? "[image]" : undefined,
      };
      const reservation = await reserveGeneration(
        req.auth.userId,
        key,
        kind,
        payload,
        input,
      );
      g = reservation.generation;
      if (reservation.existing) {
        sendReplay(res, kind, g, await getUsageSummary(req.auth.userId));
        return;
      }
      dispatchedHere = true;
      const output = await generate(payload);
      providerReturned = true;
      const isVideo = kind === "VIDEO_GENERATION";
      const result = isVideo
        ? { job: { ...output, modelPreset: payload.modelPreset } }
        : { data: output };
      g = await finishGeneration(
        req.auth.userId,
        g.id,
        isVideo
          ? output.status === "FAILED"
            ? "FAILED"
            : output.status === "SUCCEEDED"
              ? "SUCCESS"
              : "RUNNING"
          : "SUCCESS",
        result,
      );
      sendReplay(res, kind, g, await getUsageSummary(req.auth.userId));
    } catch (error) {
      if (g && dispatchedHere && !providerReturned && g.status === "QUEUED") {
        const message = error instanceof Error ? error.message : "";
        const status = Number((error as { status?: number })?.status);
        const rejected =
          (error as { providerRejected?: boolean })?.providerRejected ||
          (status >= 400 && status < 500 && ![408, 409].includes(status)) ||
          /API_KEY is not configured/.test(message);
        // Malformed output or a dropped response may follow paid work: hold until verified.
        const uncertain = !rejected;
        try {
          await finishGeneration(
            req.auth.userId,
            g.id,
            uncertain ? "UNKNOWN" : "FAILED",
            null,
            uncertain
              ? "Provider outcome needs reconciliation. Credits remain reserved."
              : "Generation failed. Reserved credits were released.",
          );
        } catch (recordError) {
          console.error(
            "Generation reconciliation required",
            g.id,
            recordError,
          );
        }
      }
      next(error);
    }
  };
generationRouter.post(
  "/plan",
  handler(planSchema, "BANNER_PLAN", (p) =>
    p.textProvider === "openrouter" ||
    (!p.textProvider && env.TEXT_GENERATION_PROVIDER === "openrouter")
      ? generateBannerPlanWithOpenRouter(p)
      : generateBannerPlan(p),
  ),
);
generationRouter.post(
  "/image",
  handler(imageSchema, "IMAGE_GENERATION", (p) =>
    generateImage(p.prompt, p.aspectRatio, p.referenceImages ?? []),
  ),
);
generationRouter.post(
  "/edit",
  handler(editSchema, "IMAGE_EDIT", (p) => editImage(p.base64Image, p.prompt)),
);
generationRouter.post(
  "/video",
  handler(videoSchema, "VIDEO_GENERATION", (p) =>
    p.provider === "openrouter"
      ? startOpenRouterVideoGeneration(p)
      : startVideoGeneration(p),
  ),
);
generationRouter.get("/", async (req, res, next) => {
  try {
    const { offset } = z
      .object({ offset: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    const { data, error } = await supabaseAdmin
      .from("generations")
      .select(
        "id,project_id,type,status,prompt,aspect_ratio,error_message,created_at",
      )
      .eq("user_id", req.auth!.userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + 49);
    if (error) databaseError(error);
    res.json({
      generations: data ?? [],
      usage: await getUsageSummary(req.auth!.userId),
      nextOffset: data?.length === 50 ? offset + 50 : null,
    });
  } catch (e) {
    next(e);
  }
});
generationRouter.get("/video/status", async (req, res, next) => {
  try {
    const { generationId } = idQuery.parse(req.query);
    let g = await loadOwnedGeneration(req.auth!.userId, generationId);
    if (g.type !== "VIDEO_GENERATION")
      throw new ApiError(400, "Not a video generation.");
    g = await reconcileVideo(req.auth!.userId, g);
    res.json({ job: publicJob(g) });
  } catch (e) {
    next(e);
  }
});
generationRouter.get("/video/download", async (req, res, next) => {
  try {
    const { generationId } = idQuery.parse(req.query);
    let g = await loadOwnedGeneration(req.auth!.userId, generationId);
    if (g.type !== "VIDEO_GENERATION")
      throw new ApiError(400, "Not a video generation.");
    g = await reconcileVideo(req.auth!.userId, g);
    if (g.status !== "SUCCESS")
      throw new ApiError(409, "Video is not ready to download.");
    const job = g.result.job;
    const { buffer, mimeType } =
      job.provider === "openrouter"
        ? await downloadOpenRouterGeneratedVideo(
            job.operationName,
            job.modelPreset,
          )
        : await downloadGeneratedVideo(job.operationName);
    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="video-${g.id}.mp4"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buffer);
  } catch (e) {
    next(e);
  }
});
generationRouter.get("/:generationId", async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.generationId);
    let g = await loadOwnedGeneration(req.auth!.userId, id);
    if (g.type === "VIDEO_GENERATION" && g.result?.job)
      g = await reconcileVideo(req.auth!.userId, g);
    res.json({ generation: g });
  } catch (e) {
    next(e);
  }
});
export { generationRouter };
