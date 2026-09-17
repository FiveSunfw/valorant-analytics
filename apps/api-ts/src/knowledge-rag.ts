import { createHash } from "node:crypto";
import { enableKnowledgeRerank, jinaApiKey, jinaBaseUrl, jinaEmbeddingModel, jinaRerankModel, jinaTimeoutMs, knowledgeIndexVersion, localEmbeddingModel, localEmbeddingUrl, qdrantApiKey, qdrantCollection, qdrantTimeoutMs, qdrantUrl } from "./config.js";

export type KnowledgeFilters = { mapName?: string; side?: "attack" | "defense" };
export type HybridKnowledgeHit = { chunkId: string; score: number; path: "rrf" | "rrf_rerank" };
export type HybridKnowledgeResult = { hits: HybridKnowledgeHit[]; indexVersion: string; limitations: string[] };
export type KnowledgeRagSettings = {
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollection?: string;
  qdrantTimeoutMs?: number;
  jinaApiKey?: string;
  jinaBaseUrl?: string;
  jinaEmbeddingModel?: string;
  jinaRerankModel?: string;
  jinaTimeoutMs?: number;
  localEmbeddingUrl?: string;
  localEmbeddingModel?: string;
  rerankEnabled?: boolean;
  indexVersion?: string;
};

const aliases: Record<string, string> = {
  "隐士修所": "haven", "隐世修所": "haven", "亚海悬城": "ascent", "进攻方": "attack", "防守方": "defense", "爆弹": "execute"
};

export function normalizeKnowledgeQuery(value: string): string {
  let normalized = value.toLowerCase().trim();
  for (const [from, to] of Object.entries(aliases)) normalized = normalized.replaceAll(from, to);
  return normalized.replace(/\s+/g, " ");
}

/** Deterministic multilingual tokenizer: Latin terms plus CJK bigrams preserve map callouts and tactical abbreviations. */
export function sparseTokens(value: string): string[] {
  const text = normalizeKnowledgeQuery(value);
  const latin = text.match(/[a-z0-9_]+/g) ?? [];
  const cjk = [...text.replace(/[^\u4e00-\u9fff]/g, "")];
  const bigrams = cjk.length < 2 ? cjk : cjk.slice(0, -1).map((item, index) => item + cjk[index + 1]);
  return [...latin, ...bigrams];
}

function hashToken(token: string): number {
  const hex = createHash("sha256").update(token).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) >>> 0;
}
function sparseVector(value: string) {
  const counts = new Map<number, number>();
  for (const token of sparseTokens(value)) counts.set(hashToken(token), (counts.get(hashToken(token)) ?? 0) + 1);
  return { indices: [...counts.keys()], values: [...counts.values()] };
}

export class KnowledgeRagClient {
  private readonly qdrantUrl: string;
  private readonly qdrantApiKey: string;
  private readonly qdrantCollection: string;
  private readonly qdrantTimeoutMs: number;
  private readonly jinaApiKey: string;
  private readonly jinaBaseUrl: string;
  private readonly jinaEmbeddingModel: string;
  private readonly jinaRerankModel: string;
  private readonly jinaTimeoutMs: number;
  private readonly localEmbeddingUrl: string;
  private readonly localEmbeddingModel: string;
  private readonly rerankEnabled: boolean;
  private readonly indexVersion: string;
  readonly enabled: boolean;

  constructor(settings: KnowledgeRagSettings = {}) {
    this.qdrantUrl = settings.qdrantUrl ?? qdrantUrl;
    this.qdrantApiKey = settings.qdrantApiKey ?? qdrantApiKey;
    this.qdrantCollection = settings.qdrantCollection ?? qdrantCollection;
    this.qdrantTimeoutMs = settings.qdrantTimeoutMs ?? qdrantTimeoutMs;
    this.jinaApiKey = settings.jinaApiKey ?? jinaApiKey;
    this.jinaBaseUrl = settings.jinaBaseUrl ?? jinaBaseUrl;
    this.jinaEmbeddingModel = settings.jinaEmbeddingModel ?? jinaEmbeddingModel;
    this.jinaRerankModel = settings.jinaRerankModel ?? jinaRerankModel;
    this.jinaTimeoutMs = settings.jinaTimeoutMs ?? jinaTimeoutMs;
    this.localEmbeddingUrl = settings.localEmbeddingUrl ?? localEmbeddingUrl;
    this.localEmbeddingModel = settings.localEmbeddingModel ?? localEmbeddingModel;
    this.rerankEnabled = settings.rerankEnabled ?? enableKnowledgeRerank;
    this.indexVersion = settings.indexVersion ?? knowledgeIndexVersion;
    this.enabled = Boolean(this.qdrantUrl && (this.localEmbeddingUrl || this.jinaApiKey));
  }
  async search(query: string, filters: KnowledgeFilters, limit: number): Promise<HybridKnowledgeResult | undefined> {
    if (!this.enabled) return undefined;
    const limitations: string[] = [];
    try {
      const dense = await this.embedding(normalizeKnowledgeQuery(query), "retrieval.query");
      const must: unknown[] = [{ key: "reviewStatus", match: { value: "approved" } }, { key: "active", match: { value: true } }];
      if (filters.mapName) must.push({ key: "mapName", match: { value: filters.mapName } });
      if (filters.side) must.push({ key: "side", match: { value: filters.side } });
      const result = await this.qdrant(`/collections/${this.qdrantCollection}/points/query`, {
        prefetch: [
          { query: dense, using: "dense", filter: { must }, limit: 20, with_payload: true },
          { query: sparseVector(query), using: "bm25", filter: { must }, limit: 20, with_payload: true }
        ], query: { fusion: "rrf" }, limit: 20, with_payload: true
      });
      const points = (result as { result?: { points?: Array<{ id: string; score: number; payload?: { content?: string; title?: string } }> } }).result?.points ?? [];
      const candidates = points.map((point) => ({ chunkId: String(point.id), score: point.score, path: "rrf" as const, document: `${point.payload?.title ?? ""}\n${point.payload?.content ?? ""}` }));
      if (!this.rerankEnabled || !this.jinaApiKey) {
        limitations.push("Rerank disabled; returned fused dense and BM25 results.");
        return { hits: candidates.slice(0, limit).map(({ chunkId, score, path }) => ({ chunkId, score, path })), indexVersion: this.indexVersion, limitations };
      }
      try {
        const reranked = await this.rerank(query, candidates);
        return { hits: reranked.slice(0, limit), indexVersion: this.indexVersion, limitations };
      } catch {
        limitations.push("Rerank unavailable; returned fused dense and BM25 results.");
        return { hits: candidates.slice(0, limit).map(({ chunkId, score, path }) => ({ chunkId, score, path })), indexVersion: this.indexVersion, limitations };
      }
    } catch {
      return undefined;
    }
  }

  async index(chunk: { chunkId: string; content: string; title: string; mapName?: string; side?: string; topics: string[]; sourceId: string; assetId?: string }): Promise<void> {
    if (!this.enabled) throw new Error("Qdrant and Jina configuration is required for indexing");
    await this.ensureCollection();
    const vector = await this.embedding(`${chunk.title}\n${chunk.content}`, "retrieval.passage");
    await this.qdrant(`/collections/${this.qdrantCollection}/points?wait=true`, { points: [{ id: chunk.chunkId, vector: { dense: vector, bm25: sparseVector(`${chunk.title} ${chunk.content} ${chunk.topics.join(" ")}`) }, payload: { ...chunk, reviewStatus: "approved", active: true, indexVersion: this.indexVersion } }] }, "PUT");
  }

  private async ensureCollection(): Promise<void> {
    const url = `${this.qdrantUrl.replace(/\/$/, "")}/collections/${this.qdrantCollection}`;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.qdrantTimeoutMs);
    try {
      const response = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", ...(this.qdrantApiKey ? { "api-key": this.qdrantApiKey } : {}) }, body: JSON.stringify({ vectors: { dense: { size: 1024, distance: "Cosine" } }, sparse_vectors: { bm25: { modifier: "idf" } } }), signal: controller.signal });
      if (!response.ok && response.status !== 409) throw new Error(`Unable to create Qdrant collection: ${response.status}`);
    } finally { clearTimeout(timer); }
  }

  private async embedding(input: string, task: "retrieval.query" | "retrieval.passage"): Promise<number[]> {
    const data = this.localEmbeddingUrl
      ? await this.request(`${this.localEmbeddingUrl.replace(/\/$/, "")}/v1/embeddings`, { model: this.localEmbeddingModel, input: [input], task }, {}, this.jinaTimeoutMs)
      : await this.jina("/embeddings", { model: this.jinaEmbeddingModel, input: [input], task });
    const vector = (data as { data?: Array<{ embedding?: number[] }> }).data?.[0]?.embedding;
    if (!vector?.length) throw new Error("Embedding response did not contain a vector");
    return vector;
  }
  private async rerank(query: string, candidates: Array<HybridKnowledgeHit & { document: string }>): Promise<HybridKnowledgeHit[]> {
    const data = await this.jina("/rerank", { model: this.jinaRerankModel, query, documents: candidates.map((candidate) => candidate.document), top_n: candidates.length });
    const rows = (data as { results?: Array<{ index: number; relevance_score: number }> }).results ?? [];
    return rows.filter((row) => candidates[row.index]).map((row) => ({ chunkId: candidates[row.index].chunkId, score: row.relevance_score, path: "rrf_rerank" }));
  }
  private async jina(path: string, body: unknown): Promise<unknown> { return this.request(`${this.jinaBaseUrl}${path}`, body, { Authorization: `Bearer ${this.jinaApiKey}` }, this.jinaTimeoutMs); }
  private async qdrant(path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<unknown> { return this.request(`${this.qdrantUrl.replace(/\/$/, "")}${path}`, body, this.qdrantApiKey ? { "api-key": this.qdrantApiKey } : {}, this.qdrantTimeoutMs, method); }
  private async request(url: string, body: unknown, headers: Record<string, string>, timeoutMs = this.qdrantTimeoutMs, method: "POST" | "PUT" = "POST"): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw new Error(`Remote retrieval request failed: ${response.status} ${await response.text()}`);
      return response.json();
    }
    finally { clearTimeout(timer); }
  }
}
