# 项目交接：中文维基百科机器人

本文件是给在 VS Code / WebStorm 中接续开发的编码助手阅读的项目事实和需求摘要。这里的信息可能过时，仅供参考，具体实现以代码和测试为准；不能假定助手能够看到此前的 ChatGPT 对话。

## 目标与范围

一个运行于中文维基百科的常驻 Node.js + TypeScript 机器人，当前仅在机器人用户页及机器人讨论页测试。正式批准及迁移是后续事项。三项任务：讨论页聊天、按请求评审条目/草稿、近期编辑疑似 AI 辅助内容的人工复核线索报告。公开措辞只描述疑似的客观问题，不针对编者作人格判断或确定性归因。

## 已决定的技术方案

- MediaWiki：`mwn`；事件模式可配置，中文维基百科默认 Wikimedia EventStreams，其他 API 地址默认通过 `list=recentchanges` 定期轮询机器人讨论页，也可以手工覆盖。轮询按时间窗口增量读取、分页、保留重叠并用修订记录去重（每个 tick 的处理任务经串行队列排队，因此轮询窗口上界固定为 *本次 tick 开始时刻*，避免队列积压期间新增的编辑被永久跳过）；EventStreams 保留 SSE checkpoint（同时记录 lastEventId 与 last_revid），并在 SSE 发生断线/错误时支持按 10/30/60/120/300 秒递增超时的自动重连与 `recentchanges` 遗漏编辑补偿机制（过滤 bot 编辑，向上游提供与 SSE 相同的 ChangeEvent 数据结构）。跨站点使用不同 SQLite 文件。
- LLM：Vercel AI SDK，provider 配置选择 OpenAI 或 Google；不自建 provider 框架。
- SQLite + Node 原生 `node:sqlite` (`DatabaseSync`) + 裸 SQL，不使用 ORM。基于 `schema_migrations` 表实现增量 migration 模式管理 schema 版本（支持 timestamp 格式版本号）；`events` 表维护输入/输出 token 与模型记录；`error_logs` 表统一持久化异常日志。YAML + Zod 配置，Pino 日志，Vitest 测试。密钥放环境变量，不写进 Git。
- 优先现成库；仅在维基语义、业务规则、任务路由处写定制逻辑。
- LLM 输出不得直接授予编辑权限；写入目标、命名空间、紧急停止和业务额度由确定性代码检查。

## 任务一：讨论页聊天

从机器人讨论页的 revision 获取实际编辑者 user_id；签名仅是文本，不用于认证。排除机器人自己及机器人账户；通过差异分析与修订时间戳（支持中文维基与 publictestwiki 等格式配置）区分新留言与格式整理/历史文本修改，允许编者在讨论页任意位置/中间插话。支持二级标题（Level 2 header）章节识别与多人会话结构化解析：对章节历史与当前留言进行结构化提取（识别各留言者 author、签名/修订时间戳 time、缩进层级 indent 及去除签名噪声的正文），以结构化 XML 标签提供给大模型，使模型清晰分辨“哪句话是谁在何时说的”；并在对应的二级标题章节就地安全追加回复。读取机器人用户页的 persona/control 设置，按 user_id 保存近期对话记忆，回复后保存来源与回复 revision、模型使用情况，避免重复回复。留言的修订时间戳超过 30 分钟（`MAX_REPLY_AGE_MS`）即视为过期，直接跳过不再尝试回复（避免 SSE 断线补偿或积压事件触发对陈旧留言的应答）。控制页面的 emergencyStop 在编辑层生效。

## 任务二：条目辅助校对

通过标准模板 `{{User:AmanojakuBot/template/ReviewRequest | article = 条目名 | status = ...}}` 在配置的讨论页（`tasks.review.talkPage`，如 `User talk:AmanojakuBot/review`）二级标题章节中接收校对请求。每个二级标题章节有且仅有一个请求。请求者身份由触发 revision 的编辑者与签名用户双重校验。支持正式条目（命名空间 0）及配置的草稿命名空间（如 `draftNamespace: [2, 118]`）。页面不存在、名字空间不支持、页面内容为空或明显非百科全书条目（如系统测试、沙盒涂鸦、胡言乱语、破坏、程序代码、用户个人页面、用户个人论述）时将模板标记为 `status = not done` 并说明原因。用户按 UTC 自然日限制每日成功请求上限（`userDailyLimit`），超额标记为 `not done`。校对绑定固定 revision ID，从配置的 `rulePage` 读取校对规则（不使用任务一人格），通过 LLM 结构化输出（Zod schema）中立客观生成校对摘要与问题列表，按 `<talkPage>/<name>` 独立写入结果页并追加唯一日期章节与警告文案，成功写入后更新请求模板为 `status = done`（`resultpage` 参数写入结果页完整页面名，含命名空间与子页面前缀；`section` 参数写入结果页章节标题）并 ping 用户。引入请求互斥锁机制（按 `talkPage#sectionTitle` 及 `revid` 加锁并支持超时回收），防止 RC 轮询、SSE 重连补偿及定期清理等多路并发触发重复校对。提供兜底机制：机器人启动时先执行一次，之后按 `tasks.review.cleanupCron`（cron 表达式，UTC 时区，默认每小时整点）自动扫描讨论页中因网络抖动或异常遗漏的积压请求并补处理（AfC 任务同理，由 `tasks.afc.cleanupCron` 调度）。兜底扫描只处理请求模板 `status` 为空的章节：只要模板已写入任何非空 `status`，即视为该章节已被处理过，不再补处理，也不会改写其模板参数与回复内容。事件流入口在写入前还会回到「当前页面」复核该请求模板是否已处理：若当前页面上的同一请求模板已终结（或模板已不存在），则直接跳过，防止位点回放或并发实例重复发送完整评审与重复回复。章节重定位（`findMatchingSection`）按「完整留言 → 签名时间戳锚点 → 首行（仅无签名时）→ 同名未处理模板 → 章节序号」优先级匹配：留言签名行的时间戳唯一，即使机器人已回填模板参数导致留言不再逐字命中，也不会误落到同名的旧章节。

## 任务三：疑似 AI 编辑线索

分两部分：

- **3-1 动态扫描**：按 `tasks.aiEdit.cron`（cron 表达式，UTC 时区，默认每小时整点）用 MediaWiki RecentChanges API 扫描自上次 checkpoint 以来的编辑（周期超过单次 API 时间跨度上限时自动拆分为多段查询）。只保留纯条目命名空间（ns 0）的 edit/new；忽略机器人/机器用户与匿名 IP 编辑，忽略标签为 AWB、Twinkle、回退功能的编辑；单条 diff 净增加量 < 100 字节的排除；同一条目的多次编辑按条目名称合并，**一个条目一轮只送检一次**（该条目的全部差异合并为同一次 LLM 请求）。送检内容为「全部差异 + 完整条目正文」：差异由 API 读取（`+`/`-` 行），正文为该条目当前版本；若该条目（按规范化条目名）在 24 小时内已连同完整正文送检过（记录在 `ai_edit_sends` 表），或正文长度超过 `MAX_ARTICLE_CHARS`，则只送差异（降级模式，模型看不到条目其余部分）。按 `tasks.aiEdit.rulePage` 规则由 LLM 输出结构化线索（线索强度、问题概述、位置、具体证据、分析、其他合理解释、建议核查、所属差异修订号、整体线索强度 `confidence`），由程序拼接文字追加到 `tasks.aiEdit.debugLog`（Markdown）。`confidence` 是**整体线索强度**（越大越指向疑似 AI 辅助编辑），不是「使用 AI 的概率」也不是「对结论的确定度」；`issues` 为空时程序强制归零，无线索记录不得公开。`silent = false` 时再写维基：`reportPagePrefix/YYYY-MM`（按扫描时间设二级标题、条目设三级标题、`{{anchor|紧凑时间+条目名}}` 锚点、`{{La}}` 整理条目相关链接、Diff 逐条列出）与 `usersPage`（同一编者在 ≥3 个不同规范化条目中出现达到 `minConfidence` 的线索时，在 `== YYYY-MM ==` 章节下合并/追加编者行）；发布与 checkuser 汇总都额外要求记录中确实存在线索（否则即使 `confidence` 很高也不公开）。`silent` 默认 true（仅写本地日志）。3-2 请求结果亦不计入 3-1 的 check 页发布。
- **3-2 疑似 AI 分析**：监听 `tasks.aiEdit.talkPage` 上使用 `tasks.aiEdit.template` 的请求章节（工作流类似 afc），支持 `article1`、`article2`……`article20` 参数（条目名，可为正式条目，也可为 `tasks.aiEdit.draftNamespace` 允许的草稿命名空间，默认 `[2, 118]`，与任务二/任务四一致；3-1 扫描仍仅处理条目 ns 0）以及 `diff` / `diff1`、`diff2`……`diff20` 参数（裸修订号或 `[[Special:Diff/修订号]]`，双版本形式 `[[Special:Diff/A/B]]` 以 B 为目标、A 为基准）。送检前先按规范化条目名把 article 与 diff 参数合并：**同一条目只分析一次，其全部差异合并为同一次请求**（送检与出报告都是「同一条目、不同 diff」）；无法识别的参数、不存在/不可读取的修订或命名空间不受支持的页面会如实列入结果页与日志。命名空间、24 小时完整正文复用窗口与降级规则同 3-1（同一张 `ai_edit_sends` 表；但若本次没有任何差异可送，则仍送完整条目，否则请求没有可判断的内容）。按任务（日期 + 提交人用户名）汇总到同一结果页；结果页用 `{{La}}` 整理条目相关链接并按送检差异逐条列出 Diff，页面展示可疑之处，作为发起 AI 调查的初步分析线索，不代表确认或否认此人滥用 AI。

把判定当作人工复核线索，不将模型概率视为证明，也不要求公开内部推理过程。

## 当前仓库状态（milestone 2）

当前代码已接入三项任务：讨论页聊天（支持插话识别、签名时间戳匹配、二级标题多人会话上下文与就地章节回复）；根据评审链接解析、目标有效性及 UID/UTC 额度记录生成回复；任务三的 3-1 定期动态扫描（按条目聚合其全部差异、一次送检、结构化线索、本地 debugLog 与可选 check/checkuser 发布）与 3-2 模板请求式疑似 AI 分析（article1…article20 + diff1…diff20，按条目合并为「同一条目、不同 diff」后一次送检）。两条链路都送「差异 + 完整条目」，并在 24 小时内复用已送检的完整正文（`ai_edit_sends` 表），超出窗口或正文过长时降级为只送差异。代码已补充完备的详细业务与防误报/安全注释。真实编辑由显式 `writeEnabled: true` 控制，默认 dry-run；尚未在真实站点端到端验证。任务三默认关闭，需显式开启。所有输出只写机器人的讨论页或指定用户子页。评审文本截断、差异文本总量截断、非穷尽的近期变更筛选和过期 SSE checkpoint 缺乏 API 补洞仍是已知限制。不要描述为生产可用。

### 代码目录架构

- `src/index.ts`：系统常驻守护进程入口，负责配置加载、数据库与维基客户端初始化、串行任务队列、统一变更事件监听调用与 cron 定时任务登记。事件监听不区分底层驱动，只调用一次 `startChangeFeed({ mode, cfg, db, bot, log, enqueue, onEvent })`。
- `src/handle.ts`：变更事件主路由分发器，采用可插拔责任链流水线模式调度各任务 Handler（`[chatHandler, reviewHandler, aiEditHandler, afcHandler]`），支持按 `intercepted` 拦截与错误捕获。
- `src/config/`：配置契约与加载器（`src/config/index.ts`），基于 YAML + Zod 严格校验（含 cron 表达式校验）；Chat 和 Review 任务支持配置在独立的机器人讨论页中运行。
- `src/utils/`：通用基础设施与工具模块（`db.ts` SQLite存储、`wiki.ts` MediaWiki客户端交互（页面读取、修订元数据与修订差异 `revisionDiff`）、`llm.ts` 大模型调用、`wikitext.ts` 维基文本与讨论页解析、`requestWorkflow.ts` 讨论页模板请求工作流（章节定位 / 请求模板提取 / 请求互斥锁 / 状态回报与回复 / 积压请求兜底扫描 / `createTemplateRequestHandler` 处理器工厂，供任务二、任务三 3-2、任务四共用）、`articleReview.ts` 条目审核流水线（固定版本快照校验、规则页拆分、两阶段审核引擎（全局检查 + 可选局部 Chunk 扫描 + 去重/语义合并）、结果页写入、请求拒绝回报，供任务二 / 任务四共用，任务三 3-2 复用其中的快照与回报能力）、`polling.ts` 近期变更轮询与轮询驱动、`eventstream.ts` EventStreams SSE 驱动、`changeFeed.ts` 两种驱动的统一入口、`schedule.ts` cron 定时调度）。
- `src/tasks/`：机器人任务模块，各独立一文件并暴露各自的 `TaskHandler`：
  - `src/tasks/chat.ts`：任务一（讨论页自由对话与章节多用户上下文应答，默认运行在 `User talk:Bot`）
  - `src/tasks/review.ts`：任务二（应请求条目/草稿校对评审，采用“全文全局检查 + 导言/二级/三级标题 Chunk 分块局部高覆盖率扫描 + 确定性/语义去重合并”流水线，与额度管控相配合，默认运行在 `User talk:Bot/review`；审核流水线与章节/模板/锁/回报等交互流程分别复用 `utils/articleReview` 与 `utils/requestWorkflow`）
  - `src/tasks/aiEditMonitor.ts`：任务三（3-1 定期动态扫描：按条目聚合近期条目编辑及其差异、结构化疑似线索、本地 debugLog 与可选 check/checkuser 发布）；同时维护 3-1/3-2 共用的线索判定契约（Zod schema、中立性系统提示词、规则页加载、差异/正文送检输入与单次分析、24 小时完整正文复用窗口 `ai_edit_sends`、Diff 链接渲染）
  - `src/tasks/aiEditReview.ts`：任务三（3-2 模板请求式疑似 AI 分析，支持 article1…article20 与 diff1…diff20，按规范化条目名合并为「同一条目、不同 diff」后每个条目只送检一次并汇总结果页；交互流程复用 `utils/requestWorkflow`，条目快照与请求回报复用 `utils/articleReview`；当前按条目单次判定、不拆章节细查，审核引擎的 `chunkEnabled` 开关保留了后续启用局部扫描的能力）
  - `src/tasks/afc.ts`：任务四（新手条目发布前评审；审核流水线复用 `utils/articleReview`，交互流程复用 `utils/requestWorkflow`；规则页声明“局部扫描 未启用”时仅做全局评审）

## 文档

`README.md` 为面向中文读者的使用说明，包含：项目概述、本地安装（`npm i` / `.env` 与 `config.yaml` / `npm run start`）、Toolforge 部署（`toolforge envvars create` / `build start` / `jobs run`）、热更新（`build start` + `jobs restart`）、代码结构，以及各功能概述与代码入口。

## 继续开发建议

从项目根目录阅读 README、代码和本文件。开发者偏好手工端到端验收，不强制或新增自动化测试；可运行 `npm run check` 做静态类型检查。先在可控的机器人测试页面以 dry-run 核对，再在显式打开写入后手工核查真实编辑，尤其是 API 响应形状、机器人账号过滤、断线恢复、幂等、额度及报告的误报。同步更新本文件中的当前状态与未完成事项。
