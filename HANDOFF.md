# VALORANT Analytics 项目交接文档

更新时间：2026-09-16

## 本次交接（新对话从这里开始）

### 当前状态

- GitHub 仓库：`https://github.com/FiveSunfw/valorant-analytics`
- 当前分支：`main`，已推送提交 `603f623 feat: initialize VALORANT analytics foundation`。
- `.env` 已在本机配置了 Riot 开发 API Key；密钥不在 Git、不在本文件，也不应发到聊天中。
- `.gitignore` 已忽略 `.env`、`node_modules`、构建产物、日志、数据库目录，以及本交接文件和 `AGENTS.md`。
- 本机配置加载已统一：`packages/config` 会从项目根目录向上查找 `.env`；已有系统环境变量优先于 `.env`。API、Worker、迁移程序均已接入。
- Python 版本保留在 `apps/api` 和 `apps/worker`，TypeScript 版本是当前默认开发方向。

### 可访问服务

- API 健康检查：`http://localhost:8000/health`
- TypeScript Web：`http://localhost:3001`（生产构建；开发端口 3000 曾遇到缓存问题）
- 静态产品原型：`http://localhost:3002/prototype.html`
- RabbitMQ 管理台：`http://localhost:15672`
- PostgreSQL：`localhost:15432`
- Redis：`localhost:16379`

### 本次对话记录

本次明确了简历和架构叙述应围绕“具体业务链路与异常处理”展开，而不是只罗列 RabbitMQ、PostgreSQL 或 Agent 等组件。可靠同步链路的可展开实现如下：生产端将 `riotAccountId` 和比赛载荷封装为持久化 RabbitMQ 消息；Worker 通过 `prefetch` 控制未确认消息数量，消费后校验授权账号、竞技模式和比赛完成状态；Riot API 返回 429 时读取 `Retry-After` 并退避重试；落库时以 `matchId` 获取 PostgreSQL advisory transaction lock，在事务内写入比赛、回合、击杀和伤害证据；事务提交成功后才 `ack`，处理失败则复制到延迟重试队列并递增重试次数，超过阈值后转入死信队列。唯一约束、事务锁和幂等写入共同处理重复投递与并发竞争。

同时确认：这里要实现的是 Claude Code 风格的 **real-time Steering**，不是强制取消 RabbitMQ 同步任务。RabbitMQ 在 Agent 场景中承载按 `runId` 路由的 Steering Event；Agent 主循环在一次模型响应或工具调用完成后的安全检查点读取追加指令，把它注入下一轮 context，再重新决定后续工具调用。`cancel` 终止当前 Agent run，`steer` 调整当前 run 的后续路径，`new_task` 结束当前 run 并创建独立任务；不在模型请求或数据库事务中途强行打断。

当前已完成受限单 Agent 的真实模型闭环：`deepseek-flash` 只能调用认证用户范围内的结构化分析工具；成功和模型/工具/预算/输出失败都写入 `agent_runs`，并汇总 usage。Demo 登录、Next.js 代理页面与按当前用户范围查询的 `GET /agent/runs/:runId` 已可演示。RSO、真实 Riot 同步、RAG、多 Agent 和 Steering 仍未实现。

### 2026-09-16 收口状态

- `ENABLE_DEMO_MODE=true` 才注册固定 full fixture 的 `POST /auth/demo`；生产环境永不注册，接口不接受 userId、PUUID 或其他玩家标识。
- `ENABLE_EVAL_MODE=true` 才注册本地 `POST /auth/eval`。它只接受封闭的 `full`、`small`、`empty` fixture profile，用于真实模型 Eval，绝不接受玩家身份。
- fixture 已有 full（6 场且含首死证据）、small（2 场且无首死证据）与 empty（0 场）三种实际数据场景。先运行 `npm run demo:seed --workspace=@valorant/api`。
- 每次 Agent 相关改动先跑类型/单测/构建，再用构建产物 API 跑真实 `deepseek-flash` Eval；结果仅保存在被忽略的 `eval/results/`，不提交。

### 新对话首个任务

1. 先完成最小 Agent 闭环：认证用户问题 -> 竞技战绩工具 -> 证据型回答 -> HTTP 返回。
2. 再扩展 Stats/Death/Aim/Map 专家，再接入审核后的 RAG 知识证据。
3. 最后补齐统一安全/校验中间件、Trace/Eval、Steering 和完整同步自动化。
4. RSO、Match API 和 Worker 作为数据入口继续完善；没有真实 Riot 权限时使用 mock fixture，不等待 Riot 审核阻塞 Agent 核心。

当前已落地：`apps/api-ts/src/agent-runtime.ts` 提供受限单 Agent loop，`/agent/analyze` 只接受当前产品会话，工具白名单、输入 schema、调用超时、步数/调用数预算和证据型最终输出均已测试；`apps/api-ts/src/agent/prompts/registry.ts` 提供带版本/hash 的最小 Prompt Registry。

### 重要边界

- Riot API Key 不能代替 RSO；产品必须先确认当前用户身份，不能接受任意 PUUID。
- 官方 Match API 提供回合结果、玩家回合统计、击杀时间/终结伤害和伤害命中部位等结构化证据，但不是逐帧录像或完整弹道遥测。
- 原型中的走位、peek 等描述只能在官方数据确实支持时使用；不足时必须明确标注限制。

## 1. 项目定位

这是一个面向 VALORANT 国际服竞技玩家的赛后复盘 Agent。

产品通过 Riot RSO 获取玩家本人授权，通过 Riot 官方 VALORANT Match API 同步竞技对局，计算个人指标，并通过可解释的 Agent 工具调用生成带比赛/回合证据的训练建议。

第一版范围已经确定：

- 只支持 VALORANT 国际服。
- 只支持竞技模式。
- 排除死斗、极速、自定义及其他非竞技模式。
- 只分析当前授权玩家本人。
- 不提供他人战绩查询或分享链接。
- 增加去标识化的匿名同段位基准。
- 不做赛前对手侦察、实时指挥、作弊辅助或自定义 MMR/ELO。

## 2. 当前已完成

### 工程骨架

项目路径：`E:\valorant-analytics`

当前服务：

- `apps/web`：Next.js TypeScript 前端最小页面，含 `typecheck` 命令。
- `apps/api-ts`：Fastify TypeScript API，已有 `/health`。
- `apps/worker-ts`：RabbitMQ TypeScript Worker，`prefetch=2`。
- `packages/domain`：不依赖运行时的 TypeScript 竞技模式过滤、本人回合证据和确定性指标。
- PostgreSQL：Docker Compose 服务。
- Redis：Docker Compose 服务。
- RabbitMQ：Docker Compose 服务，负责异步同步任务、重试和死信队列。
- `apps/migrate-ts`：PostgreSQL TypeScript 迁移运行器；Compose 已不再依赖 Python/Alembic 镜像。
- Python `apps/api`、`apps/worker` 保留为短期迁移对照，但不再处于默认 Compose 运行路径。

### 当前实现与可展开细节

- `apps/worker-ts/src/jobs.ts` 定义同步 exchange、主队列、延迟重试队列和死信队列；同步消息携带内部 `riotAccountId`，不接受任意 PUUID。
- `apps/worker-ts/src/worker.ts` 使用手动确认消费：成功持久化后 `ack`；失败时按 `x-retry-count` 将原消息重新发布到 retry queue 或 DLQ，当前最多重试 3 次；重试发布失败时 `nack(requeue=true)`，避免消息丢失。
- `apps/worker-ts/src/persist.ts` 先查询授权 Riot 账号的 PUUID，再过滤非完成竞技对局或不属于该账号的比赛；每个 `matchId` 在独立事务中使用 `pg_advisory_xact_lock`，写入比赛、回合及本人击杀/伤害证据。
- `apps/worker-ts/src/riot-match-client.ts` 已覆盖 Matchlist/Match 请求、429/5xx 重试、`Retry-After` 和错误分类；仍待接入账号令牌仓储和实际 Worker 任务。
- `apps/api-ts/src/agent-tools.ts` 已提供 `get_player_summary`、`get_match_list`、`get_round_evidence` 三个认证用户范围内的只读工具；Agent 不直接读取 token，也不能通过工具参数切换 PUUID。

基础文件：

- `docker-compose.yml`
- `.env.example`
- `apps/web/Dockerfile`
- `apps/api-ts/Dockerfile`
- `apps/worker-ts/Dockerfile`
- `apps/migrate-ts/Dockerfile`

### 项目文档

- `AGENTS.md`：不可变约束、运行方式和测试规则。
- `docs/spec.md`：产品范围和功能验收标准。
- `docs/architecture.md`：系统分层、Agent 工具和 Context 设计。
- `docs/prompt_plan.md`：分阶段实现计划。
- `docs/eval_plan.md`：Eval Case、指标和消融实验设计。

## 3. 已知环境状态

当前开发环境：

- Docker Desktop 已配置，数据磁盘已迁移到 E 盘：`E:\code\DockerDesktopWSL\disk\docker_data.vhdx`。
- PostgreSQL、Redis 与 RabbitMQ 已通过 Docker Compose 运行，宿主机端口分别为 `15432`、`16379`、`5672`（管理界面 `15672`）。PostgreSQL 容器内部仍使用 `5432`，Redis 容器内部仍使用 `6379`。项目刻意不使用宿主 `6379`，因为该端口由独立的旧版 Windows Redis 服务占用。
- Web、API 与 Worker 当前使用本机 Node/Python 运行；Docker Hub 暂时无法拉取 `node:22-alpine` 和 `python:3.12-slim`，因此这三项服务未走镜像构建。
- Node.js 路径：`D:\Nodejs\node.exe`；Python 路径：`D:\anaconda\python.exe`。
- 后端开发使用项目内隔离环境：`E:\valorant-analytics\.venv\api`。不要再向 Anaconda 全局环境安装项目依赖，其中已有与 Agent SDK 不兼容的旧 `aiohttp` 及其他无关包。

项目中的 PostgreSQL 数据目录已经改为：

```text
E:\valorant-analytics\data\postgres
```

注意：Docker 镜像层由 Docker Desktop 全局管理，不能通过项目的 Compose 文件指定。必须在 Docker Desktop 设置中调整。

## 4. 切换目录后的第一步

在 PowerShell 中进入项目：

```powershell
Set-Location E:\valorant-analytics
$docker = "C:\Users\abc18\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe"
```

查看 Compose 配置和基础服务：

```powershell
& $docker compose config
& $docker compose up -d postgres redis rabbitmq
```

如果新终端仍提示找不到 `docker`，先使用上面的 `$docker` 变量；Docker Desktop 后台进程已存在，但该 CLI 目录当前没有进入终端的 `PATH`。默认 Compose 启动 PostgreSQL、Redis 和 RabbitMQ；API、Worker、Web 使用本机 Node 环境。容器化服务保留在 `containerized` profile，只有显式指定该 profile 才会构建或启动。

初始化或更新 API 本机依赖：

```powershell
D:\anaconda\python.exe -m venv .venv\api
.\.venv\api\Scripts\python.exe -m pip install -r apps\api\requirements.txt
$env:PYTHONPATH = "apps\api"
.\.venv\api\Scripts\python.exe -m unittest discover -s apps\api\tests -v
```

验证 Web TypeScript：

```powershell
Set-Location apps\web
D:\Nodejs\npm.cmd run typecheck
```

预期入口：

- Web：`http://localhost:3000`
- API：`http://localhost:8000`
- API 文档：`http://localhost:8000/docs`
- API 健康检查：`http://localhost:8000/health`

## 5. 下一阶段执行顺序

### 阶段一：修正基础工程并启动

1. 验证 Docker Compose 配置。
2. 启动 PostgreSQL、Redis、RabbitMQ、API、Worker、Web。
3. 验证 API 健康检查和 Web 页面。
4. 增加基础日志和服务健康检查。

### 阶段二：数据模型和迁移（已建立首个基线）

建立 PostgreSQL 表：

- `users`
- `riot_accounts`
- `riot_tokens`
- `matches`
- `player_match_stats`
- `player_round_stats`
- `derived_metrics`
- `peer_benchmarks`
- `insights`
- `agent_traces`
- `agent_tool_calls`

已使用 TypeScript `apps/migrate-ts` 建立幂等 `20260905_0002` 基线迁移，并新增 Compose `migrate` 一次性服务。`docker compose up --build` 会在 PostgreSQL 健康后迁移，再启动 API 和 Worker。它能安全应用到此前 Alembic 初始化的本地数据库。详情见 `docs/data_model.md`。

已建表：`users`、`riot_accounts`、`riot_tokens`、`matches`、`match_rounds`、`player_match_stats`、`player_round_stats`、`round_kills`、`round_damage`。`derived_metrics`、匿名 `peer_benchmarks`、`insights`、Agent trace 表留给指标与 Agent 接入阶段，避免在没有写入语义时预设字段。

### 阶段三：Riot RSO

实现：

- `/auth/riot/start`
- `/auth/riot/callback`
- `GET /riot/account/v1/accounts/me`
- token 加密保存和过期刷新。
- Riot 账号解绑和数据删除。

没有 Riot 生产权限时，先使用 mock OAuth 和脱敏比赛 JSON fixture 开发。

### 阶段四：竞技对局同步

实现同步链路：

```text
puuid
-> /val/match/v1/matchlists/by-puuid/{puuid}
-> /val/match/v1/matches/{matchId}
-> 模式过滤
-> 原始数据入库
-> 结构化数据解析
```

必须实现：

- 只保留竞技模式。
- match ID 幂等。
- 429 指数退避和 jitter。
- 单局失败不影响其他比赛。
- 同步过程进入 RabbitMQ Worker，不在 HTTP 请求中串行执行。

`apps/worker-ts` 已增加服务端 `RiotMatchClient`：使用官方 `Matchlist` 与 `Match` 端点，按 429/5xx 重试并添加 jitter，401/403/404 作为不重试的错误分类；客户端接收的 PUUID 仅来自未来的 Worker 账号仓储，未暴露给 HTTP 或 Agent 工具。它以 mock fixture 覆盖服务端 API key、重试、错误分类和单局失败隔离，尚未接入 Worker，待 TypeScript RSO 账号与令牌仓储完成后使用。

TypeScript 迁移基线已建立：`packages/domain` 用 Zod 验证脱敏 `MatchDto`、只允许完成的竞技模式并计算 ADR、ACS、K/D、爆头率、首死率；`apps/worker-ts` 通过 RabbitMQ 以授权账号内部 ID 写入原始 JSON 和本人相关的回合/击杀/伤害证据。Worker 使用 `prefetch=2`，失败消息最多重试 3 次，随后进入死信队列；同一场比赛通过 PostgreSQL advisory transaction lock 避免并发重复任务竞争。`apps/api-ts` 提供只读 `AnalyticsReader` 与 `createAnalyticsTools`。工具只从当前认证用户的内部 ID 查询 summary、match list、round evidence，且最终结论 schema 强制每个 claim 引用指标或具体比赛/回合。下一个任务是接入 TypeScript 的模型调用、trace 持久化，再迁移 Riot Match API/RSO。架构参考 pi 的 workspace + 独立领域核心组织方式，但不引入其通用 Agent runtime，避免破坏本项目授权边界。

### 阶段五：确定性指标

第一批实现：

- 胜率
- K/D
- ADR
- ACS
- KAST
- 爆头率
- 首杀率
- 首死率
- 攻守胜率
- 经济局胜率
- 地图和英雄表现

所有指标都需要 fixture 单元测试。

### 阶段六：Agent 工具和 SDK Runtime

第一批工具：

```text
get_player_summary
get_match_list
get_match_detail
compare_periods
compare_attack_defense
compare_map_agent
get_round_evidence
get_peer_benchmark
```

每个工具必须：

- 只允许当前用户本人数据。
- 强制 `queue=competitive`。
- 校验参数。
- 设置超时。
- 返回结构化结果、样本数和限制说明。
- 记录工具调用 trace。

Agent 第一版采用 TypeScript 的单 Agent 适配层，不做多 Agent。模型适配层将管理模型/tool loop、最大轮数与 provider trace；Fastify 服务层管理总时间、token/cost budget 与产品 trace。当前已定义前三个无 PUUID 参数的只读工具：`get_player_summary`、`get_match_list`、`get_round_evidence`，且数据库 reader 已接入。下一步是连接模型 provider、持久化 trace 并补充 Eval。

### 阶段六补充：实时 Steering

Agent loop 需要引入异步控制事件，而不是把 Steering 当作同步 Worker 的取消信号：

```text
用户追加指令
-> RabbitMQ agent.steering exchange
-> 按 runId 路由到 Agent loop
-> 当前工具调用完成
-> drain pending steering events
-> 注入下一轮 context
-> 模型重新选择工具或结束任务
```

计划新增 `agent_runs` 和 `agent_steering_events`（或等价的状态存储），至少记录 `runId`、用户范围、事件类型、序号、内容、消费时间和处理结果。事件类型区分 `steer`、`cancel`、`new_task`；同一个 run 按 sequence 去重并按顺序消费。模型请求、工具调用和数据库事务都只在安全检查点响应 Steering，避免半写入和不可恢复状态。需要补充实时追加指令、重复事件、任务取消、run 恢复以及 Steering 前后决策 trace 的测试。

### 后续执行顺序（已更新）

1. 完成最小战绩分析 Agent 的真实模型 provider、产品 trace 和前端演示；保留当前确定性模型作为离线 fixture。
2. 在同一工具/证据契约上加入 Stats、Death、Aim、Map 专家，先做单层委派和专家 finding 校验。
3. 引入审核后的 RAG 知识库：来源、版本、chunk、引用和冲突审核都必须可追溯，不能把外部 Replay/OP.GG 结果伪装成 Riot 事实。
4. 增加统一输入/工具/输出安全中间件、token/cost budget、拒答、Trace、Eval 和 Steering；再补齐多轮会话状态。
5. 继续完善 RSO token refresh、授权账号仓储、`RiotMatchClient` 和 RabbitMQ account-sync；这些是数据入口，不应阻塞第一条 Agent 演示链路。
6. 最后完善 Web 的总览、单局复盘、建议、同步状态和实时 Agent 输出体验。

### 阶段七：Eval 和简历材料

准备 15-20 个 Eval Case，覆盖：

- 正常分析。
- 空数据和小样本。
- Riot API 超时和 429。
- 工具空结果。
- 他人查询。
- 赛前侦察。
- 实时指挥。
- token 泄露。

记录：通过率、失败类型、步骤数、工具调用次数、延迟、输入/输出 token 和估算成本。

至少完成三组消融实验：

1. 原始 JSON vs 结构化分析工具。
2. 汇总指标 vs 汇总指标加回合证据。
3. 个人历史基准 vs 加匿名同段位基准。

## 6. 关键实现原则

- 原始比赛 JSON 不直接塞进模型上下文。
- 先用确定性代码计算统计，再让 Agent 解释和检索证据。
- 没有足够样本时不生成确定性行为结论。
- 每条建议都要能追溯到指标或具体比赛/回合。
- 不提前编造评测通过率、性能或成本数据。
- Riot API Key、RSO secret 和 token 永远不提交到 Git。
- 外部 Riot API 测试必须使用 mock，不使用真实个人数据。

## 7. 建议的首个可演示闭环

在没有 Riot 生产权限时，先用 fixture 完成：

```text
脱敏比赛 JSON
-> 竞技模式过滤
-> 入库
-> 计算 ADR/ACS/KD/HS/首死率
-> get_player_summary
-> get_round_evidence
-> Agent 输出带证据的首死分析建议
-> 保存 agent trace
```

这个闭环完成后，项目已经具备可演示的 Agent 核心；再接入真实 RSO 和 Riot API，不会被外部权限阻塞整体开发。

## 8. 参考文档

- 项目规则：`AGENTS.md`
- 产品规格：`docs/spec.md`
- 架构说明：`docs/architecture.md`
- 实现计划：`docs/prompt_plan.md`
- 评测计划：`docs/eval_plan.md`
- Riot 官方 API：https://developer.riotgames.com/apis
- Riot VALORANT 文档：https://developer.riotgames.com/docs/valorant
