# VALORANT Analytics

面向 VALORANT 国际服竞技玩家的个人赛后复盘 Agent。它只分析当前授权用户的已完成竞技对局，用确定性指标和可追溯的比赛/回合证据生成训练建议。

> 当前是审核演示版本：使用脱敏 fixture 跑通 Demo 登录、同步状态、竞技比赛筛选、证据分析、同段位基准和训练记忆。真实 Riot RSO 与 Match API 仍需 `881743` 生产应用审核通过后开通。

## 已实现

- Demo 登录：仅开发环境启用，固定 fixture 用户，不接受 PUUID 或任意玩家身份。
- Demo 同步闭环：登录后可创建同步任务并查看任务状态；Worker 的真实账号同步路径使用服务端账号绑定的 PUUID。
- 同段位基准：只从已有授权账号的竞技比赛生成去标识化聚合；样本不足时不显示群体结论。
- 训练记忆：使用 PostgreSQL 保存当前用户确认的训练目标和分析摘要，不使用 RAG 或向量数据库。
- 单 Agent 闭环：最近多场趋势、攻守、首死、地图，以及选定单局的赛后分析。
- 证据约束：结论必须引用确定性指标或具体比赛/回合；不支持赛前侦察、实时指挥、作弊辅助、他人查询或隐藏 MMR/ELO。
- 地图回合归因：地图分析会读取地图指标和该地图的已完成回合结果，自行定位攻守方/首死模式，而不是让用户手工复盘后再回答。
- Trace 与 usage：成功与失败运行均写入 `agent_runs`，可按当前用户和 `runId` 查询。
- 真实模型 Eval：覆盖正常、空数据、小样本、权限与安全边界的 case；运行结果写入被忽略的 `eval/results/`。

## 本地运行

前置条件：Node.js 22、Docker Desktop，以及项目根目录未提交的 `.env` 中的 `DEEPSEEK_API_KEY`。

```powershell
docker compose up -d postgres redis rabbitmq
npm run build --workspace=@valorant/migrate
npm run start --workspace=@valorant/migrate
npm run demo:seed --workspace=@valorant/api

$env:ENABLE_DEMO_MODE = "true"
$env:ENABLE_EVAL_MODE = "true"
npm run start --workspace=@valorant/api
```

另开一个终端启动 Web：

```powershell
npm run dev --workspace=@valorant/web -- -p 3000
```

- Web: `http://localhost:3000`
- API health: `http://localhost:8000/health`

## 验证

```powershell
npm run typecheck
npm run test --workspace=@valorant/api
npm run build --workspace=@valorant/api
npm run build --workspace=@valorant/web
npm run eval --workspace=@valorant/api
```

Agent、prompt、工具或 context 的任何改动都必须运行真实模型 Eval；结果写入被忽略的 `eval/results/`，不提交。

## 部署边界

Cloudflare Pages/Workers 可以部署 Next.js Web 并提供 HTTPS 访问地址，通常不需要自备备案域名；但本项目的 API 仍依赖服务器侧 `DEEPSEEK_API_KEY`、PostgreSQL、Redis 和 RabbitMQ。不能把这些密钥或数据库 URL 放进浏览器端，也不能只部署前端就获得可用 Agent。

推荐的公开演示拓扑是：Cloudflare 托管 Web，独立的受保护 API 托管在可运行 Node/Fastify 且能连接 Postgres/Redis 的环境；Web 的 `API_BASE_URL` 指向该 API。真实 Riot RSO 上线前，还需取得 Production Key 和 RSO Client，把回调 URL 换成公网 HTTPS 地址并在 Riot 控制台登记。

## 产品边界

- 仅国际服、仅已完成竞技模式、仅当前授权玩家本人。
- 不保存 Riot 密码；密钥和 token 仅服务端保存。
- 不做向量 RAG、多 Agent、赛前对手侦察、实时对局指挥或作弊辅助。

这是公开演示仓库：内部交接、提示词、评测设计和开发工作流文档不随 GitHub 发布。
