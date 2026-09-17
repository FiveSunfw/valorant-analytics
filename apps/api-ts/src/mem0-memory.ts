import type { TrainingMemory } from "./analytics-reader.js";

export type MemoryProviderResult = {
  providerMemoryId: string;
  content: string;
  kind?: "goal" | "summary";
  sourceRunId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryProvider = {
  readonly name: "mem0" | "postgres";
  add(input: { userId: string; memoryId: string; kind: "goal" | "summary"; content: string; sourceRunId?: string }): Promise<string>;
  search(userId: string, query: string, limit: number): Promise<MemoryProviderResult[]>;
  delete(providerMemoryId: string): Promise<void>;
  deleteAll(userId: string): Promise<void>;
};

type Mem0Response = Record<string, unknown>;

/**
 * Small server-side adapter for Mem0 Platform. Keeping this as a fetch adapter
 * avoids coupling the API to an SDK release while retaining a local PostgreSQL
 * fallback when MEM0_API_KEY is not configured.
 */
export class Mem0MemoryProvider implements MemoryProvider {
  readonly name = "mem0" as const;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.mem0.ai",
    private readonly timeoutMs = 8_000,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async add(input: { userId: string; memoryId: string; kind: "goal" | "summary"; content: string; sourceRunId?: string }): Promise<string> {
    const response = await this.request("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        user_id: input.userId,
        memory: input.content,
        metadata: {
          app: "valorant-analytics",
          local_memory_id: input.memoryId,
          kind: input.kind,
          ...(input.sourceRunId ? { source_run_id: input.sourceRunId } : {})
        }
      })
    });
    const id = firstString(response, ["memory_id", "id"])
      ?? await this.resolveEventMemoryId(firstString(response, ["event_id"]));
    if (!id) throw new Error("Mem0 add response did not include a memory id");
    return id;
  }

  async search(userId: string, query: string, limit: number): Promise<MemoryProviderResult[]> {
    const response = await this.request("/v1/memories/search", {
      method: "POST",
      body: JSON.stringify({ query, filters: { user_id: userId }, top_k: limit })
    });
    const raw = Array.isArray(response.results) ? response.results : Array.isArray(response.data) ? response.data : [];
    return raw.flatMap((item) => this.toResult(item)).slice(0, limit);
  }

  async delete(providerMemoryId: string): Promise<void> {
    await this.request(`/v1/memories/${encodeURIComponent(providerMemoryId)}`, { method: "DELETE" });
  }

  async deleteAll(userId: string): Promise<void> {
    // Deleting the user entity is Mem0's documented cascade-delete operation.
    await this.request(`/v2/entities/user/${encodeURIComponent(userId)}/`, { method: "DELETE" });
  }

  private async request(path: string, init: RequestInit): Promise<Mem0Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {})
        }
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Mem0 request failed (${response.status}): ${body.slice(0, 300)}`);
      }
      if (response.status === 204) return {};
      const body = await response.json();
      return body && typeof body === "object" ? body as Mem0Response : {};
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveEventMemoryId(eventId: string | undefined): Promise<string | undefined> {
    if (!eventId) return undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const event = await this.request(`/v1/event/${encodeURIComponent(eventId)}/`, { method: "GET" });
      const status = firstString(event, ["status"]);
      const results = Array.isArray(event.results) ? event.results : [];
      const result = results.find((item) => item && typeof item === "object") as Mem0Response | undefined;
      const memoryId = result ? firstString(result, ["memory_id", "id"]) : undefined;
      if (memoryId) return memoryId;
      if (status === "FAILED") throw new Error(`Mem0 event ${eventId} failed`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Mem0 event ${eventId} did not complete in time`);
  }

  private toResult(value: unknown): MemoryProviderResult[] {
    if (!value || typeof value !== "object") return [];
    const item = value as Mem0Response;
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
    const providerMemoryId = firstString(item, ["id", "memory_id"]);
    const content = firstString(item, ["memory", "content"]);
    if (!providerMemoryId || !content) return [];
    const kind = metadata.kind === "goal" || metadata.kind === "summary" ? metadata.kind : undefined;
    const sourceRunId = typeof metadata.source_run_id === "string" ? metadata.source_run_id : undefined;
    return [{
      providerMemoryId,
      content,
      ...(kind ? { kind } : {}),
      ...(sourceRunId ? { sourceRunId } : {}),
      ...(typeof item.created_at === "string" ? { createdAt: item.created_at } : {}),
      ...(typeof item.updated_at === "string" ? { updatedAt: item.updated_at } : {})
    }];
  }
}

export function memoryProviderFromEnvironment(settings: {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
} = {}): MemoryProvider | undefined {
  const apiKey = settings.apiKey ?? process.env.MEM0_API_KEY ?? "";
  if (!apiKey || process.env.MEM0_ENABLED === "false") return undefined;
  return new Mem0MemoryProvider(
    apiKey,
    settings.baseUrl ?? process.env.MEM0_BASE_URL ?? "https://api.mem0.ai",
    settings.timeoutMs ?? Number(process.env.MEM0_TIMEOUT_MS ?? "8000")
  );
}

export function mapProviderResultToMemory(result: MemoryProviderResult, fallback: TrainingMemory): TrainingMemory {
  return {
    ...fallback,
    id: fallback.id,
    content: result.content,
    ...(result.kind ? { kind: result.kind } : {}),
    ...(result.sourceRunId ? { sourceRunId: result.sourceRunId } : {}),
    ...(result.createdAt ? { createdAt: result.createdAt } : {}),
    ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
    provider: "mem0",
    providerMemoryId: result.providerMemoryId
  };
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key] as string;
  return undefined;
}
