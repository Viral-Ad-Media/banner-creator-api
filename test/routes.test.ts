import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
process.env.GEMINI_API_KEY = "test";
const { supabaseAdmin } = await import("../src/db/supabase");
const { billingRouter } = await import("../src/routes/billing");
const { generationRouter, loadOwnedGeneration } =
  await import("../src/routes/generations");
const { ApiError, errorHandler } = await import("../src/middleware/error");
const { imageDataUrlSchema, bannerPlanSchema } =
  await import("../src/lib/validation");
const route = (router: any, path: string) =>
  router.stack.find((l: any) => l.route?.path === path).route.stack[0].handle;
test("checkout never invokes billing writes or grants entitlements", async () => {
  const original = supabaseAdmin.from;
  let writes = 0;
  (supabaseAdmin as any).from = () => {
    writes++;
    throw new Error("Unexpected write");
  };
  try {
    let failure: any;
    route(billingRouter, "/checkout-session")(
      { body: { plan: "ENTERPRISE" } },
      {},
      (e: any) => {
        failure = e;
      },
    );
    assert.equal(failure.statusCode, 501);
    assert.equal(writes, 0);
  } finally {
    supabaseAdmin.from = original;
  }
});
test("foreign generation IDs return 404 before provider calls", async () => {
  const original = supabaseAdmin.from;
  const filters: any[] = [];
  (supabaseAdmin as any).from = () => ({
    select() {
      return this;
    },
    eq(k: string, v: string) {
      filters.push([k, v]);
      return this;
    },
    async maybeSingle() {
      return { data: null, error: null };
    },
  });
  try {
    await assert.rejects(
      loadOwnedGeneration("owner", "foreign"),
      (e: any) => e.statusCode === 404,
    );
    assert.deepEqual(filters, [
      ["id", "foreign"],
      ["user_id", "owner"],
    ]);
  } finally {
    supabaseAdmin.from = original;
  }
});
test("video routes reject client-controlled operation names", async () => {
  let error: any;
  await route(generationRouter, "/video/status")(
    { auth: { userId: "owner" }, query: { operationName: "victim-job" } },
    {},
    (e: any) => {
      error = e;
    },
  );
  assert.equal(error.name, "ZodError");
});
test("validation, malformed JSON and oversized bodies return 4xx", () => {
  for (const [error, status] of [
    [imageDataUrlSchema.safeParse("bad").error, 400],
    [{ type: "entity.parse.failed" }, 400],
    [{ type: "entity.too.large" }, 413],
  ]) {
    let actual = 0;
    const res: any = {
      status(s: number) {
        actual = s;
        return this;
      },
      json() {},
    };
    errorHandler(error, {} as any, res, () => {});
    assert.equal(actual, status);
  }
});
test("request schemas reject unsafe image formats and malformed planner output", () => {
  assert.equal(
    imageDataUrlSchema.safeParse("data:image/svg+xml;base64,AAAA").success,
    false,
  );
  assert.equal(
    bannerPlanSchema.safeParse({ main_banner: { headline: "hi" } }).success,
    false,
  );
});

test("lost provider responses retain credits while confirmed rejection releases them", async () => {
  const { env } = await import("../src/config/env");
  env.OPENROUTER_API_KEY = "test";
  const originalRpc = supabaseAdmin.rpc;
  const originalFetch = globalThis.fetch;
  try {
    for (const [rejected, expected] of [
      [false, "UNKNOWN"],
      [true, "FAILED"],
    ] as const) {
      const statuses: string[] = [];
      (supabaseAdmin as any).rpc = async (name: string, args: any) => {
        if (name === "reserve_generation")
          return {
            data: {
              existing: false,
              generation: { id: "job", status: "QUEUED" },
            },
            error: null,
          };
        if (name === "finish_generation") {
          statuses.push(args.p_status);
          return { data: {}, error: null };
        }
        throw new Error("Unexpected RPC");
      };
      globalThis.fetch = (async () => {
        if (rejected)
          return new Response(JSON.stringify({ error: "Rejected input" }), {
            status: 400,
          });
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      let error: unknown;
      await route(generationRouter, "/plan")(
        {
          auth: { userId: "owner" },
          get: () => "36e05415-2b0b-4c48-afba-90e1935dc824",
          body: {
            userPrompt: "Summer campaign",
            aspectRatio: "1:1",
            textProvider: "openrouter",
          },
        },
        {},
        (e: unknown) => {
          error = e;
        },
      );
      assert.ok(error);
      assert.deepEqual(statuses, [expected]);
    }
  } finally {
    supabaseAdmin.rpc = originalRpc;
    globalThis.fetch = originalFetch;
  }
});

test("pending replay never dispatches or changes an existing reservation", async () => {
  const originalRpc = supabaseAdmin.rpc;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  const calls: string[] = [];
  (supabaseAdmin as any).rpc = async (name: string) => {
    calls.push(name);
    if (name === "reserve_generation")
      return {
        data: { existing: true, generation: { id: "job", status: "UNKNOWN" } },
        error: null,
      };
    if (name === "credit_summary") return { data: {}, error: null };
    throw new Error("Reservation changed during replay");
  };
  globalThis.fetch = (async () => {
    providerCalls++;
    throw new Error("Provider must not be called");
  }) as typeof fetch;
  try {
    let error: any;
    await route(generationRouter, "/plan")(
      {
        auth: { userId: "owner" },
        get: () => "36e05415-2b0b-4c48-afba-90e1935dc824",
        body: {
          userPrompt: "Summer campaign",
          aspectRatio: "1:1",
          textProvider: "openrouter",
        },
      },
      {},
      (e: unknown) => {
        error = e;
      },
    );
    assert.equal(error.statusCode, 409);
    assert.equal(providerCalls, 0);
    assert.deepEqual(calls, ["reserve_generation", "credit_summary"]);
  } finally {
    supabaseAdmin.rpc = originalRpc;
    globalThis.fetch = originalFetch;
  }
});

test("authentication service outages return 503 without rejecting valid sessions", async () => {
  const { requireAuth } = await import("../src/middleware/auth");
  const original = supabaseAdmin.auth.getUser;
  try {
    for (const [status, expected] of [
      [0, 503],
      [429, 503],
      [503, 503],
      [401, 401],
      [403, 401],
    ]) {
      (supabaseAdmin.auth as any).getUser = async () => ({
        data: { user: null },
        error: { status },
      });
      let error: any;
      await requireAuth(
        { headers: { authorization: "Bearer valid-token" } } as any,
        {} as any,
        (e) => {
          error = e;
        },
      );
      assert.equal(error.statusCode, expected);
    }
  } finally {
    supabaseAdmin.auth.getUser = original;
  }
});

test("terminal video jobs without provider output report their final status", async () => {
  const { reconcileVideo } = await import("../src/routes/generations");
  const failed = { id: "job", status: "FAILED", result: null };
  assert.equal(await reconcileVideo("owner", failed), failed);
  const original = supabaseAdmin.from;
  (supabaseAdmin as any).from = () => ({
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async maybeSingle() {
      return { data: { ...failed, type: "VIDEO_GENERATION" }, error: null };
    },
  });
  try {
    let body: any;
    await route(generationRouter, "/video/status")(
      {
        auth: { userId: "owner" },
        query: { generationId: "36e05415-2b0b-4c48-afba-90e1935dc824" },
      },
      {
        json: (value: any) => {
          body = value;
        },
      },
      (e) => {
        throw e;
      },
    );
    assert.equal(body.job.status, "FAILED");
    assert.equal(body.job.done, true);
  } finally {
    supabaseAdmin.from = original;
  }
});

test("video reconciliation preserves the persisted provider operation ID", async () => {
  const { env } = await import("../src/config/env");
  env.OPENROUTER_API_KEY = "test";
  const { reconcileVideo } = await import("../src/routes/generations");
  const originalFetch = globalThis.fetch;
  const originalRpc = supabaseAdmin.rpc;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: "completed" }));
  (supabaseAdmin as any).rpc = async (_name: string, args: any) => ({
    data: { status: args.p_status, result: args.p_result },
    error: null,
  });
  try {
    const result = await reconcileVideo("owner", {
      id: "job",
      status: "RUNNING",
      result: {
        job: { provider: "openrouter", operationName: "owned-operation" },
      },
    });
    assert.equal(result.result.job.operationName, "owned-operation");
    assert.equal(result.status, "SUCCESS");
  } finally {
    globalThis.fetch = originalFetch;
    supabaseAdmin.rpc = originalRpc;
  }
});

test("malformed provider plans are upstream errors and retain the dispatch reservation", async () => {
  const { env } = await import("../src/config/env");
  env.OPENROUTER_API_KEY = "test";
  const originalRpc = supabaseAdmin.rpc;
  const originalFetch = globalThis.fetch;
  const statuses: string[] = [];
  (supabaseAdmin as any).rpc = async (name: string, args: any) => {
    if (name === "reserve_generation")
      return {
        data: { existing: false, generation: { id: "job", status: "QUEUED" } },
        error: null,
      };
    if (name === "finish_generation") {
      statuses.push(args.p_status);
      return { data: {}, error: null };
    }
    throw new Error("Unexpected RPC");
  };
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: '{"main_banner": {"headline": "incomplete"}}' },
          },
        ],
      }),
    );
  try {
    let error: any;
    await route(generationRouter, "/plan")(
      {
        auth: { userId: "owner" },
        get: () => "36e05415-2b0b-4c48-afba-90e1935dc824",
        body: {
          userPrompt: "Summer campaign",
          aspectRatio: "1:1",
          textProvider: "openrouter",
        },
      },
      {},
      (e) => {
        error = e;
      },
    );
    assert.equal(error.statusCode, 502);
    assert.deepEqual(statuses, ["UNKNOWN"]);
  } finally {
    supabaseAdmin.rpc = originalRpc;
    globalThis.fetch = originalFetch;
  }
});
