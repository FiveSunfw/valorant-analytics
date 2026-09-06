# VALORANT Analytics Knowledge Base Architecture

- Version: `1.0.0`
- Status: Final baseline
- Date: 2026-09-06
- Scope: AI-assisted multimodal knowledge ingestion, review, retrieval, citations, and Knowledge MCP

## 1. Purpose and Boundary

The knowledge base contains reviewed, versioned, source-linked coaching and game knowledge. It is not the source of truth for a player's matches.

```text
Player facts:
  PostgreSQL + deterministic analytics

General knowledge:
  knowledge sources + reviewed chunks + retrieval

Personalized answer:
  player evidence + knowledge evidence + bounded interpretation
```

The knowledge base may explain a player fact, but it must not manufacture a player fact. For example, a reviewed Lotus coaching source can explain a general risk of an isolated early fight; only the analytics layer can establish whether a particular player had a high first-death rate.

## 2. Source and Rights Policy

Supported sources:

```text
official documentation and patch notes
licensed or permissioned articles
creator videos and transcripts permitted for use
coaching guides
maps, diagrams, screenshots, and tables with permitted use
```

Every source stores:

```text
source URL or local path
author or publisher
publication date
license or permission status
game patch or version if known
content hash
ingestion version
review status
```

Public availability does not imply redistribution rights. Prefer storing metadata, extracted text, embeddings, timestamps, and source links. Retain full media only when permitted by the source policy.

Source lifecycle:

```text
raw -> extracted -> reviewed -> indexed -> stale or rejected
```

Only `reviewed` content is searchable by production Agents.

## 3. Knowledge Taxonomy

```text
aim
  - crosshair and mechanics
  - movement and stopping
  - first-shot discipline
  - weapon practice

death_pattern
  - first death
  - isolated fight
  - timing
  - trade potential
  - overextension

map
  - layout
  - site responsibilities
  - default positions
  - attack principles
  - defense principles
  - rotation and timing

agent
  - ability purpose
  - initiation
  - site control
  - retake
  - utility combinations

economy
  - buy rules
  - save rules
  - half-buy
  - bonus round
  - ultimate economy

round_decision
  - opening plan
  - mid-round adaptation
  - post-plant
  - retake
  - clutch

training
  - drills
  - practice plans
  - review routines
  - measurable goals
```

Metadata filters should support:

```text
map
side
agent
role
weapon
patch_version
rank_range
skill_level
source_type
trust_level
```

## 4. Knowledge Unit Contract

The retrieval unit is a source-linked, atomic knowledge chunk rather than an arbitrary fixed-size slice:

```ts
export type KnowledgeChunk = {
  id: string;
  sourceId: string;
  assetId?: string;
  chunkType: "text" | "video_segment" | "image" | "table";
  title?: string;
  text: string;
  transcriptText?: string;
  ocrText?: string;
  visualSummary?: string;
  startSeconds?: number;
  endSeconds?: number;
  pageNumber?: number;
  imagePath?: string;
  imageRegion?: { x: number; y: number; width: number; height: number };
  map?: string;
  side?: "attack" | "defense";
  agent?: string;
  topics: string[];
  patchVersion?: string;
  sourceTrust: "official" | "expert" | "community" | "unknown";
  claimType: "fact" | "recommendation" | "opinion" | "speculation";
  generatedFields: string[];
  reviewStatus: "pending" | "approved" | "rejected";
  evidenceText: string;
  createdAt: string;
  updatedAt: string;
};
```

A chunk should express one coherent claim. It must be possible to cite it by page, paragraph, video timestamp, table, or image region.

## 5. Multimodal Ingestion Pipeline

```text
source manifest
  -> permitted asset acquisition
  -> hash and metadata
  -> parsing
  -> transcript / OCR / key frames
  -> AI candidate extraction
  -> duplicate and conflict analysis
  -> human review
  -> approved chunks
  -> keyword index
  -> optional vector index
  -> Knowledge MCP
```

### 5.1 Source Manifest

Start with an explicit JSONL manifest, not an uncontrolled crawler:

```json
{
  "sourceId": "lotus-guide-001",
  "url": "https://example.com/source",
  "title": "Lotus defense fundamentals",
  "sourceType": "video",
  "author": "creator",
  "license": "review-required",
  "gameVersion": "12.05",
  "trustLevel": "expert",
  "status": "raw"
}
```

### 5.2 Video

The ingestion Worker performs:

```text
read manifest
  -> verify source policy
  -> calculate SHA-256
  -> extract audio with FFmpeg
  -> transcribe with timestamps
  -> detect scene changes
  -> extract key frames
  -> run OCR and visual analysis
  -> create candidate chunks
  -> queue human review
```

Do not embed the entire video. Store bounded segments with source timestamps:

```json
{
  "sourceId": "lotus-guide-001",
  "startSeconds": 382,
  "endSeconds": 438,
  "text": "Do not take an isolated early fight on A Main without support.",
  "topics": ["Lotus", "defense", "first_death", "trade"],
  "claimType": "recommendation",
  "generatedFields": [],
  "reviewStatus": "pending"
}
```

### 5.3 Images

For maps, diagrams, screenshots, and tables:

```text
image
  -> OCR
  -> visual caption
  -> map and region extraction
  -> bounding boxes when possible
  -> source and patch metadata
  -> human review
```

Generated captions and detected regions must be marked as generated. They are not equivalent to official facts until reviewed.

### 5.4 Documents and Articles

Preserve heading hierarchy, paragraphs, tables, figures, page number, section, reading order, and source URL. A PDF table should retain row and column structure; flattening it into plain text is a known numeric-answer failure mode.

## 6. AI-Assisted Knowledge Operations

AI is an extraction and review assistant, not the authority that silently publishes content.

AI may:

```text
transcribe
summarize
extract atomic claims
classify topic and claim type
propose map / side / agent / patch metadata
identify duplicates and conflicts
generate review cases
generate retrieval eval cases
```

Deterministic code owns:

```text
asset download and hashing
job orchestration
schema validation
storage and status transitions
embedding and indexing
filtering and access control
citation construction
```

Human review owns:

```text
rights and source trust
patch validity
ambiguous tactical claims
conflicting advice
final approval for production indexing
```

## 7. Versioned Prompt Assets for Ingestion

Ingestion prompts live in the application prompt registry and are versioned like code. The minimum prompt set is:

```text
kb.source_normalize.v1
kb.transcript_extract.v1
kb.image_extract.v1
kb.document_extract.v1
kb.claim_review.v1
kb.deduplicate.v1
kb.conflict_resolve.v1
kb.metadata_enrich.v1
kb.embedding_text.v1
kb.retrieval_query.v1
kb.knowledge_answer.v1
kb.eval.judge.v1
```

Each prompt must:

- request the exact schema;
- prohibit unsupported facts;
- preserve source location;
- distinguish source text from generated fields;
- mark ambiguity as `needs_review`;
- include patch and source scope when available;
- return a machine-readable error rather than guessing.

## 8. Storage Model

Recommended PostgreSQL tables:

```text
knowledge_sources
  id, url, title, author, source_type, license, trust_level,
  game_version, published_at, content_hash, status

knowledge_assets
  id, source_id, asset_type, storage_path, mime_type,
  start_seconds, end_seconds, page_number, processing_version

knowledge_chunks
  id, source_id, asset_id, chunk_type, text, transcript_text,
  ocr_text, visual_summary, metadata_json, evidence_text,
  review_status, generated_fields, created_at, updated_at

knowledge_embeddings
  chunk_id, embedding_model, embedding_version, vector
```

Use PostgreSQL full-text search first. Add `pgvector` after retrieval evaluation proves that keyword and metadata search are insufficient. Do not introduce Milvus or Qdrant at the first vertical slice.

## 9. Retrieval Pipeline

Knowledge retrieval is hybrid:

```text
user question
  -> query and intent extraction
  -> map / side / agent / patch filters
  -> PostgreSQL keyword retrieval
  -> optional pgvector retrieval
  -> candidate merge and deduplication
  -> rerank
  -> bounded evidence pack
  -> specialist or Supervisor synthesis
```

Example filters:

```json
{
  "map": "Lotus",
  "side": "defense",
  "topics": ["first_death", "trade", "support"],
  "patchVersion": "12.05",
  "reviewStatus": "approved"
}
```

An evidence pack must include:

```text
chunk ID
source ID
source trust
patch version
text
page or timestamp or image region
limitations
```

Final answers cite knowledge evidence separately from player evidence.

## 10. Knowledge MCP Interface

The Knowledge MCP Server exposes narrow, read-only tools:

```text
search_knowledge
get_knowledge_chunk
get_video_segment
get_image_evidence
get_patch_notes
get_map_guide
```

Rules:

- no arbitrary SQL;
- bounded and paginated results;
- reviewed content only by default;
- explicit current-patch filtering;
- every result includes source and location metadata;
- external evidence is marked as untrusted data;
- all calls have stable error codes, timeout metadata, and audit trace.

The domain implementation is shared with internal TypeScript adapters. MCP is an adapter and governance boundary, not duplicate business logic.

## 11. Combining Knowledge with Player Data

```text
player question
  -> authenticated player scope
  -> deterministic period and metric selection
  -> knowledge retrieval for general principles
  -> specialist analysis
  -> evidence validator
  -> final synthesis
```

Example:

```text
Player evidence:
- Lotus defense first-death rate increased from 14% to 21%.
- Four recent first deaths occurred before likely trade support.

Knowledge evidence:
- Reviewed coaching sources recommend avoiding isolated early fights without support.

Conclusion:
- The observable evidence supports an early-fight timing hypothesis more strongly than a pure aim hypothesis.

Limitation:
- The Riot Match API does not provide complete movement, crosshair, or trajectory telemetry.
```

Knowledge provides context and hypotheses. It cannot prove that a player took a particular position or made a specific decision unless the player evidence contains that fact.

## 12. Knowledge Evaluation

The Eval suite must test:

```text
text fact retrieval
map and patch filtering
video timestamp citation
image region citation
table and numeric extraction
conflicting sources
stale patch handling
insufficient evidence
unsupported claim rejection
prompt injection inside source content
```

Metrics:

```text
retrieval recall@k
retrieval precision@k
citation validity
source grounding
patch correctness
unsupported-claim rate
answer usefulness
latency
embedding and rerank cost
```

LLM-as-Judge is insufficient for numeric, patch, and tactical correctness. Include human-reviewed golden cases.

## 13. Initial Vertical Slice

Start with:

```text
one map: Lotus
three topics: first death, defense, aim
5-10 permitted videos
10 reviewed images or diagrams
100-300 approved chunks
20 knowledge Eval cases
PostgreSQL full-text search
optional pgvector after baseline evaluation
Knowledge MCP Server
```

Acceptance questions:

- Can the system retrieve the correct video timestamp?
- Can it distinguish official fact from community advice?
- Can it reject an obsolete patch claim?
- Can it cite an image region?
- Can it combine player metrics with general knowledge without inventing a player action?
- Can a reviewer approve, revise, or reject a candidate?
- Can ingestion and retrieval be replayed from fixtures?

## 14. Delivery Order

1. Define source manifest, rights, and trust fields.
2. Add source and asset migrations.
3. Implement a RabbitMQ ingestion job.
4. Add FFmpeg audio and frame extraction adapters.
5. Add transcript and OCR adapters.
6. Add versioned extraction and review prompts.
7. Build the human review queue.
8. Store approved chunks with source locations.
9. Implement keyword retrieval.
10. Run baseline retrieval and grounding Evals.
11. Add embeddings and pgvector only if justified.
12. Implement reranking and evidence packs.
13. Expose Knowledge MCP.
14. Connect Supervisor and specialist agents.

## 15. Completion Criteria

The knowledge base is ready for product integration when it can ingest a permitted video or image, preserve source metadata, produce timestamped or page-linked candidates, require review before indexing, retrieve with map and patch filters, return inspectable evidence, separate generated descriptions from source facts, combine knowledge with player metrics, reject unsupported or stale claims, and replay ingestion and retrieval using fixtures.