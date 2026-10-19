import { Router } from "express";
import { z } from "zod";
import { getPlanConfig } from "../config/plans.js";
import { supabaseAdmin } from "../db/supabase.js";
import { getUsageSummary } from "../lib/usage.js";
import { ApiError } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";

const checkoutSchema = z.object({
  plan: z.enum(["PRO", "ENTERPRISE"]),
});

const billingRouter = Router();
billingRouter.use(requireAuth);

billingRouter.get("/summary", async (req, res, next) => {
  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from("app_users")
      .select("id, email, plan")
      .eq("id", req.auth!.userId)
      .single();

    if (userError || !user) {
      res.status(404).json({ error: "User profile not found." });
      return;
    }

    const { data: billingCustomer } = await supabaseAdmin
      .from("billing_customers")
      .select(
        "id, user_id, provider, customer_id, subscription_id, status, current_period_end, created_at, updated_at",
      )
      .eq("user_id", req.auth!.userId)
      .maybeSingle();

    const usage = await getUsageSummary(user.id, req.auth!.plan);

    res.json({
      plan: getPlanConfig(req.auth!.plan),
      usage,
      billing: billingCustomer,
    });
  } catch (error) {
    next(error);
  }
});

// Payments are intentionally disabled until verified processor webhooks are configured.
billingRouter.post("/checkout-session", (req, _res, next) => {
  try {
    checkoutSchema.parse(req.body);
    next(
      new ApiError(
        501,
        "Paid upgrades are not available yet. Contact support.",
      ),
    );
  } catch (error) {
    next(error);
  }
});
billingRouter.post("/portal-session", (_req, _res, next) =>
  next(new ApiError(501, "Billing portal is not available yet.")),
);
export { billingRouter };
