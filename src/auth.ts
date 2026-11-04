import { password } from "./password.js";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { pool } from "./db/pool.js";
import { env } from "./config/env.js";
export const auth = betterAuth({
  database: pool,
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth/session",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.CORS_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  advanced: { database: { generateId: "uuid" } },
  user: { modelName: "auth_user" },
  session: { modelName: "auth_session", cookieCache: { enabled: false } },
  account: { modelName: "auth_account", accountLinking: { enabled: false } },
  verification: { modelName: "auth_verification" },
  // The Express auth routes use the shared PostgreSQL limiter across instances.
  rateLimit: { enabled: false },
  emailAndPassword: {
    enabled: true,
    password,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM)
        throw new APIError("SERVICE_UNAVAILABLE", {
          message:
            "Password recovery email is not configured. Contact support.",
        });
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.AUTH_EMAIL_FROM,
          to: [user.email],
          subject: "Reset your Banner Creator password",
          text: `Reset your password using this link: ${url}`,
        }),
      });
      if (!response.ok)
        throw new APIError("SERVICE_UNAVAILABLE", {
          message: "Could not send password recovery email. Please retry.",
        });
    },
  },
});
