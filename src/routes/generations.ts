import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/error.js';
import { assertCreditsAvailable, getUsageSummary, trackUsage } from '../lib/usage.js';
import { editImage, generateBannerPlan, generateImage } from '../services/gemini.js';
import type { GenerationStatus, GenerationType } from '../types/domain.js';

const aspectRatioSchema = z.enum(['1:1', '16:9', '9:16', '3:4', '4:5']);

const planSchema = z.object({
  userPrompt: z.string().trim().min(3).max(5000),
  aspectRatio: aspectRatioSchema,
  hasBackgroundImage: z.boolean().optional(),
  hasAssetImage: z.boolean().optional(),
  projectId: z.string().uuid().optional(),
});

const imageSchema = z.object({
  prompt: z.string().trim().min(3).max(5000),
  aspectRatio: aspectRatioSchema,
  referenceImages: z.array(z.string()).max(2).optional(),
  projectId: z.string().uuid().optional(),
});

const editSchema = z.object({
  base64Image: z.string().min(30),
  prompt: z.string().trim().min(3).max(5000),
  projectId: z.string().uuid().optional(),
});

const generationRouter = Router();
generationRouter.use(requireAuth);

const insertGeneration = async (params: {
  userId: string;
  projectId?: string;
  type: GenerationType;
  status: GenerationStatus;
  prompt: string;
  aspectRatio?: string;
  input?: unknown;
  result?: unknown;
  errorMessage?: string;
}) => {
  const { data, error } = await supabaseAdmin
    .from('generations')
    .insert({
      user_id: params.userId,
      project_id: params.projectId,
      type: params.type,
      status: params.status,
      prompt: params.prompt,
      aspect_ratio: params.aspectRatio,
      input: params.input,
      result: params.result,
      error_message: params.errorMessage,
    })
    .select('id, created_at')
    .single();

  if (error || !data) {
    throw new ApiError(500, `Failed to persist generation: ${error?.message || 'unknown'}`);
  }

  return data;
};

generationRouter.get('/', async (req, res, next) => {
  try {
    const { data: generations, error } = await supabaseAdmin
      .from('generations')
      .select('id, project_id, type, status, prompt, aspect_ratio, input, result, error_message, created_at')
      .eq('user_id', req.auth!.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      throw new ApiError(500, `Failed to load generation history: ${error.message}`);
    }

    const usage = await getUsageSummary(req.auth!.userId, req.auth!.plan);
    res.json({ generations: generations ?? [], usage });
  } catch (error) {
    next(error);
  }
});

generationRouter.post('/plan', async (req, res, next) => {
  const userId = req.auth!.userId;
  try {
    const payload = planSchema.parse(req.body);
    await assertCreditsAvailable(userId, req.auth!.plan, 'BANNER_PLAN');

    const result = await generateBannerPlan({
      userPrompt: payload.userPrompt,
      aspectRatio: payload.aspectRatio,
      hasBackgroundImage: payload.hasBackgroundImage,
      hasAssetImage: payload.hasAssetImage,
    });

    const generation = await insertGeneration({
      userId,
      projectId: payload.projectId,
      type: 'BANNER_PLAN',
      status: 'SUCCESS',
      prompt: payload.userPrompt,
      aspectRatio: payload.aspectRatio,
      input: payload,
      result,
    });

    await trackUsage(userId, 'BANNER_PLAN');
    const usage = await getUsageSummary(userId, req.auth!.plan);

    res.json({ data: result, generation, usage });
  } catch (error) {
    await supabaseAdmin.from('generations').insert({
      user_id: userId,
      type: 'BANNER_PLAN',
      status: 'FAILED',
      prompt: String(req.body?.userPrompt ?? 'Unknown prompt'),
      aspect_ratio: req.body?.aspectRatio,
      input: req.body,
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });

    next(error);
  }
});

generationRouter.post('/image', async (req, res, next) => {
  const userId = req.auth!.userId;
  try {
    const payload = imageSchema.parse(req.body);
    await assertCreditsAvailable(userId, req.auth!.plan, 'IMAGE_GENERATION');

    const image = await generateImage(payload.prompt, payload.aspectRatio, payload.referenceImages ?? []);

    const generation = await insertGeneration({
      userId,
      projectId: payload.projectId,
      type: 'IMAGE_GENERATION',
      status: 'SUCCESS',
      prompt: payload.prompt,
      aspectRatio: payload.aspectRatio,
      input: payload,
      result: { image },
    });

    await trackUsage(userId, 'IMAGE_GENERATION');
    const usage = await getUsageSummary(userId, req.auth!.plan);

    res.json({ data: image, generation, usage });
  } catch (error) {
    await supabaseAdmin.from('generations').insert({
      user_id: userId,
      type: 'IMAGE_GENERATION',
      status: 'FAILED',
      prompt: String(req.body?.prompt ?? 'Unknown prompt'),
      aspect_ratio: req.body?.aspectRatio,
      input: req.body,
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });

    next(error);
  }
});

generationRouter.post('/edit', async (req, res, next) => {
  const userId = req.auth!.userId;
  try {
    const payload = editSchema.parse(req.body);
    await assertCreditsAvailable(userId, req.auth!.plan, 'IMAGE_EDIT');

    const editedImage = await editImage(payload.base64Image, payload.prompt);

    const generation = await insertGeneration({
      userId,
      projectId: payload.projectId,
      type: 'IMAGE_EDIT',
      status: 'SUCCESS',
      prompt: payload.prompt,
      input: {
        projectId: payload.projectId,
      },
      result: { image: editedImage },
    });

    await trackUsage(userId, 'IMAGE_EDIT');
    const usage = await getUsageSummary(userId, req.auth!.plan);

    res.json({ data: editedImage, generation, usage });
  } catch (error) {
    await supabaseAdmin.from('generations').insert({
      user_id: userId,
      type: 'IMAGE_EDIT',
      status: 'FAILED',
      prompt: String(req.body?.prompt ?? 'Unknown prompt'),
      input: req.body,
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });

    next(error);
  }
});

export { generationRouter };
