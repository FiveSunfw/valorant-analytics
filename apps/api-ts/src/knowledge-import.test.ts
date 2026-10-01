import { describe, expect, it } from "vitest";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  TRANSCRIPT_TEMP_PREFIX,
  inspectVideoTranscript,
  parseJson3Subtitle,
  resolveKnowledgeSource,
  transcriptTempDirectoryTemplate
} from "./knowledge-import.js";

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

  it("builds the mkdtemp template with the platform separator under the system temp dir", () => {
    const template = transcriptTempDirectoryTemplate();
    // Regression guard for the Windows-only `\\` concatenation that produced
    // "/tmp\\valorant-knowledge-" on Linux and made mkdtemp fail with EACCES.
    // The template must be exactly node:path's join of the OS temp dir and the
    // prefix; a hard-coded backslash separator diverges from that on POSIX.
    expect(template).toBe(join(tmpdir(), TRANSCRIPT_TEMP_PREFIX));
    expect(isAbsolute(template)).toBe(true);
    expect(dirname(template)).toBe(tmpdir());
    expect(basename(template)).toBe(TRANSCRIPT_TEMP_PREFIX);
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

  it("creates the temporary subtitle directory inside the system temp dir", async () => {
    let observedDirectory = "";
    const result = await inspectVideoTranscript("bili-haven-defense", {
      runCommand: async (_file, args) => {
        // mkdtemp appends six random characters, so the process actually writes
        // into <prefix>XXXXXX. Record that real directory to prove the prefix is
        // rooted at the OS temp directory on every platform.
        observedDirectory = dirname(args[args.indexOf("--output") + 1]);
        await writeFile(`${args[args.indexOf("--output") + 1].replace("%(id)s", "fixture")}.json3`, JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "跨平台临时目录" }] }]
        }));
        return { stdout: "", stderr: "" };
      }
    });

    expect(result.ok).toBe(true);
    expect(observedDirectory).not.toBe("");
    // The directory is an absolute path directly under the OS temp dir.
    expect(isAbsolute(observedDirectory)).toBe(true);
    expect(dirname(observedDirectory)).toBe(tmpdir());
    // The final segment starts with the shared prefix followed by the six
    // random characters mkdtemp appends.
    const name = basename(observedDirectory);
    expect(name.startsWith(TRANSCRIPT_TEMP_PREFIX)).toBe(true);
    expect(name.length).toBe(TRANSCRIPT_TEMP_PREFIX.length + 6);
  });
});
