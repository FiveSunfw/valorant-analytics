import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./config.js";
import { KNOWLEDGE_SOURCES } from "./knowledge-catalog.js";

const chunks = [
  ["bili-haven-defense", "Haven 防守：选位与信息责任", "防守教学围绕前期选位、信息获取和根据进攻方向做出响应展开。使用这条知识时，应把它作为地图通用原则，不能据此断言玩家在某个回合的具体站位。", "defense", ["Haven", "选位", "信息", "防守"]],
  ["bili-haven-attack", "Haven 进攻：战术执行与爆弹协同", "进攻教学覆盖前中期的常规进攻思路与爆弹执行。建议把玩家实际的首死、交换和回合结果作为事实，再用本条内容解释可能的协同原则。", "attack", ["Haven", "进攻", "爆弹", "执行"]],
  ["bili-ascent-defense", "Ascent 基础攻守：防守选位与地图节奏", "基础攻守教学用于建立地图前期的攻守框架。它是通用训练背景，不足以证明某位玩家在某回合执行或违反了某个站位原则。", "defense", ["Ascent", "地图理解", "防守", "选位"]],
  ["bili-ascent-attack", "Ascent 进阶进攻：进攻思路与战术执行", "进阶进攻教学用于解释进攻阶段的战术执行和团队协同。回答玩家问题时必须先引用其比赛指标或回合证据，再把这条内容作为可验证的训练方向。", "attack", ["Ascent", "进攻", "战术", "协同"]]
] as const;

if (process.env.NODE_ENV === "production") throw new Error("Knowledge seed is not intended for production");
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const source of KNOWLEDGE_SOURCES) await client.query(
    `INSERT INTO knowledge_sources (source_id,url,title,author,published_at,license_status,license_notes,game_version,status)
     VALUES ($1,$2,$3,'大东彦',$4,'licensed','User-confirmed permission covers screenshots; video and full transcript are not stored.','legacy-review','reviewed')
     ON CONFLICT (source_id) DO UPDATE SET title=EXCLUDED.title,license_status=EXCLUDED.license_status,license_notes=EXCLUDED.license_notes,status=EXCLUDED.status,updated_at=now()`,
    [source.id, source.url, source.title, source.published]
  );
  for (const [sourceId, title, content, side, topics] of chunks) await client.query(
    `INSERT INTO knowledge_chunks (chunk_id,source_id,title,content,evidence_text,map_name,side,topics,patch_version,source_trust,claim_type,review_status,search_vector)
     SELECT $1::uuid,$2::varchar,$3::text,$4::text,$4::text,$5::varchar,$6::varchar,$7::text[],'legacy-review','expert','recommendation','approved',to_tsvector('simple'::regconfig, $3::text || ' ' || $4::text || ' ' || $5::text || ' ' || array_to_string($7::text[],' '))
     WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunks WHERE source_id=$2::varchar AND title=$3::text)`,
    [randomUUID(), sourceId, title, content, sourceId.includes("haven") ? "Haven" : "Ascent", side, topics]
  );
  await client.query("COMMIT");
  console.info(JSON.stringify({ sources: KNOWLEDGE_SOURCES.length, chunks: chunks.length }));
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await pool.end(); }
