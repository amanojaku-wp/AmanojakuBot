# 项目交接：中文维基百科机器人

本文件是给在 VS Code / WebStorm 中接续开发的编码助手阅读的项目事实和需求摘要。这里的信息可能过时，仅供参考，具体实现以代码和测试为准；不能假定助手能够看到此前的 ChatGPT 对话。

## 目标与范围

一个运行于中文维基百科的常驻 Node.js + TypeScript 机器人，当前仅在机器人用户页及机器人讨论页测试。正式批准及迁移是后续事项。三项任务：讨论页聊天、按请求评审条目/草稿、近期编辑疑似 AI 辅助内容的人工复核线索报告。公开措辞只描述疑似的客观问题，不针对编者作人格判断或确定性归因。

## 已决定的技术方案

- MediaWiki：`mwn`；事件模式可配置，中文维基百科默认 Wikimedia EventStreams，其他 API 地址默认通过 `list=recentchanges` 定期轮询机器人讨论页，也可以手工覆盖。轮询按时间窗口增量读取、分页、保留重叠并用修订记录去重；EventStreams 保留 SSE checkpoint（同时记录 lastEventId 与 last_revid），并在 SSE 发生断线/错误时支持按 10/30/60/120/300 秒递增超时的自动重连与 `recentchanges` 遗漏编辑补偿机制（过滤 bot 编辑，向上游提供与 SSE 相同的 ChangeEvent 数据结构）。跨站点使用不同 SQLite 文件。
- LLM：Vercel AI SDK，provider 配置选择 OpenAI 或 Google；不自建 provider 框架。
- SQLite + Node 原生 `node:sqlite` (`DatabaseSync`) + 裸 SQL，不使用 ORM。基于 `schema_migrations` 表实现增量 migration 模式管理 schema 版本（支持 timestamp 格式版本号）；`events` 表维护输入/输出 token 与模型记录；`error_logs` 表统一持久化异常日志。YAML + Zod 配置，Pino 日志，Vitest 测试。密钥放环境变量，不写进 Git。
- 优先现成库；仅在维基语义、业务规则、任务路由处写定制逻辑。
- LLM 输出不得直接授予编辑权限；写入目标、命名空间、紧急停止和业务额度由确定性代码检查。

## 任务一：讨论页聊天

从机器人讨论页的 revision 获取实际编辑者 user_id；签名仅是文本，不用于认证。排除机器人自己及机器人账户；通过差异分析与修订时间戳（支持中文维基与 publictestwiki 等格式配置）区分新留言与格式整理/历史文本修改，允许编者在讨论页任意位置/中间插话。支持二级标题（Level 2 header）章节识别与多人会话结构化解析：对章节历史与当前留言进行结构化提取（识别各留言者 author、签名/修订时间戳 time、缩进层级 indent 及去除签名噪声的正文），以结构化 XML 标签提供给大模型，使模型清晰分辨“哪句话是谁在何时说的”；并在对应的二级标题章节就地安全追加回复。读取机器人用户页的 persona/control 设置，按 user_id 保存近期对话记忆，回复后保存来源与回复 revision、模型使用情况，避免重复回复。控制页面的 emergencyStop 在编辑层生效。

## 任务二：条目辅助校对

通过标准模板 `{{User:AmanojakuBot/template/ReviewRequest | article = 条目名 | status = ...}}` 在配置的讨论页（`tasks.review.talkPage`，如 `User talk:AmanojakuBot/review`）二级标题章节中接收校对请求。每个二级标题章节有且仅有一个请求。请求者身份由触发 revision 的编辑者与签名用户双重校验。支持正式条目（命名空间 0）及配置的草稿命名空间（如 `draftNamespace: [2, 118]`）。页面不存在、名字空间不支持、页面内容为空或明显非百科全书条目（如系统测试、沙盒涂鸦、胡言乱语、破坏、程序代码、用户个人页面、用户个人论述）时将模板标记为 `status = not done` 并说明原因。用户按 UTC 自然日限制每日成功请求上限（`userDailyLimit`），超额标记为 `not done`。校对绑定固定 revision ID，从配置的 `rulePage` 读取校对规则（不使用任务一人格），通过 LLM 结构化输出（Zod schema）中立客观生成校对摘要与问题列表，按 `<talkPage>/<name>` 独立写入结果页并追加唯一日期章节与警告文案，成功写入后更新请求模板为 `status = done` 并 ping 用户。引入请求互斥锁机制（按 `talkPage#sectionTitle` 及 `revid` 加锁并支持超时回收），防止 RC 轮询、SSE 重连补偿及定期清理等多路并发触发重复校对。提供兜底机制：机器人启动时及每隔 1 小时自动扫描讨论页中因网络抖动或异常遗漏的积压请求并补处理。

## 任务三：疑似 AI 编辑线索

监听条目和草稿近期变更；按每 6 小时不快于一次的频率向指定机器人用户页汇总：用户名、diff、具体短摘录/可核查判据、置信度和记录 anchor。一个用户在至少三个不同条目（同名条目与草稿视为同一条目）出现疑似记录时，加入第二个机器人用户页并链接对应三条记录。把判定当作人工复核线索，不将模型概率视为证明，也不要求公开内部推理过程。

## 当前仓库状态（milestone 2）

当前代码已接入三项任务：讨论页聊天（支持插话识别、签名时间戳匹配、二级标题多人会话上下文与就地章节回复）；根据评审链接解析、目标有效性及 UID/UTC 额度记录生成回复；文章/草稿新增文本的有限额 AI 复核线索、月度报告及三篇不同条目的用户页汇总。代码已补充完备的详细业务与防误报/安全注释。真实编辑由显式 `writeEnabled: true` 控制，默认 dry-run；尚未在真实站点端到端验证。任务三默认关闭，需显式开启。所有输出只写机器人的讨论页或指定用户子页。评审文本截断、非穷尽的近期变更筛选和过期 SSE checkpoint 缺乏 API 补洞仍是已知限制。不要描述为生产可用。

### 代码目录架构

- `src/index.ts`：系统常驻守护进程入口，负责配置加载、数据库与维基客户端初始化、事件驱动监听（EventStreams SSE / RecentChanges 轮询）与定时任务调度。
- `src/handle.ts`：变更事件主路由分发器，采用可插拔责任链流水线模式调度各任务 Handler（`[chatHandler, reviewHandler, aiEditHandler]`），支持按 `intercepted` 拦截与错误捕获。
- `src/config/`：配置契约与加载器（`src/config/index.ts`），基于 YAML + Zod 严格校验；Chat 和 Review 任务支持配置在独立的机器人讨论页中运行。
- `src/utils/`：通用基础设施与工具模块（`db.ts` SQLite存储、`wiki.ts` MediaWiki客户端交互、`llm.ts` 大模型调用、`polling.ts` 近期变更轮询、`wikitext.ts` 维基文本与讨论页解析）。
- `src/tasks/`：三大机器人任务模块，各独立一文件并暴露各自的 `TaskHandler`：
  - `src/tasks/chat.ts`：任务一（讨论页自由对话与章节多用户上下文应答，默认运行在 `User talk:Bot`）
  - `src/tasks/review.ts`：任务二（应请求条目/草稿校对评审，采用“全文全局检查 + 导言/二级/三级标题 Chunk 分块局部高覆盖率扫描 + 确定性/语义去重合并”流水线，与额度管控相配合，默认运行在 `User talk:Bot/review`）
  - `src/tasks/aiEdit.ts`：任务三（疑似 AI 辅助编辑初筛、6小时UTC聚合线索报告与三篇跨条目用户汇总）

## 继续开发建议

从项目根目录阅读 README、代码和本文件。开发者偏好手工端到端验收，不强制或新增自动化测试；可运行 `npm run check` 做静态类型检查。先在可控的机器人测试页面以 dry-run 核对，再在显式打开写入后手工核查真实编辑，尤其是 API 响应形状、机器人账号过滤、断线恢复、幂等、额度及报告的误报。同步更新本文件中的当前状态与未完成事项。
