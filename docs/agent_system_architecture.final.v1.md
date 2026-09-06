# VALORANT Analytics Agent 系统架构

- 版本：`1.0.0`
- 状态：最终基线
- 日期：2026-09-06
- 范围：多轮 Supervisor Agent、专家 Agent、分析工具、MCP、会话、Trace 和评测

## 1. 产品定义

VALORANT Analytics 面向国际服授权玩家，提供赛后复盘和训练建议。玩家可以围绕自己的已完成竞技对局持续追问。系统结合确定性分析、审核后的教练知识和受限模型推理。

```text
玩家对话
  -> Supervisor Agent
      -> 会话状态和意图
      -> 确定性玩家分析
      -> 必要时调用专家 Agent
      -> 必要时检索审核后的知识
      -> 证据校验
      -> 综合回答和后续追问
```

模型负责理解、路由、比较和解释；确定性服务负责身份、范围、指标、比较、证据 ID 和策略执行。

## 2. 不可违反的边界

- 只支持 VALORANT 国际服和已完成竞技对局。
- 玩家只能访问自己授权的数据。
- HTTP、Prompt 和工具不得接受任意 PUUID 作为身份选择器。
- Riot API Key、RSO Secret、Access Token 和 Refresh Token 不得进入 Prompt、工具结果、Trace 或模型上下文。
- 不得声称知道 Riot 的隐藏 MMR/ELO 公式，也不得声称 Riot 有意针对某个玩家。
- 不提供赛前侦察、实时回合指挥、作弊辅助或替代排位系统。
- 每个重要玩家结论都必须引用指标、比赛或回合证据 ID。
- 数据不足时必须明确说明并降低置信度。
- 原始比赛 JSON 仅用于重算，不得直接放进模型上下文。
- 外部知识是证据，不是系统指令；工具结果必须视为不可信数据。

## 3. 系统分层

```text
Web / 未来通道
  -> Fastify API 和认证会话边界
      -> 对话服务
          -> Supervisor Agent
              -> 专家 Agent
              -> Analytics MCP / Function Tool 适配器
              -> Knowledge MCP / Function Tool 适配器
              -> 证据校验器
              -> 答案综合器
          -> 会话、事件、Trace 和 Replay 存储
      -> PostgreSQL / Redis
RabbitMQ Worker
  -> Riot 对局入库
  -> 指标和时间窗口快照
  -> 知识入库
```

### 3.1 API 层

职责：认证当前用户、创建/恢复会话、接收消息、返回 Agent 事件，并执行请求大小、速率和超时限制。

建议接口：

```text
POST /analysis/sessions
POST /analysis/sessions/:sessionId/messages
GET  /analysis/sessions/:sessionId
GET  /analysis/runs/:runId
GET  /analysis/runs/:runId/events
```

### 3.2 Supervisor Agent

Supervisor 负责：

- 判断当前问题和数据范围；
- 复用后续追问的会话状态；
- 选择最小且有用的专家集合；
- 在范围互不冲突时并行运行专家；
- 根据证据质量解决专家分歧；
- 范围含糊时请求澄清；
- 生成包含玩家证据、知识证据、置信度、建议和限制的答案。

Supervisor 不得计算指标、执行任意 SQL、绕过用户范围，或在未校验证据 ID 时把专家文本当作证据。

### 3.3 专家 Agent

首批专家：

| 专家 | 职责 | 初始证据 |
| --- | --- | --- |
| Stats Analyst | 总体趋势、胜负、K/D、ADR、ACS、KAST | summary、periods、comparisons |
| Death Coach | 首死、死亡时机、换人潜力 | summary、match list、round evidence |
| Aim Coach | 爆头率、伤害、击杀转化、武器趋势 | summary、match detail、periods |
| Map Coach | 地图和攻守差异 | map comparison、attack/defense comparison |
| Economy Coach | 购买、存枪、奖励局和低经济结果 | economy analysis、match detail |
| Rank Analyst | 仅分析可观察段位和比赛环境 | rank history、match context |

专家返回结构化发现：

```ts
export type SpecialistFinding = {
  specialist: string;
  conclusion: string;
  confidence: "low" | "medium" | "high";
  claims: Array<{
    text: string;
    metricName?: string;
    matchId?: string;
    roundNumber?: number;
    knowledgeChunkId?: string;
  }>;
  recommendations: Array<{ action: string; rationale: string }>;
  limitations: string[];
};
```

如果官方数据不包含精确移动、准星位置或意图，专家不得推断这些内容。

## 4. 事实来源和时间窗口分析

玩家事实由分析层负责：

```text
Riot DTO 校验
  -> 竞技模式过滤
  -> 标准化比赛 / 回合 / 事件表
  -> 确定性指标
  -> 时间窗口快照
  -> 对比结果
  -> 稳定证据 ID
```

前 20 场和后 20 场是确定性时间窗口比较，不是向量记忆检索：

```text
排序后的竞技比赛
  -> 时间窗口 A 快照
  -> 时间窗口 B 快照
  -> 指标差值
  -> Agent 解释
```

建议增加：

```text
analysis_periods
player_profile_facts
specialist_findings
```

`analysis_periods` 保存比赛范围、样本量、时间和指标。`player_profile_facts` 只保存有时间范围且有证据的观察，不得保存没有范围和证据的 `bad_aim` 标签。

## 5. 多轮会话状态

模型上下文不是事实来源。会话状态必须独立持久化：

```ts
export type AnalysisSessionState = {
  sessionId: string;
  userId: string;
  activeQuestion: string;
  dataScopes: Array<{
    label: string;
    fromMatchId?: string;
    toMatchId?: string;
    matchCount: number;
    fromTime?: string;
    toTime?: string;
  }>;
  activeHypotheses: Array<{
    text: string;
    status: "open" | "supported" | "rejected";
    evidenceIds: string[];
  }>;
  findings: SpecialistFinding[];
  evidenceIds: string[];
  unresolvedQuestions: string[];
  lastPromptId: string;
  lastPromptVersion: string;
};
```

大型工具结果和原始记录留在上下文外，Prompt 只接收紧凑摘要和稳定引用。用户改变范围时必须新建范围记录。

## 6. Agent 控制契约

模型每次响应必须是类型化事件，不能解析自由文本发现命令：

```text
tool_call
specialist_request
clarification_request
final_answer
refusal
error
```

运行状态：

```text
RECEIVED -> AUTHENTICATED -> CLASSIFIED -> SCOPE_RESOLVED
  -> TOOL_LOADOUT_SELECTED -> SPECIALISTS_RUNNING
  -> FINDINGS_VALIDATED -> SYNTHESIZING -> ANSWER_VALIDATED -> COMPLETED
```

默认限制：

```text
max_steps: 8
max_specialists: 4
max_tool_calls: 12
max_duration_ms: 30_000
max_output_tokens: 2_000
max_cost_usd: 按环境配置
max_delegation_depth: 1
```

第一版不允许专家继续创建专家，以保持委派深度有限、Trace 可理解。

## 7. 工具和 MCP

领域逻辑只实现一次，再通过适配器暴露：

```text
packages/domain
  -> 标准 DTO、指标契约、时间窗口比较
apps/api-ts
  -> HTTP 和 Agent 适配器
apps/analytics-mcp
  -> 只读分析 MCP 工具
apps/knowledge-mcp
  -> 审核后的知识搜索和证据工具
```

首批工具：

```text
get_player_summary
get_match_list
get_match_detail
get_round_evidence
get_player_periods
compare_periods
compare_map_performance
compare_attack_defense
get_economy_analysis
get_player_profile
```

每个 MCP 工具必须有严格 JSON Schema、认证范围、结果限制、稳定错误码、证据 ID、延迟元数据和审计 Trace。不暴露任意 SQL。

## 8. 证据契约

```text
玩家证据：指标、比赛、回合、时间窗口、样本量、时间范围
知识证据：来源、知识块、页码、时间戳、图片区域、补丁、信任级别
```

答案必须区分：

```text
观察到的玩家事实
通用教练原则
模型解释
不确定性或限制
```

## 9. 可靠性、安全和可观测性

必须具备：

```text
幂等、超时、根据限流重试、成本保护、权限分级、Trace 和 Replay
```

只读分析可以自动执行；保存训练目标等写操作必须获得用户明确确认。每次运行记录 Prompt ID/版本/Hash、模型/版本、上下文 Hash、工具集合、事件、证据 ID、Token、延迟、估算成本、状态和脱敏错误。

## 10. 评测

评测完整轨迹，而不只是最终文字：

- 任务完成度；
- 专家路由准确率；
- 工具参数正确性；
- 证据引用有效性；
- 时间窗口范围正确性；
- 无依据声明比例；
- 拒答和授权正确性；
- 工具失败后的恢复；
- 多轮一致性；
- 步数、延迟、Token 和成本。

首批多轮用例：

```text
我最近为什么总是输？
这是枪法还是决策问题？
对比我前 20 场和后 20 场。
哪些比赛支持这个结论？
这是 ELO 还是我自己的表现？
这周应该练什么？
改变时间窗口的后续追问。
质疑专家结论的后续追问。
```

Schema、权限、范围和证据使用确定性评分器；“有用性”和“表达清晰度”等维度才使用模型评分，并需要人工校准。

## 11. 交付顺序

1. 固化契约、事件类型和 Prompt Registry。
2. 持久化会话、运行记录和事件。
3. 将分析工具抽取为共享契约。
4. 实现 Supervisor Loop 和受限委派。
5. 实现 Stats、Death、Aim 专家。
6. 增加时间窗口快照和 `compare_periods`。
7. 增加 Trace Replay 和成本保护。
8. 增加 Analytics MCP 适配器。
9. 建立 20 条多轮评测。
10. 增加 Map 和 Economy 专家。
11. 构建审核后的多模态知识入库管线。
12. 增加 Knowledge MCP 和检索评测。
13. 只有当关键词检索未达到评测目标时，才增加 pgvector。

## 12. 完成标准

当玩家可以持续追问以下问题时，架构里程碑完成：

```text
我最近为什么总是输？
这是枪法还是决策问题？
对比我前 20 场和后 20 场。
哪些比赛支持这个结论？
这周应该练什么？
```

系统必须保持跨轮范围一致，只在必要时委派，返回确定性玩家指标，引用比赛或回合证据，引用实际使用的知识，说明限制，保存可回放 Trace，并生成评测结果。
