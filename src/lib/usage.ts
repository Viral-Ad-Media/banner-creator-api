import { createHash } from "node:crypto";
import { supabaseAdmin } from "../db/supabase.js";
import type { GenerationType, PlanTier } from "../types/domain.js";
import { ApiError } from "../middleware/error.js";

export const databaseError = (error: {
  code?: string;
  message: string;
}): never => {
  if (error.code === "P0001") throw new ApiError(402, error.message);
  if (error.code === "P0002" || error.code === "PGRST116")
    throw new ApiError(404, "Resource not found.");
  if (error.code === "23505")
    throw new ApiError(409, "Request key has already been used.");
  console.error("Database operation failed", error.code, error.message);
  throw new ApiError(
    503,
    "Data service is temporarily unavailable. Please retry.",
  );
};
export const getUsageSummary = async (userId: string, _plan?: PlanTier) => {
  const { data, error } = await supabaseAdmin.rpc("credit_summary", {
    p_user_id: userId,
  });
  if (error) databaseError(error);
  return data;
};
export const reserveGeneration = async (
  userId: string,
  requestKey: string,
  kind: GenerationType,
  payload: any,
  input: any,
) => {
  const { data, error } = await supabaseAdmin.rpc("reserve_generation", {
    p_user_id: userId,
    p_request_key: requestKey,
    p_hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    p_kind: kind,
    p_prompt: payload.userPrompt ?? payload.prompt,
    p_aspect: payload.aspectRatio ?? null,
    p_project_id: payload.projectId ?? null,
    p_input: input,
  });
  if (error) databaseError(error);
  return data as { generation: any; existing: boolean };
};
export const finishGeneration = async (
  userId: string,
  generationId: string,
  status: string,
  result: unknown,
  errorMessage?: string,
) => {
  const { data, error } = await supabaseAdmin.rpc("finish_generation", {
    p_user_id: userId,
    p_generation_id: generationId,
    p_status: status,
    p_result: result,
    p_error: errorMessage ?? null,
  });
  if (error) databaseError(error);
  return data;
};
