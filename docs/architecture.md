# 系统架构与边界

## 1. 总体架构

```text
Next.js Web
  -> Fastify API
      -> PostgreSQL
      -> Redis (short-lived cache)
      -> RabbitMQ -> Node.js Worker -> Riot RSO / Match API
```

Next.js（TypeScript）负责页面和产品会话；Fastify（TypeScript）负责 OAuth、业务 API、权限和 Agent 服务；RabbitMQ Worker（TypeScript）负责同步、指标计算和基准聚合，使用 `prefetch=2` 控制并发，失败任务延迟重试后进入死信队列；PostgreSQL 保存结构化数据和 trace；Redis 只保留短期缓存职责。前端入口已采用 `.tsx` 与严格 TypeScript 配置。

项目采用 npm workspace：`packages/domain` 是可独立测试的纯领域核心，`apps/api-ts`、`apps/worker-ts` 与 `apps/migrate-ts` 是薄运行时适配层，Web 作为同一 TypeScript 工作区的产品入口。这借鉴 pi 的 workspace 与核心包分层，但不采用其通用 Agent runtime；认证用户作用域和 Riot 授权边界必须由本项目明确持有。

## 2. 数据边界

```text
Riot RSO token: 仅 Fastify API/Worker
玩家 PUUID: 仅绑定到当前产品用户
raw match JSON: PostgreSQL JSONB，允许重算，禁止直接给模型
derived metrics: 面向查询和分析的结构化数据
peer benchmark: 仅去标识化聚合统计
```

## 3. 分层设计

### 数据层

负责 API 响应存储、模式过滤、字段标准化、幂等和迁移。

### 确定性分析层

负责 ADR、ACS、KAST、HS%、首杀/首死、攻守、经济、地图和英雄统计。相同输入必须产生相同输出。

### Agent 层

模型调用适配层负责循环、工具调用、最大轮数与模型 trace；项目负责注册只读领域工具、组装经认证的用户 context、保存产品 trace，并强制数据权限。当前 `createAnalyticsTools` 已提供 summary、match list、round evidence 三项 TypeScript 工具，后续模型适配层只能调用这些已验证的工具。Agent 不直接读取 token，也不直接决定数据范围。

### 展示层

负责总览、Act、单局复盘、行为模式、建议和同步状态。

## 4. Agent 工具注册

第一版注册以下工具：

`get_player_summary`、`get_match_list`、`get_match_detail`、`compare_periods`、`compare_attack_defense`、`compare_map_agent`、`get_round_evidence`、`get_peer_benchmark`。

所有工具必须校验 `scope=self` 和 `queue=competitive`，并返回结构化 JSON、数据范围、样本数和限制说明。

## 5. Context 顺序

```text
System Policy
-> Product Rules
-> Player Profile
-> Current Act Summary
-> User Question
-> Tool Results
-> Conversation History
```

禁止把完整原始 JSON 直接拼进 prompt；优先使用聚合结果，必要时再检索具体回合。
