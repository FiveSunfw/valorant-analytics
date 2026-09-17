import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeRagClient, normalizeKnowledgeQuery, sparseTokens } from "./knowledge-rag.js";

const settings = {
  qdrantUrl: "http://qdrant.test",
  qdrantApiKey: "qdrant-key",
  qdrantCollection: "knowledge_test",
  jinaApiKey: "jina-key",
  jinaBaseUrl: "https://jina.test/v1",
  indexVersion: "test-v1",
  qdrantTimeoutMs: 1000,
  jinaTimeoutMs: 1000,
  rerankEnabled: true
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.restoreAllMocks());

describe("knowledge RAG", () => {
  it("normalizes map and side aliases and keeps multilingual sparse terms", () => {
    expect(normalizeKnowledgeQuery("隐世修所 防守方")).toBe("haven defense");
    expect(sparseTokens("Haven A点 架枪")).toEqual(expect.arrayContaining(["haven", "a", "点架", "架枪"]));
  });

  it("runs dense retrieval, Qdrant BM25/RRF fusion, and rerank", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/embeddings")) return jsonResponse({ data: [{ embedding: [0.1, 0.2] }] });
      if (url.includes("/points/query")) return jsonResponse({ result: { points: [
        { id: "chunk-a", score: 0.7, payload: { title: "A点", content: "先清角再进点" } },
        { id: "chunk-b", score: 0.6, payload: { title: "B点", content: "保留回防路线" } }
      ] } });
      if (url.endsWith("/rerank")) return jsonResponse({ results: [
        { index: 1, relevance_score: 0.98 },
        { index: 0, relevance_score: 0.81 }
      ] });
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await new KnowledgeRagClient(settings).search("隐世修所 防守", { mapName: "haven", side: "defense" }, 5);

    expect(result).toEqual({
      hits: [
        { chunkId: "chunk-b", score: 0.98, path: "rrf_rerank" },
        { chunkId: "chunk-a", score: 0.81, path: "rrf_rerank" }
      ],
      indexVersion: "test-v1",
      limitations: []
    });
    const query = calls.find((call) => call.url.includes("/points/query"));
    expect(query?.body.query).toEqual({ fusion: "rrf" });
    expect(query?.body.prefetch).toHaveLength(2);
    expect(query?.body.prefetch[0].using).toBe("dense");
    expect(query?.body.prefetch[1].using).toBe("bm25");
    expect(calls.find((call) => call.url.endsWith("/embeddings"))?.body.task).toBe("retrieval.query");
  });

  it("falls back to fused candidates when rerank is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/embeddings")) return jsonResponse({ data: [{ embedding: [0.1] }] });
      if (url.includes("/points/query")) return jsonResponse({ result: { points: [{ id: "chunk-a", score: 0.7, payload: {} }] } });
      if (url.endsWith("/rerank")) throw new Error("rerank timeout");
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await new KnowledgeRagClient(settings).search("haven", {}, 3);

    expect(result?.hits).toEqual([{ chunkId: "chunk-a", score: 0.7, path: "rrf" }]);
    expect(result?.limitations).toEqual(["Rerank unavailable; returned fused dense and BM25 results."]);
  });

  it("indexes passage embeddings with approved payload and sparse vector", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.includes("/collections/knowledge_test") && init?.method === "PUT") return jsonResponse({ result: true });
      if (url.endsWith("/embeddings")) return jsonResponse({ data: [{ embedding: [0.1, 0.2] }] });
      if (url.includes("/points?wait=true")) return jsonResponse({ result: true });
      throw new Error(`unexpected URL ${url}`);
    });

    await new KnowledgeRagClient(settings).index({
      chunkId: "chunk-a",
      title: "Haven C点",
      content: "防守方先架住入口，再根据信息回撤。",
      mapName: "haven",
      side: "defense",
      topics: ["C点", "架枪"],
      sourceId: "source-a"
    });

    const embedding = calls.find((call) => call.url.endsWith("/embeddings"));
    expect(embedding?.body.task).toBe("retrieval.passage");
    const write = calls.find((call) => call.url.includes("/points?wait=true"));
    expect(write?.body.points[0]).toMatchObject({
      id: "chunk-a",
      payload: { reviewStatus: "approved", active: true, indexVersion: "test-v1", sourceId: "source-a" }
    });
    expect(write?.body.points[0].vector.bm25.indices.length).toBeGreaterThan(0);
  });

  it("uses the local Qwen-compatible embedding endpoint without Jina", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/v1/embeddings")) return jsonResponse({ data: [{ embedding: [0.1, 0.2] }] });
      if (url.includes("/points?wait=true")) return jsonResponse({ result: true });
      if (url.includes("/collections/knowledge_test") && init?.method === "PUT") return jsonResponse({ result: true });
      throw new Error(`unexpected URL ${url}`);
    });

    const local = new KnowledgeRagClient({ ...settings, jinaApiKey: "", localEmbeddingUrl: "http://embed.test", rerankEnabled: false });
    await local.index({ chunkId: "chunk-local", title: "Ascent A点", content: "进攻方分配烟雾。", topics: ["A点"], sourceId: "source-local" });

    expect(calls.some((url) => url.startsWith("http://embed.test/v1/embeddings"))).toBe(true);
    expect(calls.some((url) => url.includes("jina.test"))).toBe(false);
  });
});
