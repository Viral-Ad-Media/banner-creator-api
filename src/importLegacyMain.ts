import "dotenv/config";
import { Pool } from "pg";
import { pool } from "./db/pool.js";
import { importLegacy } from "./importLegacy.js";
if (!process.env.SOURCE_DATABASE_URL)
  throw new Error(
    "Set SOURCE_DATABASE_URL to the old database's direct PostgreSQL URL.",
  );
const source = new Pool({
  connectionString: process.env.SOURCE_DATABASE_URL,
  max: 1,
});
try {
  await importLegacy(source, pool);
} finally {
  await source.end();
  await pool.end();
}
