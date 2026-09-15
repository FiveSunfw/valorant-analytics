# 实现计划

## Phase 0：文档与骨架

- 固化产品边界和数据权限。
- 补齐 AGENTS、spec、architecture、eval 文档。
- 让 Docker、API、Web、Worker 的健康检查可运行。

验收：新开发者可以按 README 启动项目并理解不做什么。

## Phase 1：最小 Agent 数据闭环（当前优先）

- 先用现有脱敏 fixture 和 `AnalyticsReader` 跑通认证用户问题、竞技战绩工具、证据型回答和 HTTP 返回。
- 使用受限 TypeScript Agent loop：工具白名单、参数 schema、调用超时、步数/调用数预算和最终证据契约。
- 保留确定性离线模型作为 fixture；真实模型 provider 可替换接入，不改变权限和工具边界。

验收：`POST /agent/analyze` 只接受产品会话，正常问题能返回指标引用；实时指挥、赛前侦察、作弊辅助和隐藏 MMR/ELO 请求会拒答。

## Phase 2：数据闭环

- 实现产品会话。
- 实现 Riot RSO start/callback。
- 加密保存 token，支持解绑和删除。
- 同步 matchlist 和 match detail。
- 只保留竞技模式，增加幂等和 429 重试。

验收：使用 mock Riot 响应可以完成授权后的同步流程。

## Phase 3：确定性指标

- 建立用户、账号、比赛、玩家比赛、回合和指标表。
- 实现基础指标和 Act 聚合。
- 实现地图、英雄、攻守和经济维度。

验收：fixture 输入的指标结果可重复，并有单元测试。

## Phase 4：专家 Agent

- 在同一 evidence contract 上增加 Stats、Death、Aim、Map 专家。
- 第一版只做单层委派，专家输出必须通过 `SpecialistFinding` 校验。

验收：总体战绩问题能调用最少必要的专家；专家不能越权读取身份或生成无证据行为结论。

## Phase 5：RAG 和分析工具

- 实现 8 个只读工具。
- 加入参数校验、超时、错误类型和 trace。
- 工具只访问当前用户和竞技数据。

验收：每个工具可独立测试；非法 PUUID、非竞技队列和越权请求都会被拒绝。

## Phase 6：安全、Trace 和 Agent Loop 扩展

- 使用 TypeScript 模型 provider 适配层实现单 Agent，避免维护通用 Agent runtime。
- 使用 `Runner` 的最大轮数；在服务层追加总执行时间、token 和成本预算。
- 输出结论、证据、置信度、建议和限制。
- 用 Pydantic 定义最终输出，并加入输入、工具和输出 guardrail。

验收：正常分析会调用合适工具；证据不足会降级；高风险请求会拒绝；每次运行可关联 SDK trace 与产品 trace。

## Phase 7：产品页面

- 总览、Act、单局复盘、行为模式和训练目标。
- 指标可钻取到比赛和回合。
- 展示同步中、失败、授权过期和空数据状态。

## Phase 8：评测和复盘

- 完成 15-20 个 Eval Case。
- 记录通过率、失败类型、工具调用、延迟和 token 成本。
- 完成结构化工具、回合证据、同段位基准三组消融实验。
- 将真实结果写回 README 和复盘文档。
