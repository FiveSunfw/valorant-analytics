# Project Understanding

更新时间：2026-09-05

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

## 已完成闭环

脱敏 Fixture 会筛选已完成的竞技对局，以授权账号内部 ID 投递到 RabbitMQ。Worker 将原始 JSON、本人回合、击杀和伤害数据写入 PostgreSQL；重复投递通过数据库事务锁和约束保持幂等。ADR、ACS、K/D、爆头率和首死率已在独立领域包中实现并有 fixture 测试。

`apps/api-ts` 已提供不接受 PUUID 的当前用户只读工具：战绩概览、对局列表、回合证据。最终结论的结构要求引用指标或具体比赛/回合。

## 仍未完成

- Riot RSO 授权路由、token 刷新和账号解绑。OAuth state/session 表与 AES-256-GCM token 加密基础已建立。
- TypeScript Riot Match API 客户端已完成 mock 测试，但尚未接入真实 Worker 任务。
- HTTP 认证会话，将当前用户传入 API 工具边界。
- 模型调用适配层、产品 trace 持久化与 Eval 实测结果。
- 实际产品页面和完整指标维度。

## 下一步验收顺序

1. 实现 RSO 回调、账号绑定、token 加密和授权边界。
2. 将已测试的 Riot Match API 客户端接到现有 RabbitMQ Worker。
3. 接入模型调用与 trace 持久化，再执行 Agent Eval。
