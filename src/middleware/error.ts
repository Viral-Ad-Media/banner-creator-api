import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const notFoundHandler = (
  _req: Request,
  _res: Response,
  next: NextFunction,
) => next(new ApiError(404, "Route not found."));
export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (error instanceof ZodError) {
    res
      .status(400)
      .json({
        error: "Invalid request.",
        fields: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    return;
  }
  if (error instanceof ApiError) {
    if (error.statusCode >= 500 && error.statusCode !== 501)
      console.error("API failure", error);
    res
      .status(error.statusCode)
      .json({
        error:
          error.statusCode >= 500 && error.statusCode !== 501
            ? "Service is temporarily unavailable. Please retry later."
            : error.message,
      });
    return;
  }
  const parserError = error as { type?: string };
  if (parserError?.type === "entity.too.large") {
    res
      .status(413)
      .json({
        error: "Request exceeds the 4 MB upload budget. Use smaller images.",
      });
    return;
  }
  if (parserError?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON body." });
    return;
  }
  console.error("Request failed", error);
  res
    .status(500)
    .json({ error: "Unexpected server error. Please retry later." });
};
