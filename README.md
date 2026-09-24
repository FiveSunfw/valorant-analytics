# VALORANT Analytics

> 面向 VALORANT 国际服竞技玩家的、证据驱动的赛后训练诊断 Agent。
>
> **先读取自己的比赛事实，再选择受限诊断工具，最后生成可以回溯到比赛与回合证据的训练建议。**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![Fastify](https://img.shields.io/badge/Fastify-API-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker Compose](https://img.shields.io/badge/Docker_Compose-local_runtime-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Status](https://img.shields.io/badge/status-research_prototype-orange)](#当前状态)

## 这不是一个 KDA 面板

很多复盘工具能告诉你“这一局打得好不好”，但不能继续回答：**问题发生在哪类回合、证据是什么、下一段训练应该验证什么。**

VALORANT Analytics 把一次赛后提问处理成一条受控的诊断链路：

```text
玩家本人授权
      │
      ▼
同步已完成竞技对局 ──► 过滤 / 规范化 / 幂等落库
                              │
                              ▼
                     确定性指标与回合证据
                              │
玩家提出问题 ───────► Supervisor 选择最小诊断路径
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
          受限分析工具                  训练记忆 / 教学知识
                 │                         │
                 └────────────┬────────────┘
                              ▼
                   带证据、置信度与限制的结论
                              │
                              ▼
                         下一步训练建议
```

模型负责在有限范围内选择分析路径和组织解释；身份、权限、数据范围、工具白名单、样本门槛和终止条件由服务端控制。

## 为什么值得做

### 1. 证据优先，而不是让模型猜

玩家事实来自结构化比赛、回合、击杀、伤害和经济数据。教学知识是另一类来源，不能被混入“玩家在这一回合做了什么”的证据中。字段缺失或样本不足时，系统返回限制或不可判定，不用零值填充成看似完整的结论。

### 2. Agent 有边界，而不是一个开放式聊天框

统一提问入口后面是 Supervisor 和受限专家：Stats、Death、Map、Economy、Aim、Memory。每个专家只能调用自己的只读工具，运行受到专家数量、工具调用次数和单次超时限制。

### 3. 数据权限和产品边界是系统的一部分

第一版只覆盖国际服、当前授权玩家本人和已完成竞技模式。Agent 不接受任意 PUUID，不读取数据库或原始 Match JSON，不做实时指挥、对手侦察、作弊辅助或隐藏 MMR/ELO 推断。

### 4. 结论可以被复核

每次 Agent 运行记录状态、工具调用、Token、成本、延迟和错误分类；评测用例覆盖正常分析、权限拒绝、小样本、记忆、知识检索、提示注入和工具越权等路径。

## 当前已实现

| 模块 | 当前能力 |
| --- | --- |
| 数据接入 | Riot RSO 授权边界、玩家账号绑定、竞技模式过滤、同步任务与 fixture Demo 闭环 |
| 异步同步 | RabbitMQ Worker、重复任务幂等、Riot 429/5xx 退避重试、结构化持久化 |
| 确定性分析 | ADR、ACS、K/D、KAST、爆头率、首杀/首死、地图、攻守、英雄、经济与时间窗口等维度 |
| Agent Runtime | Supervisor + 领域专家路由、工具白名单、超时与调用预算、结构化答案 Schema |
| 证据链 | 玩家比赛证据、训练记忆、教学知识分层返回，答案带证据与置信度约束 |
| 训练记忆 | PostgreSQL 保存权威记录；可选 Mem0 召回用户确认的目标与历史分析摘要 |
| 知识检索 | PostgreSQL 审核过滤 + Qdrant 混合检索；支持本地 Qwen Embedding，故障时降级到全文检索 |
| 可观测与评测 | Agent Trace、工具调用记录、错误分类、`eval/cases.jsonl` 回归用例 |

## 一次分析是怎样完成的

以“我最近为什么总是先死？”为例：

1. 服务端确认问题属于当前用户的赛后分析范围。
2. Supervisor 只派发完成该问题所需的最小专家和工具。
3. 工具从已授权用户的结构化比赛与回合数据中读取首死、地图、攻守、经济等证据。
4. Runtime 检查工具参数、调用预算、证据范围和样本量。
5. 模型只能基于 observation 组织解释；它不能直接执行 SQL、访问 token 或自行扩大数据范围。
6. 返回结论、证据、置信度、限制和下一步训练建议，并写入可追踪的运行记录。

## 技术架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Next.js Web / Tauri Desktop                                  │
│ 同一套 Coach 工作台 · 会话 · 比赛上下文 · 分析结果             │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP
┌──────────────────────────────▼──────────────────────────────┐
│ Fastify API                                                   │
│ RSO OAuth · 用户边界 · Agent Runtime · Trace · Knowledge API  │
└───────────────┬─────────────────────────┬────────────────────┘
                │                         │
                │ 分析读取                │ 同步任务
                ▼                         ▼
       ┌─────────────────┐       ┌─────────────────┐
       │ PostgreSQL       │       │ RabbitMQ         │
       │ 比赛事实/证据/记忆 │       │ durable jobs     │
       └─────────────────┘       └────────┬────────┘
                                         ▼
                               ┌─────────────────┐
                               │ Worker           │
                               │ Riot API / retry │
                               │ normalize / save │
                               └─────────────────┘

        Qdrant + Embedding ── 教学知识检索
        Mem0（可选）       ── 用户训练记忆语义召回
        Redis              ── 运行时缓存与任务协调
```

### 技术栈

- **Web**：Next.js 15、React 19
- **API / Agent**：Node.js、TypeScript、Fastify、Zod
- **数据与任务**：PostgreSQL 16、Redis 7、RabbitMQ 3.13
- **检索与记忆**：Qdrant、BM25/RRF、可选 Rerank、Mem0、PostgreSQL fallback
- **运行与验证**：Docker Compose、Vitest、Agent Eval、Trace

## 快速开始

### 环境要求

- Node.js 22+
- Docker Desktop
- PowerShell

复制环境变量模板并按需填写。不要把 Riot secret、API key、access token 或 refresh token 提交到 Git。

```powershell
Copy-Item .env.example .env
```

只想跑本地 Demo 时，可以先不配置真实 Riot RSO；确定性模型和 fixture 数据可用于验证本地流程。真实模型需要 `DEEPSEEK_API_KEY`。配置 `MEM0_API_KEY` 后启用 Mem0，未配置时使用 PostgreSQL 本地记忆。

### 启动基础设施与本地 API

```powershell
docker compose up -d postgres redis rabbitmq

npm install
npm run build --workspace=@valorant/migrate
npm run start --workspace=@valorant/migrate
npm run demo:seed --workspace=@valorant/api
npm run knowledge:seed --workspace=@valorant/api

$env:ENABLE_DEMO_MODE = "true"
npm run start --workspace=@valorant/api
```

另开一个终端启动 Web：

```powershell
npm run dev --workspace=@valorant/web -- -p 3000
```

服务地址：

- Web：<http://localhost:3000>
- API 健康检查：<http://localhost:8000/health>
- RabbitMQ 管理界面：<http://localhost:15672>
- 本地 PostgreSQL：`localhost:15432`
- 本地 Redis：`localhost:16379`

### 正式桌面客户端与 Coach 会话

桌面端位于 `apps/desktop`，是一个内置 React/Vite 前端的 Tauri 客户端，不是打开远程 Web URL 的浏览器壳。它提供独立窗口、会话侧栏、对话区、比赛上下文栏、同步状态和账号状态；Coach 会话与消息仍由服务端持久化，Riot 密钥和 token 永远不进入客户端。

先启动 PostgreSQL、Redis、RabbitMQ 与 API，再启动桌面客户端：

```powershell
npm run dev --workspace=@valorant/api
npm run tauri:dev --workspace=@valorant/desktop
```

桌面 Vite 开发服务器默认使用 `http://127.0.0.1:1420`，API 默认使用 `http://127.0.0.1:8000`。需要连接其他 API 时设置：

```powershell
$env:VITE_API_BASE_URL = "http://127.0.0.1:8000"
$env:CORS_ORIGINS = "http://127.0.0.1:1420,http://localhost:1420,tauri://localhost,http://tauri.localhost"
$env:RIOT_POST_AUTH_REDIRECT_URL = "http://127.0.0.1:1420/"
npm run tauri:dev --workspace=@valorant/desktop
```

生产构建通过已提交的 `apps/desktop/.env.production` 连接 `https://valorant-analytics-api.vercel.app`；该文件只有公开地址，不得放入密钥。Vercel API 项目通过根目录 `api/index.mjs` 将请求适配到当前 TypeScript Fastify API，至少需要配置 `DATABASE_URL`、`REDIS_URL`，实际同步还需要可访问的 `RABBITMQ_URL` 与独立 Worker。Vercel Web 项目需要把 `API_BASE_URL` 设置为上述 API 域名。Riot RSO 上线时同时设置：

```text
RIOT_REDIRECT_URI=https://valorant-analytics-api.vercel.app/auth/riot/callback
RIOT_POST_AUTH_REDIRECT_URL=https://<web-production-domain>/?riot=connected
```

部署后必须先验证 `GET /health` 返回数据库和 Redis 均为 `ok`，再构建桌面安装包。生产会话 Cookie 使用 `SameSite=None; Secure`，以允许 Tauri 客户端通过 HTTPS 携带服务端会话；开发环境仍使用 `SameSite=Lax`。

会话归属于同一个产品客户端用户，而不是某个 Riot 账号，因此同一个客户端可以切换 Riot 账号继续使用历史对话；每次挂载比赛或分析前，服务端仍会校验该比赛是否属于当前产品用户的已授权数据范围。桌面前端可以独立执行生产构建：

```powershell
npm run build --workspace=@valorant/desktop
```

原生 Windows 安装包还需要 MSVC C++ linker；当前环境未安装该工具链，因此只把客户端前端构建列为已验证，不把安装包构建包装成已完成。

### Windows 本地依赖约定

为避免系统盘被开发依赖和模型缓存占满，仓库相关下载统一放在 E 盘：

- npm cache：`E:\tools\npm-cache`
- Cargo home：`E:\tools\cargo-home`
- OpenCodeReview 工具：`E:\tools\ocr`

不要把 Riot secret、API key、access token、refresh token 或本地环境文件提交到 Git。

### 可选：重建教学知识索引

```powershell
npm run knowledge:extract --workspace=@valorant/api -- bili-haven-defense
npm run knowledge:draft --workspace=@valorant/api -- bili-haven-defense
npm run knowledge:reindex --workspace=@valorant/api
```

Qdrant、本地 Embedding 和来源审核状态按 `.env.example` 配置。知识检索只能提供通用教学背景，不能证明玩家在某个回合的实际站位、操作或意图。

## 验证与评测

```powershell
npm run typecheck
npm run test --workspace=@valorant/api
npm run test --workspace=@valorant/worker
npm run build --workspace=@valorant/web
npm run eval --workspace=@valorant/api
```

依赖本地 PostgreSQL、Redis 和 RabbitMQ 的集成测试默认跳过；需要时显式开启：

```powershell
$env:RUN_INTEGRATION_TESTS = "1"
npm run test --workspace=@valorant/api
npm run test --workspace=@valorant/worker
```

评测入口：[`eval/cases.jsonl`](eval/cases.jsonl)。用例设计和验收标准见 [`docs/evaluation-cases.md`](docs/evaluation-cases.md)。

## 安全与产品边界

- 仅支持 VALORANT 国际服；第一版仅同步已完成竞技模式。
- 仅允许当前授权玩家访问自己的数据；工具不接收任意玩家 PUUID。
- 必须通过 Riot RSO 获取玩家主动授权；不要求、不保存 Riot 密码。
- Riot API Key、RSO secret、access token 和 refresh token 只保存在服务端环境。
- 不实现赛前对手侦察、实时对局指挥、作弊辅助或 Riot 排位 MMR/ELO 替代。
- 同段位基准只使用去标识化聚合结果；样本不足时不输出群体结论。
- Demo fixture 只用于本地复现和评测，不计入真实用户基准。

## 当前状态

这是一个持续演进中的研究型原型，不把尚未完成的训练效果评估包装成已上线能力。

| 状态 | 范围 |
| --- | --- |
| ✅ 已实现 | Demo 登录与同步闭环、竞技数据结构化分析、受限 Agent 路由、证据与 Trace、记忆与知识检索降级路径 |
| 🧪 可验证 | API / Worker 单元测试、fixture 集成测试、Agent Eval、提示注入与越权边界用例 |
| 🚧 继续建设 | 冻结训练目标后的多场次效果评估、Case 状态恢复、人工审核与 bad-case 反馈闭环 |

当前阶段更准确的定义是：**带 Agent 能力的受控赛后分析系统**。同步、指标计算和权限控制是确定性 Workflow；模型只在已划定的分析问题范围内选择工具并组织解释。

## 仓库结构

```text
apps/
├─ api-ts/       Fastify API、Agent Runtime、知识库与 Demo
├─ worker-ts/    Riot Match API 同步 Worker 与重试
├─ migrate-ts/   PostgreSQL migration runner
├─ web/          Next.js Web 与共享 Coach 界面
└─ desktop/      Tauri 2 + React/Vite 正式桌面客户端
packages/
├─ domain/       指标、同步与领域合同
└─ config/       共享配置
docs/
├─ evaluation-cases.md   Agent Eval 用例与验收理由
└─ knowledge-sources.md  教学知识来源与审核边界
eval/
└─ cases.jsonl            可重复执行的 Agent 评测用例
tools/
├─ video-ingestion/       离线教学视频字幕处理
└─ embedding-service/     本地 Embedding 服务
```

## 文档入口

- [评测用例说明](docs/evaluation-cases.md)
- [教学知识来源登记](docs/knowledge-sources.md)
- [视频摄取工具](tools/video-ingestion/README.md)
- [Embedding 服务](tools/embedding-service/README.md)

## 设计原则

> **让模型解释事实，而不是创造事实。**

本项目的核心不是“接入了多少个 Agent、向量库或模型”，而是把个人比赛数据转成可查询的证据，把模型的自由度限制在可审计的诊断路径内，并在证据不足时明确说不知道。
