import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../db/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/error.js';

const authRouter = Router();
authRouter.use(requireAuth);

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

authRouter.get('/me', async (req, res, next) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('app_users')
      .select('id, name, email, plan')
      .eq('id', req.auth!.userId)
      .single();

    if (error || !user) {
      throw new ApiError(404, `User profile not found: ${error?.message || 'missing'}`);
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

authRouter.patch('/me', async (req, res, next) => {
  try {
    const payload = updateProfileSchema.parse(req.body);

    const { data: user, error } = await supabaseAdmin
      .from('app_users')
      .update({ name: payload.name })
      .eq('id', req.auth!.userId)
      .select('id, name, email, plan')
      .single();

    if (error || !user) {
      throw new ApiError(500, `Failed to update user profile: ${error?.message || 'unknown'}`);
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

export { authRouter };
