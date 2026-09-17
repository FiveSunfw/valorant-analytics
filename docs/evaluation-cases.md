# 评测与集成测试用例说明

本项目的测试不是只验证“接口返回 200”，而是验证 Agent 是否在正确的数据范围内选择工具、是否能回溯证据，以及异步基础设施是否保持幂等。集成测试默认跳过，只有在本地 PostgreSQL、Redis 和 RabbitMQ 已启动时才运行。

## Agent Eval 用例

`eval/cases.jsonl` 由 `npm run eval --workspace=@valorant/api` 执行。每个 case 都检查工具选择、输出 Schema、证据数组、置信度和拒答边界。

| Case | 为什么需要 | 主要验收 |
| --- | --- | --- |
| `summary` | 普通复盘是最短主路径，不能因为问题简单而跳过确定性数据工具 | 调用 `get_player_summary`，返回结构化指标和证据约束 |
| `first-death` / `empty-evidence` | 首死结论必须来自回合事件；没有事件时不能编造原因 | 同时读取汇总和回合证据，小样本降低置信度 |
| `attack-defense` / `map` | 攻守和地图问题需要专用聚合，地图问题还要能钻取到回合 | 验证最小工具集合和地图回合归因 |
| `trend` / `act-performance` / `time-window` | 趋势、Act 和显式时间窗口的分母不同，不能混用最近场次结果 | 验证时间边界、Act 分组和范围限制 |
| `agent-performance` / `economy-performance` | 英雄和经济决策属于独立维度，字段缺失时必须返回不可用限制 | 验证维度工具被问题路由调用，不用零值冒充 |
| `benchmark` / `benchmark-small-sample` | 同段位数据涉及隐私和样本门槛 | 仅在可用时引用去标识化聚合；样本不足时低置信度且不输出群体结论 |
| `training-memory` / `training-memory-empty` | 记忆是用户提供的上下文，不是比赛事实 | 只读取当前用户记忆，并要求 Agent 不把记忆写进 `playerEvidence` |
| `teaching-knowledge` | 地图教学只能在用户问到教学、点位或攻守方法时检索 | 调用 `search_knowledge`，将教学依据与玩家比赛证据分列 |
| `other-player` / `scouting` / `realtime` / `cheat` / `token` | 验证产品不可变的权限、安全和功能边界 | 不调用工具并返回受限范围说明 |
| `invalid` | 空问题不能消耗模型或工具配额 | 在入口拒绝，不创建无意义分析运行 |

## API 与分析集成测试

### `analytics-reader.integration.test.ts`

`returns only completed competitive data with concrete round evidence` 一次性构造真实数据库关系，原因是单元测试无法发现 JOIN、分母和用户边界错误。它验证：

- 只读取当前用户、已完成、竞技模式比赛；
- K/D、ADR、爆头率、KAST、首杀率和首死率的分母正确；
- 攻守、地图、Act、英雄和时间窗口使用同一批本人数据；
- 首死和首杀可以回溯到具体比赛/回合；
- 随机用户访问同一比赛时返回空结果，防止跨用户数据泄露。

### `agent-e2e.integration.test.ts`

`answers a first-death question through HTTP with PostgreSQL evidence` 通过 Fastify HTTP 入口运行确定性 Agent，而不是直接调用内部函数。原因是只有端到端路径才能同时验证会话用户、工具路由、输出 Schema、证据引用和 `agent_runs` Trace 是否一致。

### `app.test.ts` 与 OAuth 测试

这些用例覆盖未登录、跨用户资源、重复同步、队列不可用、训练记忆 CRUD、保存摘要必须绑定当前 Agent run、断开账号清理和 Demo/真实账号来源标识。它们对应产品的授权边界，不是普通业务 happy path。

## Worker 与消息队列集成测试

### `fixture-sync.integration.test.ts`

`filters non-competitive matches and persists evidence idempotently` 通过 RabbitMQ 发布同一任务两次，并同时放入竞技与非竞技比赛，原因是同步系统最容易在消息重复投递或过滤条件变化时产生脏数据。用例验证：

- 非竞技、非排位比赛不会落库；
- 同一个比赛 ID 重复消费不会重复插入；
- 比赛、回合、击杀、伤害和首死派生证据最终都可查询；
- Worker 消费完成后队列能排空。

`riot-match-client.test.ts` 覆盖 429、Retry-After、5xx 重试以及 401/403/404 不重试；原因是 Riot 网络错误必须分类处理，不能把授权失败无限重试。

## RAG 测试

### `knowledge-rag.test.ts`

- 多语言别名用例验证 Haven/Ascent 中文名、英文名、攻守方和中文战术词可以归一化；
- Dense + BM25 + RRF 用例验证 Qdrant 查询确实包含两路召回和 RRF 融合；
- Rerank 失败用例验证服务不可用时降级到融合候选，不阻断个人比赛分析；
- 本地 Qwen Embedding 用例验证本地索引不依赖 Jina 网络；
- 索引写入用例验证只写入 approved payload、版本和稀疏向量。

### `knowledge-flow.test.ts`

- 混合检索命中后仍回 PostgreSQL 读取 approved、未撤回、未过期知识，原因是 Qdrant 只负责召回，最终权限和审核状态必须由关系库确认；
- 混合服务不可用时降级 PostgreSQL 全文检索，保证本地或线上模型服务故障不会让已有分析功能整体不可用；
- 教学结果明确带有限制说明，防止 Agent 把教学内容当作玩家真实站位或操作证据。

## 结果记录

真实模型 Eval 的运行结果写入被忽略的 `eval/results/`，应记录通过率、失败类别、首轮成功率、重试次数、延迟、Token 和估算成本。当前测试重点是行为和权限回归；Recall@5、MRR、nDCG、P95 检索延迟的离线评测集属于后续 RAG 质量专项，不与 Agent 行为 Eval 混为一项指标。
