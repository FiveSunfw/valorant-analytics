# Agent 实现检查点

- 版本：`1.0.0`
- 范围：仅 TypeScript Agent 实现
- 日期：2026-09-06

## 量化规则

进度按“已完成且通过测试的行为”计算，而不是按文件数量计算。只有验收测试通过，并且相关契约或 Trace 已记录，检查点才算完成。

## 检查点

| ID | 里程碑 | 权重 | 完成证据 |
| --- | --- | ---: | --- |
| C0 | TypeScript 契约和 Prompt Registry | 10% | Zod 契约、Registry 结构、契约测试 |
| C1 | 持久化多轮会话状态和记忆读写闭环 | 15% | 创建/恢复会话、Core/Recall 读取、候选记忆写入、范围变更和删除测试 |
| C2 | Supervisor 路由和受限 Agent Loop | 20% | 路由、最大步数、超时、拒答测试 |
| C3 | Stats、Death、Aim 专家发现 | 15% | 三个专家的 fixture 证据契约测试 |
| C4 | 首个端到端玩家分析 | 15% | “我最近为什么总是输？”返回经过验证的证据型答案 |
| C5 | Trace、Replay、成本和错误恢复 | 10% | 回放 fixture、脱敏 Trace、预算和重试测试 |
| C6 | 20 条多轮 Eval | 10% | 包含失败类型、延迟和成本字段的 Eval 报告 |
| C7 | Analytics MCP 适配器 | 5% | MCP schema、认证范围、结果限制和适配器测试 |

## 计算公式

```text
progress = 已完成检查点的权重之和
```

如果跳过测试、依赖真实密钥，或只是返回未经契约校验的模拟成功，检查点不能标记完成。

## 当前状态

```text
C0  TypeScript 契约和 Prompt Registry       契约完成；Registry 待完成
C1  持久化多轮会话状态和记忆读写闭环           未开始
C2  Supervisor 路由和受限 Loop               未开始
C3  Stats / Death / Aim 专家                 未开始
C4  首个端到端分析                           未开始
C5  Trace / Replay / 成本 / 恢复              未开始
C6  多轮 Eval                                未开始
C7  Analytics MCP 适配器                     未开始

当前进度：5%（契约完成；Prompt Registry 仍属于 C0）
```

## 已验证工作

TypeScript 契约切片已完成：

- `apps/api-ts/src/agent-contracts.ts` 统一维护 Zod 契约。
- 现有 analytics tools 复用统一的最终答案 schema。
- 契约测试覆盖会话状态、证据型声明、工具结果、事件和最终答案。
- API typecheck 通过。
- API 测试通过：15 个通过，1 个已有集成测试按配置跳过。

C0 剩余工作是版本化 Prompt Registry 和 Prompt 资产元数据。完成 Registry 契约测试后，C0 才达到 10%。

## 本阶段不包含

本清单只跟踪 TypeScript Agent 核心，不包含 Python 服务、知识入库、视频/OCR、pgvector 或真实 Riot API 凭据。

## C0 完成定义

- `apps/api-ts/src/agent/contracts.ts` 统一维护共享 Zod schema。
- 现有 analytics tools 导入共享最终答案 schema。
- 契约覆盖认证用户、会话范围、专家发现、工具结果、Agent 事件和最终答案。
- 非法证据、非法范围、不支持的事件类型和非法置信度必须校验失败。
- `npm run typecheck --workspace=@valorant/api` 通过。
- `npm run test --workspace=@valorant/api` 通过。
