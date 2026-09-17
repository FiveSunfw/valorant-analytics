import { describe, expect, it, vi } from "vitest";
import { AnalyticsReader } from "./analytics-reader.js";
import type { KnowledgeRagClient } from "./knowledge-rag.js";

describe("knowledge retrieval flow", () => {
  it("uses hybrid IDs only to read approved current knowledge from PostgreSQL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      chunk_id: "chunk-a",
      source_id: "source-a",
      title: "Haven C点",
      content: "先清角再进点。",
      evidence_text: "C点入口",
      map_name: "haven",
      side: "defense",
      topics: ["C点", "架枪"],
      patch_version: "historic",
      source_trust: "reviewed",
      url: "https://www.bilibili.com/video/BV1tM4y1j7mE/"
    }] });
    const rag = { search: vi.fn().mockResolvedValue({
      hits: [{ chunkId: "chunk-a", score: 0.9, path: "rrf_rerank" }],
      indexVersion: "test-v1",
      limitations: []
    }) } as unknown as KnowledgeRagClient;

    const result = await new AnalyticsReader({ query } as any, rag).searchKnowledge("user-a", "隐世修所 防守", "haven", "defense", 5);

    expect(result.results[0]).toMatchObject({ chunkId: "chunk-a", mapName: "haven", sourceUrl: expect.stringContaining("bilibili.com") });
    expect(result.limitation).toContain("不是当前玩家比赛事实");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE c.chunk_id = ANY"), [["chunk-a"]]);
  });

  it("falls back to PostgreSQL when hybrid retrieval is unavailable", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const rag = { search: vi.fn().mockResolvedValue(undefined) } as unknown as KnowledgeRagClient;

    const result = await new AnalyticsReader({ query } as any, rag).searchKnowledge("user-a", "没有结果", undefined, undefined, 5);

    expect(result.results).toEqual([]);
    expect(result.limitation).toContain("PostgreSQL 全文降级检索");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
