import "dotenv/config";
import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth.js";
import { pool } from "./db/pool.js";
try {
  const migration = await getMigrations(auth.options);
  await migration.runMigrations();
  await pool.query(
    await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"),
  );
  console.log("Better Auth and application database schemas are ready.");
} finally {
  await pool.end();
}
