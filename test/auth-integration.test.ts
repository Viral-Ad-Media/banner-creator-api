import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 55487 });
await server.start();
process.env.DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:55487/postgres";
process.env.BETTER_AUTH_SECRET =
  "test-secret-not-for-production-thirty-two-characters";
process.env.BETTER_AUTH_URL = "http://localhost:4000";
process.env.CORS_ORIGIN = "http://localhost:3000";
process.env.GEMINI_API_KEY = "test";
const { pool } = await import("../src/db/pool");
pool.options.max = 1; // PGlite exposes a single PostgreSQL connection.
const { auth } = await import("../src/auth");
const { getMigrations } = await import("better-auth/db/migration");
const { app } = await import("../src/app");
const http = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => http.once("listening", resolve));
const address = http.address() as { port: number };
const base = `http://127.0.0.1:${address.port}/api`;
let cookie = "";
const request = async (
  path: string,
  body?: unknown,
  ownCookie = cookie,
  origin = "http://localhost:3000",
) => {
  return fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: origin,
      ...(ownCookie ? { Cookie: ownCookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};
before(async () => {
  const migration = await getMigrations(auth.options);
  const sql = await migration.compileMigrations();
  // Keep a reviewed schema snapshot matching the pinned Better Auth version.
  if (process.env.WRITE_AUTH_SCHEMA === "1")
    await writeFile("db/auth-schema.sql", sql);
  await migration.runMigrations();
  await db.exec(
    (await readFile("db/schema.sql", "utf8")).replace(
      "create extension if not exists pgcrypto;",
      "",
    ),
  );
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
  await server.stop();
  await db.close();
});
test("legacy import preserves UUIDs, paid entitlements, projects and bcrypt passwords", async () => {
  const { Pool } = await import("pg");
  const { hash } = await import("bcryptjs");
  const { importLegacy } = await import("../src/importLegacy");
  const sourceDb = await PGlite.create();
  const sourceServer = new PGLiteSocketServer({
    db: sourceDb,
    host: "127.0.0.1",
    port: 55488,
  });
  await sourceServer.start();
  const sourcePool = new Pool({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:55488/postgres",
    max: 1,
  });
  const id = "9d40d188-d84b-4f80-b3c8-1df1de123aa1";
  try {
    await sourceDb.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key,email text,encrypted_password text,raw_user_meta_data jsonb,email_confirmed_at timestamptz,created_at timestamptz,updated_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      CREATE TABLE auth_user(id uuid primary key); INSERT INTO auth_user VALUES('${id}');`);
    await sourceDb.exec(await readFile("db/schema.sql", "utf8"));
    await sourceDb.query(
      `INSERT INTO auth.users VALUES($1,'legacy@example.test',$2,'{"name":"Legacy"}',now(),now(),now(),null,null)`,
      [id, await hash("legacy-password-123", 4)],
    );
    await sourceDb.query(
      "INSERT INTO app_users(id,email,name,plan) VALUES($1,'legacy@example.test','Legacy','PRO')",
      [id],
    );
    await sourceDb.query(
      "INSERT INTO projects(user_id,name,data) VALUES($1,'Imported project',$2)",
      [id, { saved: true }],
    );
    await importLegacy(sourcePool, pool);
    const login = await request(
      "/auth/session/sign-in/email",
      { email: "legacy@example.test", password: "legacy-password-123" },
      "",
    );
    assert.equal(login.status, 200, await login.clone().text());
    const legacyCookie = login.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const profile = await request("/auth/me", undefined, legacyCookie);
    const user = (await profile.json()).user;
    assert.equal(user.id, id);
    assert.equal(user.plan, "PRO");
    const projects = await request("/projects", undefined, legacyCookie);
    assert.equal((await projects.json()).projects[0].name, "Imported project");
    await assert.rejects(importLegacy(sourcePool, pool), /empty destination/);
    assert.equal(
      (await sourceDb.query<any>("SELECT count(*)::int n FROM app_users"))
        .rows[0].n,
      1,
    );
  } finally {
    await sourcePool.end();
    await sourceServer.stop();
    await sourceDb.close();
  }
});
test("signup, profile, paid-plan injection, cross-account ownership and session revocation", async () => {
  const signup = await request(
    "/auth/session/sign-up/email",
    {
      name: "Owner",
      email: "owner@example.test",
      password: "long-password-123",
      plan: "ENTERPRISE",
    },
    "",
  );
  assert.equal(signup.status, 200, await signup.text());
  cookie = signup.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  assert.match(cookie, /session_token=/);
  let response = await request("/auth/me");
  assert.equal(response.status, 200, await response.clone().text());
  const owner = (await response.json()).user;
  assert.equal(owner.plan, "FREE");
  const project = await request("/projects", {
    name: "Private project",
    data: { foo: "bar" },
  });
  assert.equal(project.status, 201, await project.clone().text());
  const id = (await project.json()).project.id;
  const other = await request(
    "/auth/session/sign-up/email",
    {
      name: "Other",
      email: "other@example.test",
      password: "long-password-456",
    },
    "",
  );
  assert.equal(other.status, 200, await other.clone().text());
  const otherCookie = other.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  response = await request(`/projects/${id}`, undefined, otherCookie);
  assert.equal(response.status, 404);
  const foreignOrigin = await request(
    "/auth/session/sign-in/email",
    { email: "owner@example.test", password: "long-password-123" },
    "",
    "https://evil.example",
  );
  assert.equal(foreignOrigin.status, 403);
  response = await request("/auth/session/sign-out", {});
  assert.equal(response.status, 200, await response.clone().text());
  response = await request("/auth/me");
  assert.equal(response.status, 401);
});
test("PostgreSQL query layer binds hostile text without executing it", async () => {
  const { database } = await import("../src/db/database");
  const r = await database
    .from("projects")
    .select("id")
    .eq("name", "'; DROP TABLE projects; --");
  assert.equal(r.error, null);
  assert.deepEqual(r.data, []);
  assert.throws(
    () => database.from("projects; DROP TABLE app_users"),
    /Unknown/,
  );
});

test("email password recovery resets credentials and revokes existing sessions", async () => {
  const { env } = await import("../src/config/env");
  const originalFetch = globalThis.fetch;
  const oldKey = env.RESEND_API_KEY, oldSender = env.AUTH_EMAIL_FROM;
  let resetUrl = "";
  env.RESEND_API_KEY = "test-mail-key";
  env.AUTH_EMAIL_FROM = "Banner Creator <test@example.test>";
  globalThis.fetch = (async (input: any, init: any) => {
    if (String(input) === "https://api.resend.com/emails") {
      resetUrl = JSON.parse(init.body).text.match(/https?:\/\/\S+/)[0];
      return new Response(JSON.stringify({id:"test-email"}),{status:200});
    }
    return originalFetch(input,init);
  }) as typeof fetch;
  try {
    const login = await request("/auth/session/sign-in/email",{email:"owner@example.test",password:"long-password-123"},"");
    assert.equal(login.status,200);
    const ownCookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const recovery=await request("/auth/session/request-password-reset",{email:"owner@example.test",redirectTo:"http://localhost:3000/auth?mode=reset"},"");
    assert.equal(recovery.status,200,await recovery.clone().text());
    assert.ok(resetUrl);
    const token=new URL(resetUrl).pathname.split('/').pop();
    const reset=await request("/auth/session/reset-password",{newPassword:"new-password-123",token},"");
    assert.equal(reset.status,200,await reset.clone().text());
    assert.equal((await request('/auth/me',undefined,ownCookie)).status,401);
    assert.equal((await request('/auth/session/sign-in/email',{email:"owner@example.test",password:"long-password-123"},"")).status,401);
    assert.equal((await request('/auth/session/sign-in/email',{email:"owner@example.test",password:"new-password-123"},"")).status,200);
  } finally { globalThis.fetch=originalFetch;env.RESEND_API_KEY=oldKey;env.AUTH_EMAIL_FROM=oldSender; }
});
