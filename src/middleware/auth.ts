import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../db/supabase.js';
import type { PlanTier } from '../types/domain.js';
import { ApiError } from './error.js';

const extractBearerToken = (authHeader?: string) => {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
};

const normalizePlan = (value: string | null): PlanTier => {
  if (value === 'PRO' || value === 'ENTERPRISE') return value;
  return 'FREE';
};

export const requireAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw new ApiError(401, 'Missing authorization token.');
    }

    const { data: userResult, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userResult.user) {
      throw new ApiError(401, 'Invalid or expired token.');
    }

    const authUser = userResult.user;
    if (!authUser.email) {
      throw new ApiError(400, 'Authenticated user is missing an email address.');
    }

    const fallbackName =
      (authUser.user_metadata?.name as string | undefined) ||
      (authUser.user_metadata?.full_name as string | undefined) ||
      (authUser.email?.split('@')[0] ?? 'User');

    const { data: existingProfile, error: profileLookupError } = await supabaseAdmin
      .from('app_users')
      .select('id, plan')
      .eq('id', authUser.id)
      .maybeSingle();

    if (profileLookupError) {
      throw new ApiError(500, `Failed to load user profile: ${profileLookupError.message}`);
    }

    let appUser = existingProfile;
    if (!appUser) {
      const { data: insertedProfile, error: insertError } = await supabaseAdmin
        .from('app_users')
        .insert({
          id: authUser.id,
          email: authUser.email,
          name: fallbackName,
          plan: 'FREE',
        })
        .select('id, plan')
        .single();

      if (insertError || !insertedProfile) {
        throw new ApiError(500, `Failed to create user profile: ${insertError?.message || 'unknown error'}`);
      }

      appUser = insertedProfile;
    }

    req.auth = {
      userId: appUser.id,
      plan: normalizePlan(appUser.plan),
    };

    next();
  } catch (error) {
    next(error);
  }
};
