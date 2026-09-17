import { describe, expect, it } from "vitest";
import { AnalyticsReader } from "./analytics-reader.js";
import type { MemoryProvider } from "./mem0-memory.js";

describe("AnalyticsReader", () => {
  it("does not expose a PUUID-based query", () => {
    expect(Object.getOwnPropertyNames(AnalyticsReader.prototype)).not.toContain("getByPuuid");
  });

  it("uses Mem0 for query-based memory recall while reconciling results to local rows", async () => {
    const provider: MemoryProvider = {
      name: "mem0",
      add: async () => "mem-1",
      search: async (userId, query, limit) => {
        expect(userId).toBe("valorant-analytics:user-1");
        expect(query).toBe("Haven训练目标");
        expect(limit).toBe(10);
        return [{ providerMemoryId: "mem-1", content: "继续练习 Haven 防守首死", kind: "goal" }];
      },
      delete: async () => undefined,
      deleteAll: async () => undefined
    };
    const pool = {
      query: async (sql: string) => {
        if (sql.startsWith("SELECT id, kind, content")) return { rows: [{ id: "local-1", kind: "goal", content: "旧内容", source_run_id: null, provider: "mem0", provider_memory_id: "mem-1", created_at: "2030-01-01T00:00:00.000Z", updated_at: "2030-01-01T00:00:00.000Z" }], rowCount: 1 };
        throw new Error(`unexpected SQL: ${sql}`);
      }
    } as never;
    const result = await new AnalyticsReader(pool, undefined, provider).getTrainingMemory("user-1", "Haven训练目标");
    expect(result.memories).toMatchObject([{ id: "local-1", content: "继续练习 Haven 防守首死", provider: "mem0", providerMemoryId: "mem-1" }]);
  });
});
