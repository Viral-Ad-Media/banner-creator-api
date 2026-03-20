import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/error.js';

const MAX_AVATARS_PER_USER = 12;
const avatarSelectFields = 'id, name, image_data_url, source, prompt, created_at';

const avatarCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  imageDataUrl: z
    .string()
    .min(30)
    .max(6_000_000)
    .refine((value) => value.startsWith('data:image/'), 'Avatar image must be a data URL.'),
  source: z.enum(['upload', 'generated']),
  prompt: z.string().trim().max(5000).optional(),
});

const avatarParamsSchema = z.object({
  avatarId: z.string().uuid(),
});

type AvatarRecord = {
  id: string;
  name: string;
  image_data_url: string;
  source: 'upload' | 'generated';
  prompt: string | null;
  created_at: string;
};

const mapAvatarRecord = (record: AvatarRecord) => ({
  id: record.id,
  name: record.name,
  imageDataUrl: record.image_data_url,
  source: record.source,
  prompt: record.prompt ?? undefined,
  createdAt: record.created_at,
});

const avatarRouter = Router();
avatarRouter.use(requireAuth);

avatarRouter.get('/', async (req, res, next) => {
  try {
    const { data: avatars, error } = await supabaseAdmin
      .from('avatars')
      .select(avatarSelectFields)
      .eq('user_id', req.auth!.userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new ApiError(500, `Failed to load avatars: ${error.message}`);
    }

    res.json({
      avatars: (avatars ?? []).map((avatar) => mapAvatarRecord(avatar as AvatarRecord)),
    });
  } catch (error) {
    next(error);
  }
});

avatarRouter.post('/', async (req, res, next) => {
  try {
    const payload = avatarCreateSchema.parse(req.body);

    const { count, error: countError } = await supabaseAdmin
      .from('avatars')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.auth!.userId);

    if (countError) {
      throw new ApiError(500, `Failed to check avatar limits: ${countError.message}`);
    }

    if ((count ?? 0) >= MAX_AVATARS_PER_USER) {
      throw new ApiError(409, 'Avatar limit reached. Remove an older avatar to save a new one.');
    }

    const { data: avatar, error } = await supabaseAdmin
      .from('avatars')
      .insert({
        user_id: req.auth!.userId,
        name: payload.name,
        image_data_url: payload.imageDataUrl,
        source: payload.source,
        prompt: payload.prompt,
      })
      .select(avatarSelectFields)
      .single();

    if (error || !avatar) {
      throw new ApiError(500, `Failed to save avatar: ${error?.message || 'unknown error'}`);
    }

    res.status(201).json({
      avatar: mapAvatarRecord(avatar as AvatarRecord),
    });
  } catch (error) {
    next(error);
  }
});

avatarRouter.delete('/:avatarId', async (req, res, next) => {
  try {
    const { avatarId } = avatarParamsSchema.parse(req.params);

    const { error } = await supabaseAdmin
      .from('avatars')
      .delete()
      .eq('id', avatarId)
      .eq('user_id', req.auth!.userId);

    if (error) {
      throw new ApiError(500, `Failed to delete avatar: ${error.message}`);
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { avatarRouter };
