import { pool } from "./pool.js";
const tables = new Set([
  "app_users",
  "projects",
  "avatars",
  "generations",
  "usage_events",
  "billing_customers",
]);
const functions = new Set([
  "credit_summary",
  "reserve_generation",
  "finish_generation",
  "create_resource",
  "consume_rate_limit",
]);
const identifier = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name))
    throw new Error("Invalid database identifier");
  return `"${name}"`;
};
const columns = (fields: string) =>
  fields === "*"
    ? "*"
    : fields
        .split(",")
        .map((s) => identifier(s.trim()))
        .join(",");
const failure = (error: any) => ({
  data: null,
  error: { code: error.code, message: error.message },
});
// Internal server-only query API. Every value is bound, never interpolated into SQL.
class TableQuery implements PromiseLike<any> {
  private fields = "*";
  private filters: { key: string; value: unknown; many: boolean }[] = [];
  private sorting: string[] = [];
  private count?: number;
  private offset = 0;
  private values?: Record<string, unknown>;
  private remove = false;
  constructor(private table: string) {
    if (!tables.has(table)) throw new Error("Unknown application table");
  }
  select(fields = "*") {
    this.fields = fields;
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push({ key, value, many: false });
    return this;
  }
  in(key: string, value: unknown[]) {
    this.filters.push({ key, value, many: true });
    return this;
  }
  order(key: string, options: { ascending?: boolean } = {}) {
    this.sorting.push(
      identifier(key) + (options.ascending === false ? " DESC" : " ASC"),
    );
    return this;
  }
  limit(count: number) {
    this.count = count;
    return this;
  }
  range(start: number, end: number) {
    this.offset = start;
    this.count = end - start + 1;
    return this;
  }
  update(values: Record<string, unknown>) {
    this.values = values;
    return this;
  }
  delete() {
    this.remove = true;
    return this;
  }
  async single() {
    return this.execute(true, true);
  }
  async maybeSingle() {
    return this.execute(true, false);
  }
  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((v: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((r: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
  private async execute(single = false, required = false) {
    try {
      const args: unknown[] = [];
      const bind = (value: unknown) => {
        args.push(value);
        return `$${args.length}`;
      };
      const name = `public.${identifier(this.table)}`;
      let sql = this.remove
        ? `DELETE FROM ${name}`
        : this.values
          ? `UPDATE ${name} SET ${Object.entries(this.values)
              .map(([k, v]) => `${identifier(k)}=${bind(v)}`)
              .join(",")}`
          : `SELECT ${columns(this.fields)} FROM ${name}`;
      if ((this.remove || this.values) && !this.filters.length)
        throw new Error("Unscoped mutation refused");
      if (this.filters.length)
        sql +=
          " WHERE " +
          this.filters
            .map(
              (f) =>
                `${identifier(f.key)}${f.many ? ` = ANY(${bind(f.value)})` : ` = ${bind(f.value)}`}`,
            )
            .join(" AND ");
      if (this.remove || this.values)
        sql += ` RETURNING ${columns(this.fields)}`;
      else {
        if (this.sorting.length) sql += " ORDER BY " + this.sorting.join(",");
        if (this.count !== undefined) sql += ` LIMIT ${bind(this.count)}`;
        if (this.offset) sql += ` OFFSET ${bind(this.offset)}`;
      }
      const { rows } = await pool.query(sql, args);
      if (single && (rows.length > 1 || (required && rows.length !== 1)))
        return {
          data: null,
          error: { code: "P0002", message: "Resource not found" },
        };
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    } catch (error) {
      return failure(error);
    }
  }
}
export const database = {
  from: (table: string) => new TableQuery(table),
  async rpc(name: string, params: Record<string, unknown>) {
    if (!functions.has(name)) throw new Error("Unknown application function");
    try {
      const entries = Object.entries(params);
      const args = entries.map(([, v]) => v);
      const sql = `SELECT public.${identifier(name)}(${entries.map(([k], i) => `${identifier(k)} => $${i + 1}`).join(",")}) AS result`;
      const { rows } = await pool.query(sql, args);
      return { data: rows[0].result, error: null };
    } catch (error) {
      return failure(error);
    }
  },
};
