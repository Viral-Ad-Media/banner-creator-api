import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth.js";
import { pool } from "../db/pool.js";
import { ApiError } from "./error.js";
export const requireAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    let session;
    try {
      session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
    } catch {
      throw new ApiError(
        503,
        "Authentication service is temporarily unavailable. Please retry.",
      );
    }
    if (!session?.user) throw new ApiError(401, "Sign in to continue.");
    const user = session.user;
    // Never adopt profiles by email or overwrite an existing entitlement on login.
    await pool.query(
      `INSERT INTO app_users(id,email,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,
      [user.id, user.email, user.name],
    );
    const { rows } = await pool.query(
      "SELECT id,plan FROM app_users WHERE id=$1",
      [user.id],
    );
    const profile = rows[0];
    if (!profile)
      throw new ApiError(503, "Could not load profile. Please retry.");
    req.auth = {
      userId: profile.id,
      plan:
        profile.plan === "PRO" || profile.plan === "ENTERPRISE"
          ? profile.plan
          : "FREE",
    };
    next();
  } catch (error) {
    next(error);
  }
};
