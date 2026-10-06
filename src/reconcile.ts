import "dotenv/config";
import { supabaseAdmin } from "./db/supabase.js";
import { reconcileVideo } from "./routes/generations.js";
import { finishGeneration } from "./lib/usage.js";
// Run with service credentials from a scheduler; never exposed as a public endpoint.
const id = process.env.RECONCILE_ID;
if (id) {
  const outcome = process.env.RECONCILE_OUTCOME;
  if (outcome !== "SUCCESS" && outcome !== "FAILED")
    throw new Error("Provide a verified RECONCILE_OUTCOME=SUCCESS or FAILED.");
  const { data, error } = await supabaseAdmin
    .from("generations")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  await finishGeneration(
    data.user_id,
    id,
    outcome,
    null,
    "Manually reconciled by operator after checking provider outcome.",
  );
  console.log("Reconciled generation", id);
} else {
  let offset = 0;
  const ids: string[] = [];
  // Capture IDs before changing statuses so offset pagination cannot skip updated rows.
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("generations")
      .select("id")
      .eq("type", "VIDEO_GENERATION")
      .in("status", ["QUEUED", "RUNNING", "UNKNOWN"])
      .order("created_at")
      .range(offset, offset + 99);
    if (error) throw error;
    ids.push(...(data ?? []).map((g) => g.id));
    if ((data?.length ?? 0) < 100) break;
    offset += 100;
  }
  for (const generationId of ids) {
    const { data, error } = await supabaseAdmin
      .from("generations")
      .select("*")
      .eq("id", generationId)
      .single();
    if (error) {
      console.error("Could not load job", generationId);
      continue;
    }
    if (!data.result?.job) {
      console.warn("Dispatch outcome needs operator review", generationId);
      continue;
    }
    try {
      await reconcileVideo(data.user_id, data);
    } catch (error) {
      console.error("Job reconciliation deferred", generationId, error);
    }
  }
}
