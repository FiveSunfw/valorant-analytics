# 数据模型与迁移

本项目的数据库以 Riot 官方 [VAL Match-v1](https://developer.riotgames.com/apis#val-match-v1) 的响应为源，而不是根据页面猜测字段。首个 TypeScript 基线迁移是 `20260905_0002`，由 `apps/migrate-ts` 或 Compose 的 `migrate` 服务运行。

## 为什么同时使用 JSONB 和规范化表

`matches.raw_payload` 保存原始 `MatchDto`，用于字段演进、重算和排错；它不会被直接送给 Agent。其余表只保存当前授权 Riot 账号的可查询证据，因此能支持指标、回合钻取和严格的用户范围查询。

| 官方 DTO | 保留位置 | 代表字段 |
| --- | --- | --- |
| `MatchInfoDto` | `matches` | `matchId`, `mapId`, `gameStartMillis`, `queueId`, `gameMode`, `isRanked`, `seasonId` |
| `RoundResultDto` | `match_rounds` | `roundNum`, `winningTeam`, `roundResult`, `plantRoundTime`, `plantLocation` |
| `PlayerDto` / `PlayerStatsDto` | `player_match_stats` | 当前账号的英雄、队伍、K/D/A、分数、时长、技能施放、段位 |
| `PlayerRoundStatsDto` | `player_round_stats` | 当前账号每回合分数、经济、技能效果 |
| `KillDto` | `round_kills` | 仅与当前账号有关的击杀/死亡/助攻、时间、终结伤害和武器 |
| `DamageDto` | `round_damage` | 当前账号的伤害和头/身/腿命中数 |

`riot_accounts.puuid` 只在服务端账号绑定和 Worker 内部使用，不能作为 Web API 或 Agent 工具参数。`riot_tokens` 仅存加密后的 token 字节，不记录明文 token。

## 竞技模式门槛

同步时先以 `MatchlistDto.history[].queueId == "competitive"` 减少详情请求；拿到 `MatchDto` 后，只有同时满足 `queueId == "competitive"`、`isRanked == true`、`isCompleted == true` 的比赛才可以进入上述分析表。这个策略统一定义在 `packages/domain`，并有 fixture 测试覆盖。

## 本机运行，容器托管数据库

```powershell
$docker = "C:\Users\abc18\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe"
& $docker compose up -d postgres redis
& $docker compose up -d rabbitmq
$env:DATABASE_URL = "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant"
D:\Nodejs\npm.cmd run build --workspace=@valorant/migrate
D:\Nodejs\npm.cmd run start --workspace=@valorant/migrate
```

Node 进程在本机运行；Docker 托管 PostgreSQL、Redis 和 RabbitMQ。Compose 内的 API、Worker、Web、`migrate` 放在 `containerized` profile，默认不会启动。本机 API 使用 `127.0.0.1:15432` 连接 PostgreSQL 容器，以避开被其他路径占用的宿主机 `5432`。

## 真实 API 冒烟测试

真实请求依赖用户在本地 `.env` 中设置 `RIOT_API_KEY`、完成 RSO 后保存的本人 PUUID，以及后续的 Worker 任务。自动化测试一律用 mock，不能把真实 key 或 token 放进测试、日志或聊天。
