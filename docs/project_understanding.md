# Project Understanding

更新时间：2026-09-16

## 当前调用链

```text
浏览器
  -> Next.js Web (:3000)
  -> Fastify API (:8000)
       -> PostgreSQL (:15432)
       -> Redis (:16379, 短期缓存)
       -> RabbitMQ (:5672)
            -> TypeScript Worker (prefetch=2)
                 -> Riot API（RSO 与真实同步尚未接入）
```

本机开发模式下，PostgreSQL、Redis 和 RabbitMQ 由 Docker 提供；Web、API、迁移程序和 Worker 使用本机 Node.js 运行。Python 原型保留在 `apps/api` 与 `apps/worker`，不再处于默认运行路径。

## 当前入口

| 模块 | 入口 | 当前职责 |
|---|---|---|
| Web | `apps/web/app/page.tsx` | TypeScript 前端入口，展示最小产品首页 |
| API | `apps/api-ts/src/main.ts` | Fastify 应用和 `/health` |
| Worker | `apps/worker-ts/src/main.ts` | RabbitMQ 消费者；失败重试和死信处理 |
| 领域核心 | `packages/domain/src` | DTO 校验、竞技过滤和确定性指标 |
| 迁移 | `apps/migrate-ts/src/main.ts` | PostgreSQL 幂等迁移 |
| 数据库 | `docker-compose.yml` | PostgreSQL 持久化到 `data/postgres` |
| 消息队列 | `docker-compose.yml` | RabbitMQ 同步任务、重试和死信队列 |

### 当前可演示单 Agent

Next.js 首页现在是本地单 Agent 演示页：登录固定 fixture、发送赛后问题、显示结论/证据/限制/建议、token 汇总和 runId。浏览器只访问 Next.js Route Handler；Handler 转发 Cookie 和 `Set-Cookie` 到 API，不把服务端模型密钥暴露给浏览器。

`POST /agent/analyze` 绑定当前产品会话，不接收 PUUID。`deepseek-flash` 只能调用注册的认证用户只读工具。模型 usage 累计写入响应和 `agent_runs`；模型、工具、预算和输出校验失败也会写 trace。`GET /agent/runs/:runId` 只能读取当前会话用户自己的脱敏 trace，不返回 prompt、工具原始 JSON 或密钥。

本地 demo 默认关闭。full fixture 有 6 场且含首死证据；small 有 2 场且没有首死证据；empty 没有比赛。`ENABLE_EVAL_MODE=true` 的本地评测入口只接受这三个固定 profile，不能传入玩家身份。

## 已完成闭环

脱敏 Fixture 会筛选已完成的竞技对局，以授权账号内部 ID 投递到 RabbitMQ。Worker 将原始 JSON、本人回合、击杀和伤害数据写入 PostgreSQL；重复投递通过数据库事务锁和约束保持幂等。ADR、ACS、K/D、爆头率和首死率已在独立领域包中实现并有 fixture 测试。

`apps/api-ts` 已提供不接受 PUUID 的当前用户只读工具：战绩概览、对局列表、回合证据。最终结论的结构要求引用指标或具体比赛/回合。

## 仍未完成

- Riot RSO 授权路由、token 刷新和账号解绑。OAuth state/session 表与 AES-256-GCM token 加密基础已建立。
- TypeScript Riot Match API 客户端已完成 mock 测试，但尚未接入真实 Worker 任务。
- HTTP 认证会话，将当前用户传入 API 工具边界。
- 真实 Riot 数据入口与完整指标维度；当前只用脱敏 fixture。
- 不做 RAG、多 Agent、赛前侦察、实时指挥或作弊辅助。

## 下一步验收顺序

1. 保持真实 scenario Eval 的回归，不扩展 RAG、多 Agent 或自动生成工具。
2. 取得授权后接入 RSO token refresh、账号仓储、Riot Match API 和 Worker sync。
3. 再决定是否引入专家 Agent，复用当前工具、证据、trace 和 Eval 契约。
