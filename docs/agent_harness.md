# Agent Runtime 设计

## 选择

第一版使用 TypeScript 模型 provider 适配层提供 Agent loop、工具调用、最大轮数、provider trace、session 和 guardrail 接口。项目不维护通用 Agent runtime；只暴露受认证用户范围约束的产品工具。

这符合当前需求：服务端拥有领域工具、权限和数据存储；SDK 负责受约束的 Agent 生命周期。只有需要自定义状态图、人工审批暂停和跨流程恢复时，才评估 LangGraph。

## 责任边界

| 能力 | 所有者 |
|---|---|
| 模型调用和循环 | OpenAI Agents SDK `Runner` |
| 工具 schema 和调用 | SDK function tools + Python/Pydantic 类型 |
| 最大轮数、streaming、session、SDK trace | OpenAI Agents SDK |
| 玩家本人权限和竞技模式强制过滤 | 本项目领域工具层 |
| 指标、比赛和回合证据查询 | 本项目确定性分析层 |
| 产品 trace、延迟、token 和成本入库 | 本项目服务层 |
| Riot token 和 RSO secret | Fastify/Worker 服务端，永不传入 Agent |

## Agent Context

每次运行把已认证的产品用户传给 SDK context。工具从 context 取得用户身份，绝不把任意 PUUID 设计为模型可控参数。

```text
AuthenticatedUser
  -> SDK RunContext
       -> get_player_summary / get_match_list / get_round_evidence
            -> query current user + competitive data only
```

## 输出契约

Agent 最终输出必须由 Pydantic 模型校验，至少包含：`conclusion`、`evidence`、`confidence`、`recommendations`、`limitations`。工具结果必须返回结构化数据、样本数、时间范围和限制说明。

## 第一版工具顺序

1. `get_player_summary`
2. `get_match_list`
3. `get_round_evidence`

先完成单问题闭环，再扩展地图、英雄、攻守和同段位基准工具。
