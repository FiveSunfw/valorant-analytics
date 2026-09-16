import { describe, expect, it } from "vitest";
import { access, writeFile } from "node:fs/promises";
import { inspectVideoTranscript, parseJson3Subtitle, resolveKnowledgeSource } from "./knowledge-import.js";

describe("knowledge video importer", () => {
  it("only resolves registered Bilibili sources", () => {
    expect(resolveKnowledgeSource("bili-haven-defense")?.url).toContain("BV1tM4y1j7mE");
    expect(resolveKnowledgeSource("https://example.com/video")).toBeUndefined();
  });

  it("parses timestamped json3 subtitle events without persisting them", () => {
    const segments = parseJson3Subtitle(JSON.stringify({
      events: [
        { tStartMs: 1250, dDurationMs: 2100, segs: [{ utf8: "先拿信息" }, { utf8: "再执行" }] },
        { tStartMs: 4000, dDurationMs: 500, segs: [{ utf8: "  " }] },
        { tStartMs: 6000, segs: [{ utf8: "回合复盘" }] }
      ]
    }));
    expect(segments).toEqual([
      { startSeconds: 1.25, durationSeconds: 2.1, text: "先拿信息再执行" },
      { startSeconds: 6, durationSeconds: 0, text: "回合复盘" }
    ]);
  });

  it("rejects malformed subtitle documents", () => {
    expect(() => parseJson3Subtitle(JSON.stringify({ events: "not-an-array" }))).toThrow("events");
  });

  it("keeps the extracted subtitle temporary and never stores the transcript", async () => {
    let subtitlePath = "";
    const result = await inspectVideoTranscript("bili-haven-defense", {
      runCommand: async (_file, args) => {
        subtitlePath = `${args[args.indexOf("--output") + 1].replace("%(id)s", "fixture")}.json3`;
        await writeFile(subtitlePath, JSON.stringify({
          events: [{ tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: "人工核对这一句" }] }]
        }));
        return { stdout: "", stderr: "" };
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.segments[0].text).toBe("人工核对这一句");
    await expect(access(subtitlePath)).rejects.toThrow();
  });
});
