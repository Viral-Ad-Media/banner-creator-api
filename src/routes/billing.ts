import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getPlanConfig } from '../config/plans.js';
import { supabaseAdmin } from '../db/supabase.js';
import { getUsageSummary } from '../lib/usage.js';
import { requireAuth } from '../middleware/auth.js';

const checkoutSchema = z.object({
  plan: z.enum(['PRO', 'ENTERPRISE']),
});

const billingRouter = Router();
billingRouter.use(requireAuth);

billingRouter.get('/summary', async (req, res, next) => {
  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('app_users')
      .select('id, email, plan')
      .eq('id', req.auth!.userId)
      .single();

    if (userError || !user) {
      res.status(404).json({ error: `User not found: ${userError?.message || 'missing'}` });
      return;
    }

    const { data: billingCustomer } = await supabaseAdmin
      .from('billing_customers')
      .select('id, user_id, provider, customer_id, subscription_id, status, current_period_end, created_at, updated_at')
      .eq('user_id', req.auth!.userId)
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

billingRouter.post('/checkout-session', async (req, res, next) => {
  try {
    const payload = checkoutSchema.parse(req.body);

    const customerId = `cust_${randomUUID()}`;
    const subscriptionId = `sub_${randomUUID()}`;

    const { data: billing, error: billingError } = await supabaseAdmin
      .from('billing_customers')
      .upsert(
        {
          user_id: req.auth!.userId,
          customer_id: customerId,
          subscription_id: subscriptionId,
          status: 'active',
          current_period_end: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
        },
        {
          onConflict: 'user_id',
        }
      )
      .select('id, user_id, provider, customer_id, subscription_id, status, current_period_end, created_at, updated_at')
      .single();

    if (billingError || !billing) {
      throw new Error(billingError?.message || 'Could not update billing profile');
    }

    const { error: planError } = await supabaseAdmin
      .from('app_users')
      .update({ plan: payload.plan })
      .eq('id', req.auth!.userId);

    if (planError) {
      throw new Error(planError.message);
    }

    res.json({
      checkoutUrl: `https://example.com/mock-checkout?plan=${payload.plan}&session=${billing.subscription_id}`,
      billing,
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/portal-session', async (req, res, next) => {
  try {
    const { data: billing } = await supabaseAdmin
      .from('billing_customers')
      .select('customer_id')
      .eq('user_id', req.auth!.userId)
      .maybeSingle();

    res.json({
      portalUrl: `https://example.com/mock-billing-portal?customer=${billing?.customer_id || 'unknown'}`,
    });
  } catch (error) {
    next(error);
  }
});

export { billingRouter };
