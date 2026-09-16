import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecFileOptions } from "node:child_process";
import { KNOWLEDGE_SOURCES, type KnowledgeSource } from "./knowledge-catalog.js";

const execFileAsync = promisify(execFile);
const SUBTITLE_LANGUAGES = "ai-zh,zh-Hans,zh-CN";
const COMMAND_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BUFFER = 4 * 1024 * 1024;

export type TranscriptImportFailureCode =
  | "source_not_allowed"
  | "yt_dlp_unavailable"
  | "subtitle_unavailable"
  | "command_failed"
  | "invalid_subtitle";

export interface TranscriptSegment {
  startSeconds: number;
  durationSeconds: number;
  text: string;
}

export interface TranscriptImportSuccess {
  ok: true;
  source: KnowledgeSource;
  segments: TranscriptSegment[];
  notice: string;
}

export interface TranscriptImportFailure {
  ok: false;
  code: TranscriptImportFailureCode;
  message: string;
  sourceId?: string;
}

export type TranscriptImportResult = TranscriptImportSuccess | TranscriptImportFailure;

type RunCommand = (
  file: string,
  args: string[],
  options: ExecFileOptions
) => Promise<{ stdout: string; stderr: string }>;

const runCommand: RunCommand = async (file, args, options) => {
  const result = await execFileAsync(file, args, options);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export function resolveKnowledgeSource(sourceIdOrUrl: string): KnowledgeSource | undefined {
  const value = sourceIdOrUrl.trim();
  return KNOWLEDGE_SOURCES.find((source) => source.id === value || source.url === value);
}

export function parseJson3Subtitle(input: string): TranscriptSegment[] {
  const document = JSON.parse(input) as {
    events?: Array<{
      tStartMs?: number;
      dDurationMs?: number;
      segs?: Array<{ utf8?: string }>;
    }>;
  };

  if (!Array.isArray(document.events)) throw new Error("Subtitle JSON does not contain events");
  return document.events.flatMap((event) => {
    if (typeof event.tStartMs !== "number" || !Array.isArray(event.segs)) return [];
    const text = event.segs.map((segment) => segment.utf8 ?? "").join("").trim();
    if (!text) return [];
    return [{
      startSeconds: Math.max(0, event.tStartMs / 1000),
      durationSeconds: Math.max(0, (event.dDurationMs ?? 0) / 1000),
      text
    }];
  });
}

function errorDetails(error: unknown): { code?: string; stderr: string; message: string } {
  if (typeof error !== "object" || error === null) return { stderr: "", message: String(error) };
  const record = error as { code?: unknown; stderr?: unknown; message?: unknown };
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    message: typeof record.message === "string" ? record.message : String(error)
  };
}

function classifyCommandFailure(error: unknown): TranscriptImportFailure {
  const details = errorDetails(error);
  if (details.code === "ENOENT") {
    return {
      ok: false,
      code: "yt_dlp_unavailable",
      message: "未找到 yt-dlp。请先安装 yt-dlp，再重新运行字幕检查；本工具不会自动下载视频或读取浏览器 Cookie。"
    };
  }
  if (/subtitle|subtitles|requested format|没有字幕|字幕/i.test(details.stderr)) {
    return {
      ok: false,
      code: "subtitle_unavailable",
      message: "该视频没有可直接读取的 Bilibili AI 字幕；请编辑人员在浏览器中人工核对并编写知识点。"
    };
  }
  return {
    ok: false,
    code: "command_failed",
    message: `yt-dlp 执行失败：${details.message}`
  };
}

/**
 * Reads an existing Bilibili subtitle track into memory for editor review.
 * It deliberately never downloads the video, accepts cookies, or writes the
 * transcript to PostgreSQL. Only approved, self-written chunks belong in the KB.
 */
export async function inspectVideoTranscript(
  sourceIdOrUrl: string,
  dependencies: { runCommand?: RunCommand } = {}
): Promise<TranscriptImportResult> {
  const source = resolveKnowledgeSource(sourceIdOrUrl);
  if (!source) {
    return {
      ok: false,
      code: "source_not_allowed",
      message: "只允许检查知识库登记的四条视频，不能传入任意外部 URL。"
    };
  }

  const directory = await mkdtemp(`${tmpdir()}\\valorant-knowledge-`);
  try {
    const outputTemplate = resolve(directory, "%(id)s");
    let commandFailure: TranscriptImportFailure | undefined;
    try {
      await (dependencies.runCommand ?? runCommand)("yt-dlp", [
        "--ignore-config",
        "--no-playlist",
        "--skip-download",
        "--write-auto-subs",
        "--sub-langs",
        SUBTITLE_LANGUAGES,
        "--sub-format",
        "json3",
        "--output",
        outputTemplate,
        "--no-warnings",
        source.url
      ], {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BUFFER,
        windowsHide: true
      });
    } catch (error) {
      commandFailure = classifyCommandFailure(error);
    }

    const subtitleFiles = (await readdir(directory)).filter((file) => file.endsWith(".json3"));
    if (subtitleFiles.length === 0) {
      return commandFailure ?? {
        ok: false,
        code: "subtitle_unavailable",
        sourceId: source.id,
        message: "没有发现可直接读取的 Bilibili AI 字幕；请人工观看视频并编写经审核的知识点。"
      };
    }

    let segments: TranscriptSegment[];
    try {
      segments = parseJson3Subtitle(await readFile(resolve(directory, subtitleFiles[0]), "utf8"));
    } catch (error) {
      return {
        ok: false,
        code: "invalid_subtitle",
        sourceId: source.id,
        message: `字幕文件无法解析：${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (segments.length === 0) {
      return {
        ok: false,
        code: "invalid_subtitle",
        sourceId: source.id,
        message: "字幕文件为空，未生成可供编辑核对的时间轴文本。"
      };
    }
    return {
      ok: true,
      source,
      segments,
      notice: "字幕只在本次进程内使用；请人工核对后保存自写知识点，截图是主要审核证据，时间戳可选，原始视频和完整转录不会写入知识库。"
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error(`用法：npm run knowledge:inspect --workspace=@valorant/api -- <source-id|registered-url>`);
    process.exitCode = 2;
    return;
  }
  const result = await inspectVideoTranscript(input);
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    source: result.source,
    segmentCount: result.segments.length,
    segments: result.segments,
    notice: result.notice,
    file: basename(result.source.url)
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
