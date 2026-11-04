import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { database } from "../db/database.js";
import { ApiError } from "./error.js";
export const createRateLimiter =
  ({
    windowMs,
    max,
    scope = "api",
    authenticated = false,
  }: {
    windowMs: number;
    max: number;
    scope?: string;
    authenticated?: boolean;
  }) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = authenticated ? req.auth?.userId : req.ip;
      if (!identity) throw new ApiError(401, "Authentication required.");
      const key = createHash("sha256")
        .update(`${scope}:${identity}`)
        .digest("hex");
      const { data, error } = await database.rpc("consume_rate_limit", {
        p_key: key,
        p_max: max,
        p_window_seconds: Math.ceil(windowMs / 1000),
      });
      if (error)
        throw new ApiError(
          503,
          "Rate limit service is temporarily unavailable.",
        );
      if (!data) {
        res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
        throw new ApiError(429, "Rate limit exceeded. Try again shortly.");
      }
      next();
    } catch (error) {
      next(error);
    }
  };
