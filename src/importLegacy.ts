import "dotenv/config";
import { Pool } from "pg";
// Offline only: a direct connection to the old PostgreSQL database. Never deployed as a route.
export async function importLegacy(source: Pool, destination: Pool) {
  const src = await source.connect();
  let dst;
  try {
    dst = await destination.connect();
  } catch (error) {
    src.release();
    throw error;
  }
  const tables = [
    "app_users",
    "projects",
    "avatars",
    "generations",
    "usage_events",
    "billing_customers",
    "credit_reservations",
  ] as const;
  try {
    await src.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await dst.query("BEGIN");
    await dst.query("LOCK TABLE auth_user IN ACCESS EXCLUSIVE MODE");
    const occupied = await dst.query(
      "SELECT count(*)::int AS n FROM auth_user",
    );
    if (occupied.rows[0].n)
      throw new Error(
        "Import requires an empty destination. Existing Neon users will not be merged or overwritten.",
      );
    const { rows: users } = await src.query(
      `SELECT id,email,encrypted_password,raw_user_meta_data,email_confirmed_at,created_at,updated_at,banned_until,deleted_at FROM auth.users`,
    );
    for (const u of users) {
      if (
        !u.email ||
        u.deleted_at ||
        (u.banned_until && new Date(u.banned_until) > new Date())
      )
        throw new Error(
          "Source contains an account needing manual review. No data imported.",
        );
      if (u.encrypted_password && !/^\$2[aby]\$/.test(u.encrypted_password))
        throw new Error("Unsupported legacy password hash. No data imported.");
      await dst.query(
        `INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6)`,
        [
          u.id,
          u.raw_user_meta_data?.name ?? u.email.split("@")[0],
          u.email,
          !!u.email_confirmed_at,
          u.created_at,
          u.updated_at ?? u.created_at,
        ],
      );
      if (u.encrypted_password)
        await dst.query(
          `INSERT INTO auth_account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES(gen_random_uuid(),$1::text,'credential',$1::uuid,$2,$3,$4)`,
          [
            u.id,
            u.encrypted_password,
            u.created_at,
            u.updated_at ?? u.created_at,
          ],
        );
    }
    for (const table of tables) {
      const exists = await src.query("SELECT to_regclass($1) AS t", [
        "public." + table,
      ]);
      if (!exists.rows[0].t) continue;
      // Only copy columns present in both schemas; target defaults supply new audit columns.
      const a = await src.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [table],
      );
      const b = await dst.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [table],
      );
      const target = new Set(b.rows.map((r) => r.column_name));
      const columns = a.rows
        .map((r) => r.column_name as string)
        .filter((c) => target.has(c));
      const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
      const fields = columns.map(quote).join(",");
      // Bounded reads within one consistent snapshot.
      let offset = 0;
      for (;;) {
        const rows = await src.query(
          `SELECT ${fields} FROM public.${quote(table)} ORDER BY ${quote(columns.includes("id") ? "id" : "generation_id")} LIMIT 100 OFFSET $1`,
          [offset],
        );
        for (const row of rows.rows)
          await dst.query(
            `INSERT INTO public.${quote(table)} (${fields}) VALUES(${columns.map((_, i) => "$" + (i + 1)).join(",")})`,
            columns.map((c) => row[c]),
          );
        if (rows.rows.length < 100) break;
        offset += 100;
      }
    }
    await dst.query(`UPDATE generations SET status='RUNNING'
    WHERE type='VIDEO_GENERATION' AND status='SUCCESS' AND request_key IS NULL
    AND result->'job'->>'status' IN ('PENDING','RUNNING')`);
    await dst.query("COMMIT");
    await src.query("ROLLBACK"); // Source is always read-only.
    console.log(
      "Imported accounts and application data. Existing browser sessions must sign in again.",
    );
  } catch (error) {
    await dst.query("ROLLBACK");
    await src.query("ROLLBACK");
    throw error;
  } finally {
    src.release();
    dst.release();
  }
}
