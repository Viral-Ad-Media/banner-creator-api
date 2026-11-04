import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import express from "express";
import type { RequestHandler } from "express";
import helmet from "helmet";
import type { HelmetOptions } from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { createRateLimiter } from "./middleware/rateLimit.js";
import { ApiError, errorHandler, notFoundHandler } from "./middleware/error.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { projectRouter } from "./routes/projects.js";
import { generationRouter } from "./routes/generations.js";
import { avatarRouter } from "./routes/avatars.js";
import { billingRouter } from "./routes/billing.js";

export const app = express();
app.set("trust proxy", env.TRUST_PROXY_HOPS);

const allowedOrigins = env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
type HelmetFactory = (options?: Readonly<HelmetOptions>) => RequestHandler;

// Vercel's TS build can resolve `helmet` as a module namespace even though the
// runtime ESM default import is the callable middleware factory.
const helmetMiddleware = helmet as unknown as HelmetFactory;

app.use(helmetMiddleware());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new ApiError(403, "Origin is not allowed."));
    },
    credentials: true,
  }),
);
// Recovery callbacks include one-time tokens in their URLs. Never write them to access logs.
app.use(morgan("dev", { skip: (req) => req.path.startsWith("/api/auth/session/") }));


app.use(
  "/api",
  createRateLimiter({ windowMs: 60_000, max: 300, scope: "api" }),
);
app.use(
  "/api/auth",
  createRateLimiter({ windowMs: 60_000, max: 30, scope: "auth" }),
);

// Better Auth consumes the raw request stream; mount before express.json.
app.all("/api/auth/session/*", toNodeHandler(auth));
app.use(express.json({ limit: "4mb" }));
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/avatars", avatarRouter);
app.use("/api/projects", projectRouter);
app.use("/api/generations", generationRouter);
app.use("/api/billing", billingRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
