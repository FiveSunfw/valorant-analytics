import { describe, expect, it } from "vitest";
import { promptRegistry } from "./registry.js";

describe("prompt registry", () => {
  it("returns versioned, hashed assets with an explicit tool allowlist", () => {
    const prompt = promptRegistry.get("agent.supervisor.system", "1.1.0");
    expect(prompt.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(prompt.allowedTools).toContain("get_player_summary");
    expect(prompt.allowedTools).toContain("compare_recent_periods");
    expect(prompt.budget.maxToolCalls).toBeGreaterThan(0);
  });

  it("does not resolve unregistered prompt versions", () => {
    expect(() => promptRegistry.get("agent.supervisor.system", "9.9.9")).toThrow();
  });
});
