import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { databaseUrl } from "./config.js";
import { KNOWLEDGE_SOURCES } from "./knowledge-catalog.js";
import { KnowledgeRagClient } from "./knowledge-rag.js";

const [command, sourceId] = process.argv.slice(2);
const selectedSource = KNOWLEDGE_SOURCES.find((item) => item.id === sourceId);
if (!command || !sourceId || !selectedSource) throw new Error("Usage: knowledge:<extract|draft|index|reindex> <registered-source-id>");
const source = selectedSource;
const root = process.env.KNOWLEDGE_INGESTION_ROOT ?? "E:\\valorant-video-ingestion";
const manifestPath = `${root}\\out\\${sourceId}\\manifest.json`;
const pool = new Pool({ connectionString: databaseUrl });

async function extract() {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python", ["extract.py", "--source-id", source.id, "--url", source.url], { cwd: root, stdio: "inherit", shell: false });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`extract exited ${code}`)));
  });
}
async function draft() {
  const raw = await readFile(manifestPath, "utf8"); const hash = createHash("sha256").update(raw).digest("hex");
  const manifest = JSON.parse(raw) as { description?: string; transcriptSegments?: Array<{ start: number; end: number; text: string }> };
  const text = manifest.transcriptSegments?.map((item) => item.text).join(" ") || manifest.description || "Subtitle metadata is available for private review.";
  const mapName = source.id.includes("haven") ? "Haven" : "Ascent"; const side = source.id.includes("attack") ? "attack" : "defense";
  await pool.query(`INSERT INTO knowledge_drafts (draft_id,source_id,title,content,evidence_text,map_name,side,topics,confidence,generator_model,content_hash,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0.3,'automatic-ingestion',$9,'pending')
    ON CONFLICT DO NOTHING`, [randomUUID(), source.id, `${mapName} 自动采集草稿`, text.slice(0, 5000), text.slice(0, 1000), mapName, side, [mapName, side, "automatic-draft"], hash]);
  console.info(JSON.stringify({ sourceId, status: "pending", manifestPath }));
}
async function index(all = false) {
  const result = await pool.query<{ chunk_id:string; title:string; content:string; map_name:string|null; side:string|null; topics:string[]; source_id:string; asset_id:string|null }>(`SELECT chunk_id,title,content,map_name,side,topics,source_id,asset_id FROM knowledge_chunks WHERE review_status='approved' AND withdrawn_at IS NULL ${all ? "" : "AND source_id=$1"}`, all ? [] : [sourceId]);
  const rag = new KnowledgeRagClient(); for (const row of result.rows) await rag.index({ chunkId:row.chunk_id, title:row.title, content:row.content, mapName:row.map_name ?? undefined, side:row.side ?? undefined, topics:row.topics, sourceId:row.source_id, assetId:row.asset_id ?? undefined });
  console.info(JSON.stringify({ indexed: result.rows.length, sourceId: all ? "all" : sourceId }));
}
try { if (command === "extract") await extract(); else if (command === "draft") await draft(); else if (command === "index") await index(); else if (command === "reindex") await index(true); else throw new Error(`Unknown command: ${command}`); }
finally { await pool.end(); }
