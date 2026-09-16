# Haven / Ascent 教学知识来源登记

本批知识只保存编辑人员自写的短文案和来源元数据，不保存视频本体、完整转录或原始媒体。

| source_id | 地图 / 方向 | 来源 | 作者 | 发布时间登记 | 许可范围 | 版本状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `bili-haven-defense` | Haven / 防守 | [BV1tM4y1j7mE](https://www.bilibili.com/video/BV1tM4y1j7mE/) | 大东彦 | 2023-07-09 | 用户确认许可覆盖截图；视频和完整转录不入库 | `legacy-review`，需复核当前补丁 |
| `bili-haven-attack` | Haven / 进攻 | [BV1p94y1e7f4](https://www.bilibili.com/video/BV1p94y1e7f4/) | 大东彦 | 2023-08-01 | 用户确认许可覆盖截图；视频和完整转录不入库 | `legacy-review`，需复核当前补丁 |
| `bili-ascent-defense` | Ascent / 基础攻守 | [BV1gW4y1L7uw](https://www.bilibili.com/video/BV1gW4y1L7uw/) | 大东彦 | 2023-06-01 | 用户确认许可覆盖截图；视频和完整转录不入库 | `legacy-review`，需复核当前补丁 |
| `bili-ascent-attack` | Ascent / 进阶进攻 | [BV1RY411z7dV](https://www.bilibili.com/video/BV1RY411z7dV/) | 大东彦 | 2023-06-01 | 用户确认许可覆盖截图；视频和完整转录不入库 | `legacy-review`，需复核当前补丁 |

许可凭据当前登记为“用户确认”，不是平台或作者的独立书面授权证明。若公开发布前无法核验截图许可，应将对应 `knowledge_sources.status` 和 `knowledge_chunks.review_status` 改为 `pending`，不进入检索。

首批检索文本是自写的地图通用教学背景；它不能证明玩家在某回合的站位、操作或意图。点位级文案和截图文件需由编辑人员观看原视频后补录，补录前不得将其当作已核验的细节。视频时间戳仅作为可选的快速定位信息，不是知识点进入检索的必要条件。

## 字幕检查器

`apps/api-ts/src/knowledge-import.ts` 参考了 [moonmoonCL/bilibili-transcript](https://github.com/moonmoonCL/bilibili-transcript) 的 `yt-dlp` 优先、读取已有 AI 字幕的做法，并采用本项目更严格的边界：只接受上面四条已登记来源，使用 `--skip-download` 和 `--ignore-config`，不接收 Cookie，不把视频、字幕文件或完整转录写入 PostgreSQL。运行 `npm run knowledge:inspect --workspace=@valorant/api -- bili-haven-defense` 时，字幕只在当前进程内供编辑人员核对；最终仍须人工改写成带地图、攻守和适用条件的知识点，截图作为主要审核证据，时间戳可选。

该 GitHub 项目只适合作为提取策略参考：它依赖视频已有的 Bilibili AI 字幕，字幕不存在时不能替代人工观看或授权的语音转写。本仓库不引入 Whisper、视频下载或外部向量数据库。
