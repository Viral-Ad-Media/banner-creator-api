import { Pool, types } from "pg";
import { env } from "../config/env.js";
// Keep the API's timestamp strings stable across the database migration.
types.setTypeParser(1184, (value) => new Date(value).toISOString());
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  statement_timeout: 30000,
});
pool.on("error", () => console.error("Idle PostgreSQL connection failed"));
