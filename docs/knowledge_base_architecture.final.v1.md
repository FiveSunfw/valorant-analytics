# VALORANT Analytics 知识库架构

- 版本：`1.0.0`
- 状态：最终基线
- 日期：2026-09-06
- 范围：AI 辅助多模态知识入库、审核、检索、引用和 Knowledge MCP

## 1. 目的和边界

知识库保存经过审核、版本化、可追溯来源的教练知识和游戏知识。它不是玩家比赛事实的来源。

```text
玩家事实：PostgreSQL + 确定性分析
通用知识：知识源 + 审核后的知识块 + 检索
个性化答案：玩家证据 + 知识证据 + 受限解释
```

知识库可以解释玩家事实，但不能制造玩家事实。审核后的 Lotus 教练资料可以解释孤立前压的通用风险；只有分析层才能确认某个玩家的首死率是否升高。

## 2. 来源和版权策略

支持的来源：

```text
官方文档和补丁说明
获得授权的文章
允许使用的创作者视频和转录
教练指南
获得许可的地图、战术图、截图和表格
```

每个来源必须保存：

```text
来源 URL 或本地路径
作者或发布者
发布日期
许可证或授权状态
游戏补丁或版本
内容 Hash
入库版本
审核状态
```

公开可访问不等于可以重新分发。优先保存元数据、抽取文本、Embedding、时间戳和来源链接。只有来源政策允许时才保存完整媒体。

来源生命周期：

```text
raw -> extracted -> reviewed -> indexed -> stale 或 rejected
```

只有 `reviewed` 内容才能进入生产检索索引。

## 3. 知识分类

```text
aim
  - 准星和基础机制
  - 移动和急停
  - 首发纪律
  - 武器练习

death_pattern
  - 首死
  - 孤立交火
  - 时机
  - 换人潜力
  - 过度前压

map
  - 地图布局
  - 点位职责
  - 默认站位
  - 进攻原则
  - 防守原则
  - 转点和时机

agent
  - 技能用途
  - 先手
  - 控点
  - 回防
  - 技能组合

economy
  - 购买规则
  - 存枪规则
  - 半起
  - 奖励局
  - 大招经济

round_decision
  - 开局计划
  - 中局调整
  - 下包后
  - 回防
  - 残局

training
  - 训练 Drill
  - 训练计划
  - 复盘流程
  - 可量化目标
```

元数据应支持按以下条件过滤：

```text
map, side, agent, role, weapon, patch_version,
rank_range, skill_level, source_type, trust_level
```

## 4. 知识单元契约

检索单元是带来源的原子知识块，不是随意固定长度的文本片段：

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

每个知识块只表达一个完整观点，并且必须能够定位到页码、段落、视频时间、表格或图片区域。

## 5. 多模态入库流程

```text
来源清单
  -> 获取获准的资源
  -> Hash 和元数据
  -> 解析
  -> 转录 / OCR / 关键帧
  -> AI 抽取候选知识
  -> 去重和冲突分析
  -> 人工审核
  -> 审核通过的知识块
  -> 关键词索引
  -> 可选向量索引
  -> Knowledge MCP
```

### 5.1 来源清单

使用显式 JSONL 清单，不要直接做无控制爬虫：

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

### 5.2 视频

Worker 负责：

```text
读取清单
  -> 检查来源政策
  -> 计算 SHA-256
  -> FFmpeg 提取音频
  -> 带时间戳转录
  -> 检测场景变化
  -> 抽取关键帧
  -> OCR 和视觉分析
  -> 生成候选知识块
  -> 进入人工审核队列
```

不要给整部视频做 Embedding，应保存带时间范围的片段：

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

### 5.3 图片

地图、示意图、截图和表格：

```text
图片
  -> OCR
  -> 视觉描述
  -> 地图和区域提取
  -> 尽可能生成边界框
  -> 来源和补丁元数据
  -> 人工审核
```

模型生成的描述和区域必须标记为 generated；审核前不能视为官方事实。

### 5.4 文档和文章

保留标题层级、段落、表格、图、页码、章节、阅读顺序和来源 URL。表格必须保留行列结构，不能简单压平成普通文本。

## 6. AI 辅助知识操作

AI 是抽取和审核助手，不是可以静默发布内容的权威来源。

AI 可以：

```text
转录
摘要
抽取原子声明
分类主题和声明类型
建议地图 / 攻守 / 英雄 / 补丁元数据
发现重复和冲突
生成审核用例
生成检索 Eval
```

确定性代码负责：

```text
资源下载和 Hash
任务编排
Schema 校验
状态流转
Embedding 和索引
过滤和访问控制
引用构造
```

人工审核负责：

```text
版权和来源信任
补丁有效性
含糊的战术结论
冲突建议
生产索引的最终批准
```

## 7. 版本化入库 Prompt

入库 Prompt 位于应用 Prompt Registry 中，并像代码一样版本化。最低限度包括：

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

每个 Prompt 必须请求准确 Schema、禁止无依据事实、保留来源位置、区分原文和生成字段、把歧义标为 `needs_review`，并在无法判断时返回机器可读错误而不是猜测。

## 8. 存储模型

推荐 PostgreSQL 表：

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

先使用 PostgreSQL 全文检索。只有当检索评测证明关键词和元数据检索不足时，才增加 `pgvector`。第一阶段不引入 Milvus 或 Qdrant。

## 9. 检索流程

知识检索采用混合方式：

```text
用户问题
  -> 查询和意图提取
  -> 地图 / 攻守 / 英雄 / 补丁过滤
  -> PostgreSQL 关键词检索
  -> 可选 pgvector 检索
  -> 候选合并和去重
  -> 重排序
  -> 有限证据包
  -> 专家或 Supervisor 综合
```

例：

```json
{
  "map": "Lotus",
  "side": "defense",
  "topics": ["first_death", "trade", "support"],
  "patchVersion": "12.05",
  "reviewStatus": "approved"
}
```

证据包必须包含知识块 ID、来源 ID、信任级别、补丁版本、正文、页码/时间戳/图片区域和限制。最终答案要把知识证据和玩家证据分开引用。

## 10. Knowledge MCP 接口

只暴露窄范围的只读工具：

```text
search_knowledge
get_knowledge_chunk
get_video_segment
get_image_evidence
get_patch_notes
get_map_guide
```

规则：不提供任意 SQL；结果必须有限且可分页；默认只返回审核通过内容；补丁过滤必须显式；每个结果包含来源和位置；外部证据标记为不可信数据；调用记录错误码、超时元数据和审计 Trace。

领域实现与内部 TypeScript 适配器共享，MCP 只是适配和治理边界，不复制业务逻辑。

## 11. 知识和玩家数据的组合

```text
玩家问题
  -> 认证玩家范围
  -> 确定性时间窗口和指标
  -> 检索通用原则
  -> 专家分析
  -> 证据校验
  -> 最终综合
```

示例：

```text
玩家证据：
- Lotus 防守首死率从 14% 升到 21%。
- 最近 4 次首死发生在可能无法换人的时机。

知识证据：
- 审核后的教练资料建议避免没有支援的早期孤立交火。

结论：
- 当前证据更支持早期交火时机问题，而不是纯枪法问题。

限制：
- Riot Match API 不提供完整移动、准星或弹道遥测。
```

知识只能提供背景和假设，不能证明玩家做过某个动作，除非玩家证据包含该事实。

## 12. 知识评测

必须评测：

```text
文本事实检索
地图和补丁过滤
视频时间戳引用
图片区域引用
表格和数值抽取
来源冲突
过期补丁处理
证据不足
无依据声明拒绝
来源内容中的 Prompt Injection
```

指标：

```text
retrieval recall@k
retrieval precision@k
引用有效性
来源支撑度
补丁正确性
无依据声明比例
答案有用性
延迟
Embedding 和重排成本
```

数值、补丁和战术正确性不能只依靠 LLM Judge，必须包含领域人工审核的黄金用例。

## 13. 初始垂直切片

先做小范围：

```text
一个地图：Lotus
三个主题：首死、防守、枪法
5-10 个获准视频
10 张审核后的图片或示意图
100-300 个审核通过的知识块
20 条知识库 Eval
PostgreSQL 全文检索
在基线评测后再考虑 pgvector
Knowledge MCP Server
```

验收问题：能否检索正确视频时间段、区分官方事实和社区建议、拒绝过期补丁、引用图片区域、结合玩家指标而不编造行为，并支持人工批准/修改/驳回和 fixture 回放。

## 14. 交付顺序

1. 定义来源清单、版权和信任字段。
2. 增加来源和资源表迁移。
3. 实现 RabbitMQ 入库任务。
4. 增加 FFmpeg 音频和关键帧适配器。
5. 增加转录和 OCR 适配器。
6. 增加版本化抽取和审核 Prompt。
7. 建立人工审核队列。
8. 保存带来源位置的审核知识块。
9. 实现关键词检索。
10. 运行检索和 grounding 基线评测。
11. 只有评测证明需要时才加入 Embedding 和 pgvector。
12. 实现重排和证据包。
13. 暴露 Knowledge MCP。
14. 接入 Supervisor 和专家 Agent。

## 15. 完成标准

知识库能够接收获准的视频或图片，保留来源元数据，生成带时间戳或页码的候选知识块，入库前要求审核，支持地图和补丁过滤检索，返回可查看证据，区分生成描述和来源事实，结合玩家指标，拒绝无依据或过期结论，并能用 fixture 回放入库和检索流程。
