import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
process.env.GEMINI_API_KEY = "test";
const { downloadVideo, readProviderText } =
  await import("../src/lib/providerFetch");

test("oversized provider JSON is cancelled before parsing", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    readProviderText(response, 16),
    (e: any) => e.statusCode === 502,
  );
  assert.equal(cancelled, true);
});

test("redirects cancel bodies and never forward credentials across origins", async () => {
  const original = globalThis.fetch;
  const requests: any[] = [];
  let cancelled = false;
  globalThis.fetch = (async (url, options) => {
    requests.push({ url, headers: options?.headers });
    if (requests.length === 1)
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location: "https://cdn.example.test/clip" } },
      );
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  try {
    const result = await downloadVideo(
      "https://provider.example.test/clip",
      { "x-api-key": "secret" },
      "provider.example.test",
    );
    assert.equal(cancelled, true);
    assert.equal(requests[1].headers, undefined);
    assert.equal(result.buffer.length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider files above the declared limit are cancelled", async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": "5000000" } },
    )) as typeof fetch;
  try {
    await assert.rejects(
      downloadVideo("https://cdn.example.test/clip"),
      (e: any) => e.statusCode === 413,
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = original;
  }
});
