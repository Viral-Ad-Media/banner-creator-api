import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../db/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { databaseError } from "../lib/usage.js";
import { ApiError } from "../middleware/error.js";

const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().max(5000).optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "3:4", "4:5"]).optional(),
  data: z.record(z.any()).optional(),
});

const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().max(5000).nullable().optional(),
  aspectRatio: z
    .enum(["1:1", "16:9", "9:16", "3:4", "4:5"])
    .nullable()
    .optional(),
  data: z.record(z.any()).nullable().optional(),
});

const projectRouter = Router();
projectRouter.use(requireAuth);

projectRouter.get("/", async (req, res, next) => {
  try {
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(req.query.offset);
    const { data: projects, error } = await supabaseAdmin
      .from("projects")
      .select("id, user_id, name, prompt, aspect_ratio, created_at, updated_at")
      .eq("user_id", req.auth!.userId)
      .order("updated_at", { ascending: false })
      .range(offset, offset + 49);

    if (error) {
      throw new ApiError(500, `Failed to load projects: ${error.message}`);
    }

    res.json({ projects: projects ?? [] });
  } catch (error) {
    next(error);
  }
});

projectRouter.post("/", async (req, res, next) => {
  try {
    const payload = projectCreateSchema.parse(req.body);

    const { data: project, error } = await supabaseAdmin.rpc(
      "create_resource",
      {
        p_user_id: req.auth!.userId,
        p_kind: "project",
        p_payload: payload,
      },
    );
    if (error) databaseError(error);

    res.status(201).json({ project });
  } catch (error) {
    next(error);
  }
});

projectRouter.get("/:projectId", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .select(
        "id, user_id, name, prompt, aspect_ratio, data, created_at, updated_at",
      )
      .eq("id", projectId)
      .eq("user_id", req.auth!.userId)
      .single();

    if (error || !project) {
      throw new ApiError(404, "Project not found.");
    }

    const { data: generations, error: generationsError } = await supabaseAdmin
      .from("generations")
      .select(
        "id, type, status, prompt, aspect_ratio, error_message, created_at",
      )
      .eq("project_id", project.id)
      .eq("user_id", req.auth!.userId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (generationsError) {
      throw new ApiError(
        500,
        `Failed to load project generations: ${generationsError.message}`,
      );
    }

    res.json({
      project: {
        ...project,
        generations: generations ?? [],
      },
    });
  } catch (error) {
    next(error);
  }
});

projectRouter.patch("/:projectId", async (req, res, next) => {
  try {
    const payload = projectUpdateSchema.parse(req.body);

    const updates: Record<string, unknown> = {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
      ...(payload.aspectRatio !== undefined
        ? { aspect_ratio: payload.aspectRatio }
        : {}),
      ...(payload.data !== undefined ? { data: payload.data } : {}),
    };

    const projectId = z.string().uuid().parse(req.params.projectId);
    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .update(updates)
      .eq("id", projectId)
      .eq("user_id", req.auth!.userId)
      .select(
        "id, user_id, name, prompt, aspect_ratio, data, created_at, updated_at",
      )
      .single();

    if (error || !project) {
      throw new ApiError(404, "Project not found.");
    }

    res.json({ project });
  } catch (error) {
    next(error);
  }
});

projectRouter.delete("/:projectId", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const { error } = await supabaseAdmin
      .from("projects")
      .delete()
      .eq("id", projectId)
      .eq("user_id", req.auth!.userId);

    if (error) {
      throw new ApiError(500, `Failed to delete project: ${error.message}`);
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { projectRouter };
