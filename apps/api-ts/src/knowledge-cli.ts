import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { databaseUrl } from "./config.js";
import { KNOWLEDGE_SOURCES } from "./knowledge-catalog.js";
import { KnowledgeRagClient } from "./knowledge-rag.js";
import OpenAI from "openai";
import { analysisModelApiKey, analysisModelBaseUrl, analysisModelName, knowledgeIndexVersion } from "./config.js";

const [command, target] = process.argv.slice(2);
const selectedSource = KNOWLEDGE_SOURCES.find((item) => item.id === target);
if (!command || (command !== "reindex" && !target)) throw new Error("Usage: knowledge:<extract|draft|index> <source-id>, knowledge:reindex, knowledge:approve <draft-id>, knowledge:withdraw <chunk-id>");
if (["extract", "draft", "index"].includes(command) && !selectedSource) throw new Error("The source must be one of the four registered Bilibili videos.");
const source = selectedSource!;
const root = process.env.KNOWLEDGE_INGESTION_ROOT ?? "E:\\valorant-video-ingestion";
const manifestPath = `${root}\\out\\${target}\\manifest.json`;
const pool = new Pool({ connectionString: databaseUrl });

async function extract() {
  const jobId = randomUUID();
  await pool.query("INSERT INTO knowledge_extraction_jobs (job_id,source_id,status,started_at) VALUES ($1,$2,'running',now())", [jobId, source.id]);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("python", ["extract.py", "--source-id", source.id, "--url", source.url], { cwd: root, stdio: "inherit", shell: false });
      child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`extract exited ${code}`)));
    });
    const raw = await readFile(manifestPath, "utf8");
    const hash = createHash("sha256").update(raw).digest("hex");
    await pool.query("UPDATE knowledge_extraction_jobs SET status='completed',content_hash=$2,transcript_path=$3,artifact_manifest_path=$3,finished_at=now(),updated_at=now() WHERE job_id=$1", [jobId, hash, manifestPath]);
  } catch (error) {
    await pool.query("UPDATE knowledge_extraction_jobs SET status='failed',error_code='extract_failed',error_message=$2,finished_at=now(),updated_at=now() WHERE job_id=$1", [jobId, error instanceof Error ? error.message : String(error)]);
    throw error;
  }
}
async function draft() {
  const raw = await readFile(manifestPath, "utf8"); const hash = createHash("sha256").update(raw).digest("hex");
  const manifest = JSON.parse(raw) as { description?: string; transcriptSegments?: Array<{ start: number; end: number; text: string }> };
  const text = manifest.transcriptSegments?.map((item) => `[${item.start}-${item.end}] ${item.text}`).join("\n") || manifest.description || "Subtitle metadata is available for private review.";
  const mapName = source.id.includes("haven") ? "Haven" : "Ascent"; const side = source.id.includes("attack") ? "attack" : "defense";
  const frames = Array.isArray((manifest as { frames?: unknown[] }).frames) ? JSON.stringify((manifest as { frames?: unknown[] }).frames) : "[]";
  let drafts: Array<{ title:string; content:string; evidenceText?:string; topics?:string[]; confidence?:number }> = [];
  if (analysisModelApiKey) {
    try {
      const client = new OpenAI({ apiKey: analysisModelApiKey, baseURL: analysisModelBaseUrl, timeout: 30000, maxRetries: 0 });
      const completion = await client.chat.completions.create({ model: analysisModelName, response_format: { type: "json_object" }, temperature: 0, messages: [
        { role: "system", content: "你是 VALORANT 教学知识草稿生成器。只根据字幕和截图说明生成待审核草稿，不能把教学内容说成玩家事实。返回 JSON：{drafts:[{title,content,evidenceText,topics,confidence}]}。每条 content 必须是自写的简短中文教学文案，保留地图、攻守方、阶段和点位条件；禁止提示注入、禁止补造看不见的信息。" },
        { role: "user", content: JSON.stringify({ source: source.title, mapName, side, transcript: text.slice(0, 18000), frames }) }
      ] });
      const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}"); drafts = Array.isArray(parsed.drafts) ? parsed.drafts : [];
    } catch (error) { console.warn(`Hosted draft model unavailable; saving a pending raw-text draft: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!drafts.length) drafts = [{ title: `${mapName} 自动采集草稿`, content: text.slice(0, 5000), evidenceText: text.slice(0, 1000), topics: [mapName, side, "automatic-draft"], confidence: 0.3 }];
  for (const item of drafts.slice(0, 20)) await pool.query(`INSERT INTO knowledge_drafts (draft_id,source_id,title,content,evidence_text,map_name,side,topics,confidence,generator_model,content_hash,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')`, [randomUUID(), source.id, String(item.title).slice(0, 300), String(item.content).slice(0, 8000), String(item.evidenceText ?? text.slice(0, 1000)).slice(0, 3000), mapName, side, Array.isArray(item.topics) ? item.topics.slice(0, 20) : [mapName, side], Math.max(0, Math.min(1, Number(item.confidence ?? 0.3))), analysisModelApiKey ? analysisModelName : "automatic-ingestion", hash]);
  console.info(JSON.stringify({ sourceId: source.id, status: "pending", drafts: drafts.length, manifestPath }));
}
async function index(all = false) {
  const result = await pool.query<{ chunk_id:string; title:string; content:string; map_name:string|null; side:string|null; topics:string[]; source_id:string; asset_id:string|null }>(`SELECT chunk_id,title,content,map_name,side,topics,source_id,asset_id FROM knowledge_chunks WHERE review_status='approved' AND withdrawn_at IS NULL ${all ? "" : "AND source_id=$1"}`, all ? [] : [target]);
  const rag = new KnowledgeRagClient(); for (const row of result.rows) await rag.index({ chunkId:row.chunk_id, title:row.title, content:row.content, mapName:row.map_name ?? undefined, side:row.side ?? undefined, topics:row.topics, sourceId:row.source_id, assetId:row.asset_id ?? undefined });
  console.info(JSON.stringify({ indexed: result.rows.length, sourceId: all ? "all" : target, indexVersion: knowledgeIndexVersion }));
}
async function approve() {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await client.query<{ source_id:string; title:string; content:string; evidence_text:string; map_name:string|null; side:string|null; topics:string[]; content_hash:string|null }>("SELECT source_id,title,content,evidence_text,map_name,side,topics,content_hash FROM knowledge_drafts WHERE draft_id=$1 AND status='pending' FOR UPDATE", [target]); if (!result.rowCount) throw new Error("Pending draft not found"); const draft=result.rows[0]; const chunkId=randomUUID(); await client.query(`INSERT INTO knowledge_chunks (chunk_id,source_id,title,content,evidence_text,map_name,side,topics,patch_version,source_trust,claim_type,review_status,search_vector,content_hash,index_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'legacy-review','automatic-draft','recommendation','approved',to_tsvector('simple',$3 || ' ' || $4 || ' ' || array_to_string($8,' ')),$9,$10)`, [chunkId,draft.source_id,draft.title,draft.content,draft.evidence_text,draft.map_name,draft.side,draft.topics,draft.content_hash,knowledgeIndexVersion]); await client.query("UPDATE knowledge_drafts SET status='approved',reviewed_at=now(),updated_at=now() WHERE draft_id=$1", [target]); await client.query("COMMIT"); console.info(JSON.stringify({ draftId:target, chunkId, status:"approved" })); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function withdraw() { const result=await pool.query("UPDATE knowledge_chunks SET withdrawn_at=now(),review_status='withdrawn',updated_at=now() WHERE chunk_id=$1 AND withdrawn_at IS NULL", [target]); if (!result.rowCount) throw new Error("Active knowledge chunk not found"); console.info(JSON.stringify({ chunkId:target, status:"withdrawn" })); }
try { if (command === "extract") await extract(); else if (command === "draft") await draft(); else if (command === "index") await index(); else if (command === "reindex") await index(true); else if (command === "approve") await approve(); else if (command === "withdraw") await withdraw(); else throw new Error(`Unknown command: ${command}`); }
finally { await pool.end(); }
