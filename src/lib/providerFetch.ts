import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/error.js";
const deadlines = new AsyncLocalStorage<number>();
export const withProviderDeadline = <T>(run: () => T): T =>
  deadlines.run(Date.now() + env.PROVIDER_TIMEOUT_MS, run);
export const remainingProviderTimeout = () => {
  const remaining =
    (deadlines.getStore() ?? Date.now() + env.PROVIDER_TIMEOUT_MS) - Date.now();
  if (remaining <= 0) throw new Error("Provider request timed out.");
  return remaining;
};
export const providerFetch = (url: string, options: RequestInit = {}) =>
  fetch(url, {
    ...options,
    signal: AbortSignal.timeout(remainingProviderTimeout()),
  });
export const downloadVideo = async (
  url: string,
  headers?: HeadersInit,
  allowedHost?: string,
) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new ApiError(502, "Invalid provider download URL.");
  // Never forward API credentials across redirects or to an untrusted host.
  if (headers && parsed.hostname !== allowedHost)
    throw new ApiError(502, "Invalid authenticated download host.");
  let current = parsed;
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await providerFetch(current.toString(), {
      headers,
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new ApiError(502, "Invalid provider redirect.");
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.username || next.password)
        throw new ApiError(502, "Invalid provider redirect.");
      headers = next.origin === current.origin ? headers : undefined;
      current = next;
      continue;
    }
    if (!response.ok)
      throw new ApiError(502, "Provider video download failed.");
    const MAX_BYTES = 4_000_000; // Fits common serverless response budgets; oversized output fails clearly.
    if (Number(response.headers.get("content-length") || 0) > MAX_BYTES) {
      await response.body?.cancel();
      throw new ApiError(
        413,
        "Video exceeds the 4 MB download limit. Use a shorter clip.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError(502, "Empty video response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES)
          throw new ApiError(
            413,
            "Video exceeds the 4 MB download limit. Use a shorter clip.",
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return { buffer: Buffer.concat(chunks), mimeType: "video/mp4" };
  }
  throw new ApiError(502, "Too many provider redirects.");
};
