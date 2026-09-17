# VALORANT Analytics

面向 VALORANT 国际服竞技玩家的个人赛后复盘 Agent。它只分析当前授权用户的已完成竞技对局，用确定性指标和可追溯的比赛/回合证据生成训练建议。


## 已实现

- Demo 登录：仅开发环境启用，固定 fixture 用户，不接受 PUUID 或任意玩家身份。
- Demo 同步闭环：登录后可创建同步任务并查看任务状态；Worker 的真实账号同步路径使用服务端账号绑定的 PUUID。
- 同段位基准：只从已有授权账号的竞技比赛生成去标识化聚合；样本不足时不显示群体结论。
- 训练记忆：使用 PostgreSQL 保存当前用户确认的训练目标和分析摘要，不使用 RAG 或向量数据库。
- 单 Agent 闭环：最近多场趋势、攻守、首死、地图，以及选定单局的赛后分析。
- 核心派生指标：Act/赛季、KAST、爆头率、首杀率、首死率和英雄维度；经济分析在官方回合经济字段存在时启用，否则明确标记不可用。
- 教学知识检索：Haven / Ascent 的审核知识点使用 PostgreSQL 全文检索；视频和完整转录不入库，知识证据与玩家比赛证据分开。
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
npm run knowledge:seed --workspace=@valorant/api

# 仅检查已登记视频的现有 Bilibili AI 字幕，不下载视频、不写入全文转录
npm run knowledge:inspect --workspace=@valorant/api -- bili-haven-defense

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

## 产品边界

- 仅国际服、仅已完成竞技模式、仅当前授权玩家本人。
- 不保存 Riot 密码；密钥和 token 仅服务端保存。
