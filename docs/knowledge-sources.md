# Haven / Ascent 教学知识来源登记

本批知识由离线采集器从四条登记视频的公开字幕/元数据自动生成草稿。生产检索只保存结构化知识块和来源元数据；视频、音频和完整转录留在 E 盘本地处理目录，不进入 PostgreSQL 或 Git。

| source_id | 地图 / 方向 | 来源 | 作者 | 发布时间登记 | 许可范围 | 版本状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `bili-haven-defense` | Haven / 防守 | [BV1tM4y1j7mE](https://www.bilibili.com/video/BV1tM4y1j7mE/) | 大东彦 | 2023-07-09 | 用户确认许可覆盖截图；视频和完整转录不入库 | `legacy-review`，需复核当前补丁 |
| `bili-haven-attack` | Haven / 进攻 | [BV1p94y1e7f4](https://www.bilibili.com/video/BV1p94y1e7f4/) | 大东彦 | 2023-08-01 | 用户确认许可覆盖截图；视频和完整转录不入库 | `legacy-review`，需复核当前补丁 |
| `bili-ascent-defense` | Ascent / 基础攻守 | [BV1gW4y1L7uw](https://www.bilibili.com/video/BV1gW4y1L7uw/) | 大东彦 | 2023-06-01 | 用户确认许可覆盖截图；视频和完整转录不入库 | `legacy-review`，需复核当前补丁 |
| `bili-ascent-attack` | Ascent / 进阶进攻 | [BV1RY411z7dV](https://www.bilibili.com/video/BV1RY411z7dV/) | 大东彦 | 2023-06-01 | 用户确认许可覆盖截图；视频和完整转录不入库 | `legacy-review`，需复核当前补丁 |

许可凭据当前登记为“用户确认”，不是平台或作者的独立书面授权证明。若公开发布前无法核验截图许可，应将对应 `knowledge_sources.status` 和 `knowledge_chunks.review_status` 改为 `pending`，不进入检索。审核状态、撤回时间、补丁状态和内容哈希由 PostgreSQL 保存；本地 Demo 为了验证完整闭环，可在明确操作后批量发布自动生成的草稿。

首批检索文本是从字幕片段自动切分并生成的地图通用教学背景；它不能证明玩家在某回合的站位、操作或意图。视频时间戳只作为离线追溯字段，不要求在产品页面展示；截图/视觉解析是可选增强，不影响纯字幕知识块进入本地检索。

## 字幕检查器

`apps/api-ts/src/knowledge-import.ts` 参考了 [moonmoonCL/bilibili-transcript](https://github.com/moonmoonCL/bilibili-transcript) 的 `yt-dlp` 优先、读取已有 AI 字幕的做法，并采用本项目更严格的边界：只接受上面四条已登记来源，使用 `--skip-download` 和 `--ignore-config`，不接收 Cookie，不把视频、字幕文件或完整转录写入 PostgreSQL。`tools/video-ingestion` 负责把字幕和元数据写入 E 盘私有 manifest，`knowledge:draft` 再生成待审核结构化知识块；审核通过后由 `knowledge:reindex` 写入 Qdrant 的 Dense/BM25 混合索引。运行 `knowledge:inspect` 仍可用于排查字幕来源，但不要求人工逐条标注视频。

该 GitHub 项目只适合作为提取策略参考：它依赖视频已有的 Bilibili AI 字幕，字幕不存在时由 E 盘采集器按配置的 ASR 降级处理。采集器不把临时视频/音频提交到仓库；Qdrant 只保存审核知识块的向量和元数据，PostgreSQL 负责最终审核状态过滤。
