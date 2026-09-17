# VALORANT Analytics

面向 VALORANT 国际服竞技玩家的个人赛后复盘 Agent。用户登录 Demo 或完成授权后，可以直接用一个统一提问框询问最近表现、单局问题、地图打法、训练目标、同段位比较和教学知识；内置 Supervisor 会按问题选择最小必要的 Stats、Death、Map、Economy、Aim、Memory 专家，并把比赛证据、用户记忆和教学知识分开呈现。

## 已实现能力

- 内置多专家编排：Supervisor 按意图选择最少的 Stats、Death、Map、Economy、Aim、Memory 专家；各专家只能调用自己的只读工具白名单，统一受专家数、总工具调用数和单次超时限制。
- 统一提问入口：用户可以询问趋势、地图、攻守、首死、训练目标、同段位比较、Act、英雄、经济局、时间窗口和地图教学；最终由 Supervisor 将专家观察结果合成为一个可追溯答案。
- Demo 登录与同步闭环：固定脱敏 fixture 用户可创建同步任务、查看状态并读取比赛；同步任务使用内部账号 ID，不接受任意 PUUID。
- 确定性指标与证据：只读取当前用户已完成竞技比赛，缺失字段和小样本明确返回限制，不用零值伪造结论。
- 去标识化同段位基准：只有满足最低样本门槛时才返回群体结论。
- 长期训练记忆：用户确认的训练目标和分析摘要先保存到 PostgreSQL，再同步到 Mem0；Agent 按当前问题语义召回当前账号记忆，Mem0 不可用时自动降级到 PostgreSQL，编辑、删除和断开账号会清理对应记忆。
- 混合知识检索：审核状态、撤回状态和补丁状态由 PostgreSQL 过滤；Qdrant 支持本地 Qwen Embedding、BM25、RRF 和可选 Rerank，故障时降级到 PostgreSQL 全文检索。
- 安全边界：Agent 不执行 SQL、不读取原始 Match JSON 作为答案依据、不接受其他玩家身份、不推断站位、准星、意图或隐藏 MMR/ELO。
- Trace 与 Eval：完成运行状态、工具调用、Token、成本、延迟和错误分类记录；`eval/cases.jsonl` 覆盖正常分析、权限拒绝、小样本、基准、记忆、知识检索和指标路由。

## 本地运行

前置条件：Node.js 22、Docker Desktop，以及项目根目录未提交的 `.env`。真实模型需要配置 `DEEPSEEK_API_KEY`；没有密钥时会使用确定性模型完成本地流程测试。配置 `MEM0_API_KEY` 后启用 Mem0 语义长期记忆；不配置时仍使用 PostgreSQL 本地记忆。

```powershell
docker compose up -d postgres redis rabbitmq
npm install
npm run build --workspace=@valorant/migrate
npm run start --workspace=@valorant/migrate
npm run demo:seed --workspace=@valorant/api
npm run knowledge:seed --workspace=@valorant/api

# 可选：从四条已登记视频读取字幕并生成知识草稿
npm run knowledge:extract --workspace=@valorant/api -- bili-haven-defense
npm run knowledge:draft --workspace=@valorant/api -- bili-haven-defense

# Qdrant + 本地 Qwen Embedding 已配置时重建索引
npm run knowledge:reindex --workspace=@valorant/api

$env:ENABLE_DEMO_MODE = "true"
npm run start --workspace=@valorant/api
```

另开终端启动 Web：

```powershell
npm run dev --workspace=@valorant/web -- -p 3000
```

- Web：`http://localhost:3000`
- API：`http://localhost:8000/health`
- Qdrant：由本地 Docker Compose 或 E 盘开发环境提供
- 本地 Embedding：`http://127.0.0.1:18090`

## 验证

```powershell
npm run typecheck
npm run test --workspace=@valorant/api
npm run test --workspace=@valorant/worker
npm run build --workspace=@valorant/web
npm run eval --workspace=@valorant/api
```

集成测试默认跳过，依赖 Docker 服务时显式运行：

```powershell
$env:RUN_INTEGRATION_TESTS = "1"
npm run test --workspace=@valorant/api
npm run test --workspace=@valorant/worker
```

测试 case 的设计理由见 [docs/evaluation-cases.md](docs/evaluation-cases.md)。

## 产品边界

- 仅国际服、仅已完成竞技模式、仅当前授权玩家本人。
- 不保存 Riot 密码；密钥、access token 和 refresh token 只保存在服务端环境。
- 教学知识是通用训练背景，不能证明玩家在某个回合的实际站位、操作或意图。
- Demo fixture 用于审核和本地复现，不计入真实用户的同段位基准。
