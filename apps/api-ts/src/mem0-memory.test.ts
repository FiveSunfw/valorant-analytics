import { describe, expect, it } from "vitest";
import { Mem0MemoryProvider } from "./mem0-memory.js";

describe("Mem0MemoryProvider", () => {
  it("scopes semantic search to the internal current-user namespace", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new Mem0MemoryProvider("secret", "https://mem0.test", 2_000, async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ results: [{ id: "mem-1", memory: "优先练习 Haven 防守", metadata: { kind: "goal" } }] }), { status: 200 });
    });

    const result = await provider.search("valorant-analytics:user-1", "我的 Haven 训练目标", 5);

    expect(result).toEqual([{ providerMemoryId: "mem-1", content: "优先练习 Haven 防守", kind: "goal" }]);
    expect(calls[0].url).toBe("https://mem0.test/v1/memories/search");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: "我的 Haven 训练目标", filters: { user_id: "valorant-analytics:user-1" }, top_k: 5 });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Token secret");
  });

  it("writes metadata needed to reconcile Mem0 records with PostgreSQL", async () => {
    let body = "";
    const provider = new Mem0MemoryProvider("secret", "https://mem0.test", 2_000, async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ memory_id: "mem-2" }), { status: 201 });
    });

    await expect(provider.add({ userId: "valorant-analytics:user-1", memoryId: "local-1", kind: "summary", content: "本次重点练习首死", sourceRunId: "run-1" })).resolves.toBe("mem-2");
    expect(JSON.parse(body)).toMatchObject({ user_id: "valorant-analytics:user-1", memory: "本次重点练习首死", metadata: { local_memory_id: "local-1", kind: "summary", source_run_id: "run-1" } });
  });

  it("waits for asynchronous add events when the platform returns an event id", async () => {
    const urls: string[] = [];
    const provider = new Mem0MemoryProvider("secret", "https://mem0.test", 2_000, async (input) => {
      urls.push(String(input));
      return urls.length === 1
        ? new Response(JSON.stringify({ event_id: "event-1", status: "PENDING" }), { status: 202 })
        : new Response(JSON.stringify({ status: "SUCCEEDED", results: [{ id: "mem-async" }] }), { status: 200 });
    });

    await expect(provider.add({ userId: "valorant-analytics:user-1", memoryId: "local-1", kind: "goal", content: "练习经济决策" })).resolves.toBe("mem-async");
    expect(urls).toEqual(["https://mem0.test/v1/memories", "https://mem0.test/v1/event/event-1/"]);
  });

  it("supports deletion of one memory and the current user's complete namespace", async () => {
    const urls: string[] = [];
    const provider = new Mem0MemoryProvider("secret", "https://mem0.test", 2_000, async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 204 });
    });

    await provider.delete("mem/3");
    await provider.deleteAll("valorant-analytics:user-1");
    expect(urls).toEqual(["https://mem0.test/v1/memories/mem%2F3", "https://mem0.test/v2/entities/user/valorant-analytics%3Auser-1/"]);
  });
});
