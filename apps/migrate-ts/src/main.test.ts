import { describe, expect, it } from "vitest";
import { migrate } from "./migration.js";

describe("migrate", () => {
  it("records an applied migration after executing its schema statements", async () => {
    const calls: string[] = [];
    const pool = { query: async (sql: string) => {
      calls.push(sql);
      return sql.startsWith("SELECT") ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [] };
    } };
    await migrate(pool);
    expect(calls[0]).toContain("schema_migrations");
    expect(calls.some((sql) => sql.includes("round_kills"))).toBe(true);
    expect(calls.some((sql) => sql.includes("agent_runs"))).toBe(true);
    expect(calls.findIndex((sql) => sql.includes("CREATE TABLE IF NOT EXISTS agent_runs"))).toBeLessThan(calls.findIndex((sql) => sql.includes("ALTER TABLE agent_runs ALTER COLUMN answer")));
    expect(calls.some((sql) => sql.includes("estimated_cost_usd"))).toBe(true);
    expect(calls.at(-1)).toContain("INSERT INTO schema_migrations");
  });
});
