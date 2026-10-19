import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const user = randomUUID(),
  other = randomUUID();
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 insert into auth.users values('${user}'),('${other}');`);
  const schema = (
    await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8")
  ).replace("create extension if not exists pgcrypto;", "");
  await db.exec(schema);
  // Migration can be safely reapplied.
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/20261005_audit_hardening.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    `insert into app_users(id,name,email)values('${user}','A','a@example.test'),('${other}','B','b@example.test');`,
  );
});
after(() => db.close());
const reserve = async (
  uid: string,
  key = randomUUID(),
  kind = "IMAGE_GENERATION",
  hash = "same",
  project: string | null = null,
) => {
  const r = await db.query<any>(
    "select reserve_generation($1,$2,$3,$4,$5,$6,$7,$8) as r",
    [uid, key, hash, kind, "Audit prompt", "1:1", project, {}],
  );
  return r.rows[0].r;
};
test("client roles cannot change entitlements or invoke write RPCs", async () => {
  const r =
    await db.query<any>(`select has_table_privilege('authenticated','public.app_users','UPDATE') as can_update,
 has_table_privilege('anon','public.app_users','INSERT') as can_insert,
 has_function_privilege('authenticated','public.reserve_generation(uuid,uuid,text,text,text,text,uuid,jsonb)','EXECUTE') as can_rpc`);
  assert.deepEqual(r.rows[0], {
    can_update: false,
    can_insert: false,
    can_rpc: false,
  });
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${user}';`);
  try {
    await assert.rejects(
      db.query("update app_users set plan='ENTERPRISE' where id=$1", [user]),
      /permission denied/,
    );
  } finally {
    await db.exec("reset role");
  }
});
test("atomic reservations admit only 24 of 26 concurrent five-credit requests", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 26 }, () => reserve(user)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 24);
  const summary = await db.query<any>("select credit_summary($1) as s", [user]);
  assert.equal(summary.rows[0].s.remainingCredits, 0);
  assert.equal(summary.rows[0].s.reservedCredits, 120);
  // Failure releases a hold; success settles one and is idempotent.
  const id = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value.generation.id;
  await db.query("select finish_generation($1,$2,$3,$4,$5)", [
    user,
    id,
    "FAILED",
    null,
    null,
  ]);
  const next = await reserve(user);
  await db.query("select finish_generation($1,$2,$3,$4,$5)", [
    user,
    next.generation.id,
    "SUCCESS",
    { data: "ok" },
    null,
  ]);
  await db.query("select finish_generation($1,$2,$3,$4,$5)", [
    user,
    next.generation.id,
    "SUCCESS",
    { data: "ok" },
    null,
  ]);
  const count = await db.query<any>(
    "select count(*)::integer as n from usage_events where generation_id=$1",
    [next.generation.id],
  );
  assert.equal(count.rows[0].n, 1);
});
test("request replay does not reserve twice and changed input is rejected", async () => {
  const key = randomUUID();
  const first = await reserve(other, key);
  const second = await reserve(other, key);
  assert.equal(second.existing, true);
  assert.equal(first.generation.id, second.generation.id);
  await assert.rejects(
    reserve(other, key, "IMAGE_GENERATION", "changed"),
    /different input/,
  );
  await assert.rejects(reserve(other, key, "BANNER_PLAN"), /different input/);
});
test("cross-account projects are rejected before reservation and by trigger", async () => {
  const p = await db.query<any>(
    "select create_resource($1,'project',$2) as p",
    [other, { name: "Other project" }],
  );
  const id = p.rows[0].p.id;
  await assert.rejects(
    reserve(user, randomUUID(), "IMAGE_GENERATION", "same", id),
    /Project not found/,
  );
  await assert.rejects(
    db.query(
      "insert into generations(user_id,project_id,type,status,prompt) values($1,$2,'BANNER_PLAN','SUCCESS','bad')",
      [user, id],
    ),
    /Project not found/,
  );
});
test("quotas are enforced transactionally including concurrent inserts", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 7 }, () =>
      db.query("select create_resource($1,'project',$2)", [
        user,
        { name: "Project" },
      ]),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  const avatars = await Promise.allSettled(
    Array.from({ length: 14 }, () =>
      db.query("select create_resource($1,'avatar',$2)", [
        user,
        {
          name: "Avatar",
          imageDataUrl: "data:image/png;base64,AAAA",
          source: "upload",
        },
      ]),
    ),
  );
  assert.equal(avatars.filter((r) => r.status === "fulfilled").length, 12);
});
test("usage is aggregated in SQL beyond the Data API row cap", async () => {
  await db.query("update app_users set plan='ENTERPRISE' where id=$1", [other]);
  await db.query(
    "insert into usage_events(user_id,kind,credits) select $1,'VIDEO_GENERATION',25 from generate_series(1,2000)",
    [other],
  );
  const r = await db.query<any>("select credit_summary($1) as s", [other]);
  assert.equal(r.rows[0].s.usedCredits, 50000);
  assert.equal(r.rows[0].s.remainingCredits, 0);
});
test("shared rate buckets reject excess and recover after expiry", async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      db.query<any>("select consume_rate_limit('test',3,60) as ok"),
    ),
  );
  assert.equal(results.filter((r) => r.rows[0].ok).length, 3);
  await db.exec(
    "update rate_limit_buckets set reset_at=now()-interval '1 second'",
  );
  const r = await db.query<any>("select consume_rate_limit('test',3,60) as ok");
  assert.equal(r.rows[0].ok, true);
});

test("late settlement charges the original generation month", async () => {
  const previousMonth =
    "date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' - interval '1 month'";
  const uid = randomUUID();
  await db.query("insert into auth.users values($1)", [uid]);
  await db.query(
    "insert into app_users(id,name,email) values($1,'Late','late@example.test')",
    [uid],
  );
  const reservation = await reserve(uid);
  const id = reservation.generation.id;
  await db.query(
    `update generations set created_at=${previousMonth} where id=$1`,
    [id],
  );
  await db.query(
    `update credit_reservations set period_start=${previousMonth} where generation_id=$1`,
    [id],
  );
  await db.query("select finish_generation($1,$2,$3,$4,$5)", [
    uid,
    id,
    "SUCCESS",
    { data: "late" },
    null,
  ]);
  const summary = await db.query<any>("select credit_summary($1) as s", [uid]);
  assert.equal(summary.rows[0].s.usedCredits, 0);
  const usage = await db.query<any>(
    "select credits,created_at from usage_events where generation_id=$1",
    [id],
  );
  assert.equal(usage.rows[0].credits, 5);
  assert.ok(
    new Date(usage.rows[0].created_at).getTime() < Date.now() - 20 * 86400000,
  );
});
