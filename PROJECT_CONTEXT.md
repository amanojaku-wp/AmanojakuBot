# 项目交接：中文维基百科机器人

本文件是给在 VS Code / WebStorm 中接续开发的编码助手阅读的项目事实和需求摘要。这里的信息可能过时，仅供参考，具体实现以代码和测试为准；不能假定助手能够看到此前的 ChatGPT 对话。下面「目标与范围」到「任务三」描述**现状**；「变更历史」一节保留每次改动的决策依据与线上踩坑。

## 目标与范围

一个运行于中文维基百科的常驻 Node.js + TypeScript 机器人，当前仅在机器人用户页及机器人讨论页测试。正式批准及迁移是后续事项。四项任务（代码里各有一条讨论页入口；任务四与任务二共用同一套审核流水线、请求模板与回报机制，只是讨论页、规则页与每日额度不同）：任务一 讨论页聊天、任务二 按请求评审条目/草稿、任务三 近期编辑疑似 AI 辅助内容的人工复核线索报告、任务四 新手条目发布前评审（AfC）。公开措辞只描述疑似的客观问题，不针对编者作人格判断或确定性归因。

## 已决定的技术方案

- MediaWiki：`mwn`；事件模式可配置，中文维基百科默认 Wikimedia EventStreams，其他 API 地址默认通过 `list=recentchanges` 定期轮询机器人讨论页，也可以手工覆盖。轮询按时间窗口增量读取、分页、保留重叠并用修订记录去重（每个 tick 的处理任务经串行队列排队，因此轮询窗口上界固定为 _本次 tick 开始时刻_，避免队列积压期间新增的编辑被永久跳过）；EventStreams 保留 SSE checkpoint（同时记录 lastEventId 与 last_revid），并在 SSE 发生断线/错误时支持按 10/30/60/120/300 秒递增超时的自动重连与 `recentchanges` 遗漏编辑补偿机制（过滤 bot 编辑，向上游提供与 SSE 相同的 ChangeEvent 数据结构）。跨站点使用不同 SQLite 文件。
- 并发模型（认领 / 执行分离）：驱动层保留一条**极短的串行认领队列**，只负责「归属判定 + 幂等校验 + 事件位点推进 + 认领落库（`events.state = claimed` + 原始事件载荷）」；LLM 调用与维基写入等重活交给**键控有界并发工作队列**（`utils/workQueue`）：同一讨论页同一章节严格串行（保证页面读-改-写不互相覆盖），不同页面/章节按 `runtime.workConcurrency` 并行。并发已满时任务**排队等待而非丢弃**；认领即落库使「位点推进」与「工作完成」解耦后仍可恢复，进程重启时由 `handle.recoverUnfinishedEvents` 重派（dry-run 下无持久副作用，直接跳过）。同一维基页面的写入（请求章节回报、结果页「读现有章节 → 生成唯一标题 → 全量写回」）经 `utils/pageWriteLock` 串行化，避免丢更新与编辑冲突。LLM 侧另有全局闸门：`runtime.llmMaxConcurrent` 限并发、`runtime.llmTimeoutSeconds` 限单次调用时长。
- LLM：Vercel AI SDK，provider 配置选择 OpenAI 或 Google；不自建 provider 框架。
- SQLite + Node 原生 `node:sqlite` (`DatabaseSync`) + 裸 SQL，不使用 ORM。基于 `schema_migrations` 表实现增量 migration 模式管理 schema 版本（支持 timestamp 格式版本号）；`events` 表维护输入/输出 token 与模型记录；`error_logs` 表统一持久化异常日志。YAML + Zod 配置，Pino 日志，Vitest 测试。密钥放环境变量，不写进 Git。
- 优先现成库；仅在维基语义、业务规则、任务路由处写定制逻辑。
- LLM 输出不得直接授予编辑权限；写入目标、命名空间、紧急停止和业务额度由确定性代码检查。

## 任务一：讨论页聊天

从机器人讨论页的 revision 获取实际编辑者 user_id；签名仅是文本，不用于认证。排除机器人自己及机器人账户；通过差异分析与修订时间戳（支持中文维基与 publictestwiki 等格式配置）区分新留言与格式整理/历史文本修改，允许编者在讨论页任意位置/中间插话。支持二级标题（Level 2 header）章节识别与多人会话结构化解析：对章节历史与当前留言进行结构化提取（识别各留言者 author、签名/修订时间戳 time、缩进层级 indent 及去除签名噪声的正文），以结构化 XML 标签提供给大模型，使模型清晰分辨“哪句话是谁在何时说的”；并在对应的二级标题章节就地安全追加回复。读取机器人用户页的 persona/control 设置，按 user_id 保存近期对话记忆，回复后保存来源与回复 revision、模型使用情况，避免重复回复。留言的修订时间戳超过 30 分钟（`MAX_REPLY_AGE_MS`）即视为过期，直接跳过不再尝试回复（避免 SSE 断线补偿或积压事件触发对陈旧留言的应答）。回复在写入前会校验其中的维基代码（`[[ ]]`、`{{ }}`）与 HTML 标签是否闭合：已闭合的 HTML 注释、`<nowiki>`/`<source>`/`<syntaxhighlight>`/`<math>`/`<score>`/`<pre>` 标签及其内部内容、以及自闭合标签与空元素均跳过；未闭合的标签与未闭合的注释则把开符号转义为 `&lt;`/`&gt;` 这类 HTML entity（维基代码开符转义为 `&#91;`/`&#123;`），避免未闭合语法吞掉其后整段页面内容。控制页面的 emergencyStop 在编辑层生效。

## 任务二：条目辅助校对

通过标准模板 `{{User:AmanojakuBot/template/ReviewRequest | article = 条目名 | status = ...}}` 在配置的讨论页（`tasks.review.talkPage`，如 `User talk:AmanojakuBot/review`）二级标题章节中接收校对请求。每个二级标题章节有且仅有一个请求。请求者身份由触发 revision 的编辑者与签名用户双重校验。支持正式条目（命名空间 0）及配置的草稿命名空间（如 `draftNamespace: [2, 118]`）。页面不存在、名字空间不支持、页面内容为空或明显非百科全书条目（如系统测试、沙盒涂鸦、胡言乱语、破坏、程序代码、用户个人页面、用户个人论述）时将模板标记为 `status = not done` 并说明原因。用户按 UTC 自然日限制每日成功请求上限（`userDailyLimit`），超额标记为 `not done`。校对绑定固定 revision ID，从配置的 `rulePage` 读取校对规则（不使用任务一人格），通过 LLM 结构化输出（Zod schema）中立客观生成校对摘要与问题列表，按 `<talkPage>/<name>` 独立写入结果页并追加唯一日期章节与警告文案，成功写入后更新请求模板为 `status = done`（`resultpage` 参数写入结果页完整页面名，含命名空间与子页面前缀；`section` 参数写入结果页章节标题）并 ping 用户。引入请求互斥锁机制（按 `talkPage#sectionTitle` 及 `revid` 加锁并支持超时回收），防止 RC 轮询、SSE 重连补偿及定期清理等多路并发触发重复校对。提供兜底机制：机器人启动时先执行一次，之后按 `tasks.review.cleanupCron`（cron 表达式，UTC 时区，默认每小时整点）自动扫描讨论页中因网络抖动或异常遗漏的积压请求并补处理（AfC 任务同理，由 `tasks.afc.cleanupCron` 调度）。兜底扫描只处理请求模板 `status` 为空的章节：只要模板已写入任何非空 `status`，即视为该章节已被处理过，不再补处理，也不会改写其模板参数与回复内容。事件流入口在写入前还会回到「当前页面」复核该请求模板是否已处理：若当前页面上的同一请求模板已终结（或模板已不存在），则直接跳过，防止位点回放或并发实例重复发送完整评审与重复回复。章节重定位（`findMatchingSection`）按「完整留言 → 签名时间戳锚点 → 首行（仅无签名时）→ 同名未处理模板 → 章节序号」优先级匹配：留言签名行的时间戳唯一，即使机器人已回填模板参数导致留言不再逐字命中，也不会误落到同名的旧章节。

## 任务三：疑似 AI 编辑线索

分两部分：3-1 定期动态扫描、3-2 模板请求式分析。判定只作为人工复核线索——不把模型概率当作证明，也不要求公开内部推理过程。

### 3-1 定期动态扫描

- **触发与位点**：按 `tasks.aiEdit.cron`（cron 表达式，UTC 时区，默认每小时整点）用 MediaWiki RecentChanges API 扫描自上次 checkpoint 以来的编辑（周期超过单次 API 时间跨度上限时自动拆分为多段查询）。**位点推进**：有 checkpoint 从位点开始；没有（首次运行，或进程重启后换了数据库）则从 **now − 一个 cron 周期**开始扫描（`aiEditMonitor.resolveScanStart` + `schedule.cronPeriodMs`；周期无法估算或超过 24 小时 `MAX_BOOTSTRAP_WINDOW_MS` 时按上限截断），只损失不多于一个周期，避免「频繁重启 → 每轮只建基准 → 扫描永久空转」。
  - **筛选**：只保留纯条目命名空间（ns 0）的 edit/new；忽略机器人/机器用户与匿名 IP 编辑，忽略标签为 AWB、Twinkle、回退功能的编辑；单条 diff 净增加量 < 100 字节的排除；同一条目的多次编辑按条目名称合并，**一个条目一轮只送检一次**（该条目的全部差异合并为同一次 LLM 请求）。
  - **送检内容与成本控制**：**只送编辑差异，不送条目全文**（2026-09-29 成本优化）——差异由 API 读取（`+`/`-` 行），条目正文只用于程序化的参考文献链接检查（纯程序化，不消耗 token）；原先的「24 小时完整正文复用窗口」（`ai_edit_sends`）已删除。新增部分（`+` 行）的 **CJK 汉字数不超过 `MIN_ADDED_CJK_CHARS`（50）的差异跳过检查**（不送 LLM）：跳过不等于丢弃——每条被跳过的差异都逐条写入本地 `ai_scan_stats` 表（含新增 CJK 数、字节数、跳过原因）并在 debugLog 中列出修订号；一个条目的差异若全部不足门槛，该条目整体跳过（同样留痕，并标记为已处理，避免重叠窗口重复读取）。
  - **判定与日志**：按 `tasks.aiEdit.rulePage` 规则由 LLM 输出结构化线索（线索强度、问题概述、位置、具体证据、分析、其他合理解释、建议核查、所属差异修订号、整体线索强度 `confidence`；**URL 可达性检测结果不作为模型输入**，见下节），由程序拼接文字追加到 `tasks.aiEdit.debugLog`（Markdown）——每个条目逐条记录**差异字节数、新增 CJK 数与 Token 用量（含缓存命中，格式 `I…/O…/T…/C…`）**，每次扫描末尾另附本次扫描汇总；并可按 `tasks.aiEdit.summaryCron`（UTC，默认每天 20:00）把最近窗口的扫描统计汇成一张按新增 CJK 分桶的 `edits / analyzed / clues` 表追加到同一日志（数据源同为 `ai_scan_stats`，以 checkpoint 去重，20 小时内不重复汇总）。
  - **线索强度口径**：`confidence` 是**整体线索强度**（越大越指向疑似 AI 辅助编辑），不是「使用 AI 的概率」也不是「对结论的确定度」；`issues` 为空时程序强制归零，无线索记录不得公开。
  - **发布（可选）**：`silent = false` 时再写维基：`reportPagePrefix/YYYY-MM`（按扫描时间设二级标题、条目设三级标题、`{{anchor|紧凑时间+条目名}}` 锚点、`{{La}}` 整理条目相关链接、Diff 逐条列出）与 `usersPage`（同一编者在 ≥3 个不同规范化条目中出现达到 `minConfidence` 的线索时，在 `== YYYY-MM ==` 章节下合并/追加编者行）；发布与 checkuser 汇总都额外要求记录中确实存在线索（否则即使 `confidence` 很高也不公开）。`silent` 默认 true（仅写本地日志）。3-2 请求结果亦不计入 3-1 的 check 页发布。

### 确定性链接检查（3-1 与 3-2 共用）

**不作为模型输入**：在 LLM **之后**执行，且只当模型确实发现了其它线索时才执行（模型没发现任何线索时不检测、也不提供任何链接结果）。**提取与探测**：从条目的参考文献 / 外部链接中提取 URL 并实际探测一次可达性（`tasks.aiEdit.linkCheck` 默认开启，单个链接超时 `linkCheckTimeoutSeconds` 默认 15 秒，单条最多检查 100 个链接（`MAX_LINKS_PER_ARTICLE`），**本次编辑新增的链接优先检查**）。提取按引用模板处理：**模板已提供 `archive-url`（存档副本）或 `url-status` 标记为 dead / usurped / unfit / permanent 时，其原链接（`url` 参数）不计入检查**（符合维基引用惯例：原站点下线但有存档属正常情况）；`archive-url` 指向存档站的链接也不检查（`ARCHIVE_HOSTS`：web.archive.org / archive.org、archive.today 系、ghostarchive.org 等，见下）。结果**只由程序使用**（不送模型）：实测无法访问的链接渲染成**单独一条**程序生成的补充线索（`diff` 为 null）附在模型线索之后——异常链接 1 个为 **low**、≥2 个为 **medium**，并把整体 `confidence` 抬升到下限（0.3 / 0.6）；实测全部可达时什么都不加。检查与「本次是否把完整正文送模型」解耦（纯程序化，不消耗 token），结果按 URL 存入本地 `citation_links` 表并在 7 天复用窗口内直接复用，避免同一条目或被多个条目共用的 URL 反复探测（“以免重复跑测试”）。链接失效也可能只是站点反爬（对数据中心 IP 返回 403）、临时故障或来源抄录有误，因此该线索强度不高于 medium，且必须写明其他可能解释与人工核查方式。配置 `linkCheck: false` 可关闭。**探测优先 IPv4**（服务器 IPv6 地址解析当前不可用），IPv4 解析不到地址时才退回默认解析且只在确定结论时采用；**本机 DNS 解析失败单独归类为「环境侧未检查」**：不生成线索、不抬升 `confidence`，只在补充线索的分析文本里注明「另有 N 个链接因服务器 DNS 异常未能检查」。**兜底**：若模型自己产出的线索全部是「参考文献 URL 无法访问」这一类，仍按「无问题」处理（`hasOnlyCitationLinkClues`：清空 `issues`、`confidence` 归零），因此不会写入 check / checkuser 页。

### 3-2 模板请求式疑似 AI 分析

- **触发与参数**：监听 `tasks.aiEdit.talkPage` 上使用 `tasks.aiEdit.template` 的请求章节（工作流类似 AfC），支持 `article1`、`article2`……`article20` 参数（条目名，可为正式条目，也可为 `tasks.aiEdit.draftNamespace` 允许的草稿命名空间，默认 `[2, 118]`，与任务二/任务四一致；3-1 扫描仍仅处理条目 ns 0）以及 `diff` / `diff1`、`diff2`……`diff20` 参数（裸修订号或 `[[Special:Diff/修订号]]`，双版本形式 `[[Special:Diff/A/B]]` 以 B 为目标、A 为基准）。送检前先按规范化条目名把 article 与 diff 参数合并：**同一条目只分析一次，其全部差异合并为同一次请求**（送检与出报告都是「同一条目、不同 diff」）；无法识别的参数、不存在/不可读取的修订或命名空间不受支持的页面会如实列入结果页与日志。命名空间规则同 3-1，送检内容也同 3-1：**只送编辑差异，不送条目全文**；仅当本次没有任何差异可送（只给了 article 参数）时才附完整条目，否则请求没有可判断的内容。按任务（日期 + 提交人用户名）汇总到同一结果页；结果页用 `{{La}}` 整理条目相关链接并按送检差异逐条列出 Diff，页面展示可疑之处，作为发起 AI 调查的初步分析线索，不代表确认或否认此人滥用 AI。
- **跳过规则（逐项跳过，不影响其它送检对象）**：article / diff 参数无法识别、页面不存在 / 不可读取、命名空间不在 `[0, ...draftNamespaces]`、或 **diff 的编辑时间早于 2023 年**（`MIN_AI_EDIT_YEAR`：早于生成式 AI 广泛使用的编辑不可能是 AI 编辑，不送模型也不做链接检查）时，只跳过该项并在结果页「未能读取或已跳过的送检对象」中如实列出；**只有提供的全部 article 与 diff 都无效时才回复 not done**（回复里带跳过原因），只要有一项有效就照常分析有效部分、忽略无效部分。

## 当前状态与已知限制

四项任务均已接入代码：任务一 讨论页聊天（插话识别、签名时间戳匹配、二级标题多人会话上下文与就地章节回复）；任务二 按请求评审条目/草稿（评审链接解析、目标有效性校验、UTC 自然日额度、固定 revision 绑定与结果页回报）；任务四 AfC（与任务二共用审核流水线，仅讨论页与规则页不同）；任务三 3-1 定期动态扫描（按条目聚合全部差异、一次送检、结构化线索、`ai_scan_stats` 成本统计、本地 debugLog 与可选 check/checkuser 发布）与 3-2 模板请求式疑似 AI 分析（article1…article20 + diff1…diff20，按条目合并为「同一条目、不同 diff」后一次送检）。两条链路都只送「编辑差异」，**不把条目全文送入 LLM**；3-1 另有「新增 CJK ≤ 50 跳过检查但逐条记录」与 debugLog 成本统计（差异字节数、Token 用量含缓存、每日汇总表）。代码已补充较完备的业务、防误报与安全注释。真实编辑由显式 `writeEnabled: true` 控制，默认 dry-run；`npm run check` 与 64 个单元测试通过；`npm run lint` 仍有 32 项既有报错 / 警告（主要是 `no-explicit-any` 与未使用变量，分布在 `handle.ts`、`afc.ts`、`chat.ts`、`requestWorkflow.ts` 与 3 个测试文件）尚未清理。**尚未在真实站点做完整端到端验证，不要描述为生产可用。** 任务三默认关闭（`enabled` 默认 false），需显式开启；所有输出只写机器人的讨论页或指定用户子页。

已知限制与未完成事项：

- 评审文本截断、差异文本总量截断、近期变更筛选非穷尽（只覆盖 cron 周期窗口）；
- 过期 SSE checkpoint 没有 API 补洞；轮询 tick 仍是「跑完才 setTimeout」，无漂移补偿；
- 聊天任务没有积压兜底扫描（工作失败即无回复）；任务二 / 任务四 / 任务三 3-2 有定时兜底；
- 认领回收只在 `writeEnabled: true` 时启用（窗口 24 小时）；「缺少标准模板」提示没有 wikitext 级去重，崩溃重放可能重复提示一次；
- 3-1 的 CJK 门槛需要先读取差异全文，省的是模型 token 而非 API 请求；差异被截断时 CJK 计数偏小（debugLog 会标出）；
- `ai_edit_sends` 表自 2026-09-29 起已无写入（历史遗留表）。

## 变更历史

按时间先后排列（同日可能有多条）；**后一条可能修正前一条，涉及现状时以正文与代码为准**。这些条目记录的是「为什么是这样」的决策依据与线上踩坑，不是当前行为的唯一描述。

### 参考文献 URL 确定性检查（2026-09-29）

任务三 3-1 与 3-2 在模型判定之外增加一条**不依赖 LLM** 的检查——提取条目参考文献 / 外部链接中的 URL 并实际探测可达性（`utils/linkCheck.ts`；结果表 `citation_links`，迁移 `20261001000000`），访问超时 / 拒绝连接 / 403 / 404 / DNS 失败记为 low，异常链接多个时提升为 medium，并与模型结果合并进同一份 `issues`（共用入口 `applyCitationLinkClues`（后改名为 `analyzeWithReferenceLinks`）由 `aiEditMonitor.ts` 维护、3-2 复用）；检查与「是否把完整正文送模型」解耦，结果按 URL 缓存 7 天不重复探测。已知取舍：① 该检查需要进程能访问外网；② 站点反爬（对数据中心 IP 返回 403）会带来误报噪声，可用 `tasks.aiEdit.minConfidence` 上调门槛或 `linkCheck: false` 关闭；③ 检查在模型分析成功之后附加，模型调用失败时依然不会记录任何线索（**当天晚些时候已改为在 LLM 之前执行，见下条**）；④ 单条最多检查 20 个 URL（按正文出现顺序）——**现为 100（`MAX_LINKS_PER_ARTICLE`）**，避免一次扫描被网络探测拖住。

### 3-1 位点丢失时的引导窗口（2026-09-29）

线上观察到「每次发版/重启后，本次扫描的第一轮只建基准就返回」，若 pod 活不过一个整点周期，3-1 就整段空转（当天多次发版，连续三轮只在 01:00/02:00/03:00 打了 `aiEdit 3-1 scan checkpoint established (first run)`）。现改为：**没有 checkpoint 时从「now − 一个 cron 周期」开始扫描**（`utils/schedule.cronPeriodMs` 估算周期 + `aiEditMonitor.resolveScanStart`，上限 24 小时；不能取「上一个触发时刻」——tick 内调用时那正是刚过去的边界，窗口会退化成 0），日志改为 `aiEdit 3-1 scan checkpoint missing, bootstrapping from the previous cron period`。仍不回溯更久远的历史，`maxAnalysesPerWindow` 预算不变。

### 链接检查细化与 3-2 送检规则（2026-09-29）

① 链接提取改为按引用模板处理——已提供 `archive-url` 或 `url-status` 标记失效的原链接不再计入（存档链接本身仍检查），并为每条链接记录 `referenceName`（`<ref name>` 或引用模板 `title`），新增引用优先检查；② 链接检查移到 LLM **之前**，异常链接 `deadUrls` 与新增引用失效统计 `stats`（`newReferences / checkedNewUrls / deadNewUrls / deadRate`）作为确定性事实写入提示词，模型据此判断「新增引用集中失效」，程序再合并一条 low（1 个）/ medium（≥2 个）线索兜底（`analyzeWithReferenceLinks` 统一入口）；③ 3-2 逐项跳过无效对象（参数无法识别、页面不存在 / 不可读取、命名空间不受支持、diff 编辑时间早于 2023 年 `MIN_AI_EDIT_YEAR`），只有提供的全部 article 与 diff 都无效时才 not done（回复携带跳过原因），结果页新增「未能读取或已跳过的送检对象」说明。

### 存档站链接与报告页 URL 协议头（2026-09-29）

① **`archive-url` 指向存档站的链接不再探测**（`linkCheck.ARCHIVE_HOSTS`：archive.org（含 web.archive.org）、archive.today 系镜像（archive.is / ph / li / vn / md / fo / bt）、ghostarchive.org、webcitation.org、megalodon.jp、archive.wikiwix.com、timetravel.mementoweb.org；`isArchiveHost` 按根域含子域匹配）——线上实测存档站对 Toolforge 出口常返回 403 或超时，同一批规范引用在每轮扫描里反复被记成 low / medium 线索，属纯误报；指向**非存档主机**的 `archive-url`（自定义镜像、另一家网站的快照）仍照常检查，`url=` 里出现的存档站链接也不跳过（例如以 archive.org/details 为唯一来源的引用）。原链接参数在「模板已有 archive-url / url-status=dead」时跳过检查的既有规则不变。② **写维基的报告正文一律省略 URL 协议头**：新增 `utils/wikitext.ts` 的 `stripUrlSchemes()` / `safeReportText()`（= `safeWikitext` + 去掉明文 `http://` / `https://`），3-1 check 页、3-2 结果页、任务二 / 任务四结果页与不予处理回复的原因文本都经它拼接——链接检查证据里必然带 URL，明文协议头会被中文维基的滥用过滤器当作外链拦下整笔机器人编辑（写报告被挡）；去掉协议头后来源仍可按「域名 + 路径」辨认，也不会被解析成外链。模型提示词与内置规则同步加了一条：引用 URL 时只写域名与路径（存档站那条也补上了）。`tasks.aiEdit.debugLog` 是本地文件，仍保留完整 URL 便于排查。`test/` 无相关断言，64 个测试与 `npm run check` 均通过。

### 链接探测优先 IPv4 + DNS 失败归属机器人侧（2026-09-29）

线上现象是「参考文献 URL 无法访问」线索里出现大量「拒绝连接」，而真实原因是服务器能访问 IPv6、但**IPv6 地址解析当前不可用**——默认 getaddrinfo 可能先返回 AAAA（连不上或立刻被拒，被记成 ECONNREFUSED = 拒绝连接），也可能因 AAAA 查询失败而整体解析不成功。① `probeLink` 拆成 `probeOnce`（新增 `preferIpv4` 参数）+ 两步策略：先用**只解析 IPv4** 的专用 dispatcher（`getIpv4Dispatcher()` = `new EnvHttpProxyAgent({ connect: { family: 4 } })`，复用全局同样的代理行为，无代理时直接生效）探测；只有当结果是「本机解析失败」时才退回进程默认 dispatcher 再试一次，且**只在拿到确定结论时采用**（HTTP 状态码 / TLS / 重定向过多），否则保留 IPv4 解析失败的结果——避免回退时又走到不可用的 IPv6 路径，把环境问题写成「拒绝连接」。② 新增 `isDnsResolutionFailure()`（`dns` / `dns_temp`）：这类结果**不参与线索**（`isSuspectCitationLink` 直接排除，不进 `deadUrls`、不计入 `deadNewUrls` / `deadRate`、不抬升 confidence）、`classifyLinkError()` 新增 `'dns'` 分类、`NETWORK_ERROR_LABELS` 改为「本机 DNS 无法解析该域名（机器人侧问题）」；同时作为新的确定性字段 `unresolvedUrls` 随报告送模型，提示词 / 内置规则明确写「属机器人侧环境问题，不代表链接失效，不得作为线索，也不得描述为拒绝连接」；若本次确有这类链接，`mergeCitationLinkClues` 会在分析文本里补一句「另有 N 个链接因服务器 DNS 异常未能检查」。③ 解析类失败在 `citation_links` 里只用 **1 小时**复用窗口（`LINK_CHECK_DNS_REUSE_MS`，普通结果仍 7 天），DNS 环境恢复后会尽快重查。④ 3-1 debugLog 新增 `* links unresolved (bot-side DNS failure, not a dead link): N` 行，并在 `log.warn` 里列出这类 URL 便于运维发现环境问题。验证：64 个测试与 `npm run check` 通过；一次性脚本实测 `dns/dns_temp` 不再计入线索、`refused/timeout/reset` 行为不变、`probeLink` 经 IPv4 dispatcher 正常返回 200、DNS 结果 10 分钟后复用而 2 小时后重探（非 DNS 结果 2 小时仍复用）。

### 「只有链接无法访问」按无问题处理（2026-09-29）

链接失效可能是站点反爬（对数据中心 IP 返回 403）、临时故障或来源抄录有误，把它当线索会造成大量误报，因此改为：**链接无法访问本身不构成疑似 AI 线索**。① 提示词与内置规则新增一条：不得单独输出/记录以「URL / 链接无法访问」为主题的 issue，只有与其它可观察证据（如引用信息与来源不符、来源根本不存在）同时成立时，才可把链接失效作为**同一条 issue 内的佐证**；② 程序侧确定性兜底 `hasOnlyCitationLinkClues()`（用标题前缀 `CITATION_LINK_ISSUE_TITLE_PREFIX` 识别程序生成的链接线索，模型照抄同一标题也会被识别）：`analyzeWithReferenceLinks` 在合并后若发现**只有**这类线索，就清空 `issues`、`confidence` 归零，摘要改写为 `buildLinkOnlySummary()`（如实写明「程序化链接检查发现 N 个 URL 无法访问」及「链接失效不构成线索，本次记录为未发现达到门槛的线索」，并带上未能检查的 DNS 数量）；③ 效果：这类记录不再进入 check 页（`publishAiReports` 的发布门槛本就要求 `issues.length > 0`）也不进入 checkuser 汇总（`updateCheckuserPage` 同样会跳过无线索记录），3-2 结果页则显示「未发现达到记录门槛的疑似 AI 线索」并在结论里说明原因；④ 本地仍保留痕迹：3-1 debugLog 的 `* links: N checked, M unreachable` 不变，无线索时新增注明「仅有链接无法访问，未发现其它线索：按「无问题」处理，不写维基页面」，日志里另有 `only citation link failures found, treated as no clue (not published)`。

### 并发化改造（认领 / 执行分离）（2026-09-29）

旧实现把「归属判定」与「把这件事做完」耦合在同一条串行队列里，一笔耗时评审（含多次 LLM 往返）会把后续所有事件与定时任务挡在门外。现在认领阶段只做只读判定 + 一次认领落库并立刻返回，重活交给键控有界并发队列（同页面/同章节串行、异页面并行）。已知取舍：① 认领回收只在 `writeEnabled: true` 时启用，窗口 24 小时（dry-run 无持久副作用，不重放）；② 工作失败会把该修订标为 `failed`，重试依赖下一次事件重复投递或定时兜底扫描（聊天任务没有兜底扫描，失败即无回复）；③ 「缺少标准模板」的提示仍无 wikitext 级去重，崩溃重放可能重复提示一次（改造前同样存在该窗口）；④ 轮询 tick 仍按「跑完才 setTimeout」推进，认领阶段变快后漂移已大幅减小，但未做漂移补偿。

### 任务三 3-1 成本优化（不送全文 + CJK 门槛 + 成本统计 + 每日汇总）（2026-09-29）

① **不再把条目全文送 LLM**——`analyzeArticle` 仍读取当前版本正文，但只用于程序化的参考文献链接检查（不消耗 token），送检输入只有编辑差异；随之删除 `shouldSendFullArticle` / `markFullArticleSent` / `ARTICLE_CONTEXT_REUSE_MS`（`ai_edit_sends` 表保留但已无写入），3-2 也只在「本次没有任何差异可送」这一种情况下才附完整条目。② **新增部分 CJK 字符数 ≤ 50 的差异跳过检查**（`MIN_ADDED_CJK_CHARS`，`countCjkChars` 用 `\p{Script=Han}` 只数汉字，不含标点 / 假名 / 拉丁字母；`addedDiffStats` 只统计差异中以 `+` 开头的行）——跳过但必须留痕：逐条写入新表 `ai_scan_stats`（迁移 `20261002000000`，字段含 cjk_chars / added_bytes / diff_bytes / bucket / analyzed / skip_reason / clues / 四个 token 列），并在 debugLog 里列出被跳过的修订号；一个条目若全部差异都不足门槛则整体跳过（同样记录，并记入 `ai_analyzed` 避免重叠窗口重复读差异）。③ **debugLog 记录更多**：每条条目新增 `* diff bytes: N / added cjk: N`、`* tokens: I…/O…/T…/C…`（`formatTokenUsageDetailed`，C 为缓存命中输入，来自 AI SDK 的 `inputTokenDetails.cacheReadTokens`）、送检差异被截断时的 `* diffs truncated: N`，每次扫描末尾追加 `## 本次扫描汇总`（变更数 / 排除数 / 候选条目 / 读取·送检·跳过差异数 / 线索数 / Token 合计，全部以 `ai_scan_stats` 为唯一数据源）。④ **每日汇总**：新配置 `tasks.aiEdit.summaryCron`（UTC，默认 `0 20 * * *`）→ `writeAiScanDailySummary` 把窗口内（默认最近 24 小时，完成后以 checkpoint `ai-scan-summary:<apiUrl>:<wikiId>` 记录位点，20 小时内重复触发直接跳过）的分桶统计追加到 debugLog，形如 `cjk / edits / analyzed / clues` 四列表格（桶 `<100`、`100–300`、`300–1000`、`>1000`），表下附合计与 Token 用量行。未配置 `debugLog` 时不生效。验证：`npm run check` 通过，64 个测试通过；一次性脚本实测计数器 / 分桶 / 表格渲染与汇总去重、窗口过滤均符合预期。已知取舍：CJK 门槛需要先读取差异全文（RecentChanges 只有新旧字节数），因此省的是模型 token 而非 API 请求；差异被截断（`MAX_DIFF_CHARS`）时 CJK 计数会偏小，已在 debugLog 里标出。

### URL 检测与 LLM 判定解耦（2026-09-29）

`analyzeWikitextClues` 不再接受 `linkReport`：`deadUrls` / `stats` / `unresolvedUrls` 一律不写进提示词，模型只看编辑差异（系统提示词与内置规则里与之相关的三条已删除，改为明说「本次不提供任何 URL 可达性检测结果，不得臆测链接是否可访问」，并保留「链接无法访问本身不构成线索」「存档站链接可能对自动访问返回 403 / 超时」）。`analyzeWithReferenceLinks` 的执行顺序反转：**先送模型**，只有模型确实发现了其它线索（`issues.length > 0`）时才跑一次程序化链接检查，并把实测无法访问的链接作为**单独一条**补充线索附在模型线索之后（`mergeCitationLinkClues`，`diff` 为 null，1 个 low / ≥2 个 medium）；**模型没发现任何线索时连检测都不做**（省掉网络探测），debugLog 只记 `* links: skipped (no other clues found, no URL probe run)`。因此「只有链接无法访问」的结果通常根本不会产生，`hasOnlyCitationLinkClues` 退化为「模型自己报了一堆链接类 issue」时的兜底。随之删除不再使用的 `AiDeadUrl` / `AiUnresolvedUrl` / `AiLinkReport` 类型与 outcome 上的 `report` 字段（改为直接暴露 `stats`），`mergeCitationLinkClues` 也不再改写 summary（链接结果只在线索列表里出现一次）。已知遗留：`linkCheck.extractReferenceLinks` 仍会提取 `referenceName`，但已无消费方。**运维注意：维基上的 `tasks.aiEdit.rulePage` 需要同步删掉「程序化链接检查结果（deadUrls、stats）可以直接作为线索依据」与 `unresolvedUrls` 两段**，否则规则页仍在教模型使用已不提供的数据。

## 代码目录架构

- `src/index.ts`：系统常驻守护进程入口，负责配置加载、数据库与维基客户端初始化、**两层队列**（串行认领队列 + 键控有界并发工作队列）、统一变更事件监听调用、cron 定时任务登记、运行状态统计日志与优雅停机（SIGTERM/SIGINT 后排空在途工作）。事件监听不区分底层驱动，只调用一次 `startChangeFeed({ mode, cfg, db, bot, log, enqueue, onEvent })`。
- `src/handle.ts`：变更事件主路由分发器，采用可插拔责任链流水线模式调度各任务 Handler（`[chatHandler, reviewHandler, aiEditHandler, afcHandler]`），支持按 `intercepted` 拦截与错误捕获；并提供 `recoverUnfinishedEvents`（重启后回收上次已认领但未完成的事件）。
- `src/config/`：配置契约与加载器（`src/config/index.ts`），基于 YAML + Zod 严格校验（含 cron 表达式校验）；Chat 和 Review 任务支持配置在独立的机器人讨论页中运行。
- `src/utils/`：通用基础设施与工具模块（`db.ts` SQLite 存储（含迁移、事件认领 `EVENT_CLAIM_SQL`、未完成事件查询 `listUnfinishedEvents`、任务三扫描成本表 `ai_scan_stats`）、`wiki.ts` MediaWiki 客户端交互（页面读取、修订元数据与修订差异 `revisionDiff`）、`llm.ts` 大模型调用（多模型降级 + 全局并发闸门与单次超时 + Token 统计含缓存命中）、`llm-wiki-tools.ts` 提供给模型使用的维基工具（聊天任务）、`wikitext.ts` 维基文本与讨论页解析、`requestWorkflow.ts` 讨论页模板请求工作流（章节定位 / 请求模板提取 / 事件认领 / 工作阶段幂等复核 / 请求互斥锁 / 状态回报与回复 / 积压请求兜底扫描 / `createTemplateRequestHandler` 处理器工厂，供任务二、任务三 3-2、任务四共用）、`articleReview.ts` 条目审核流水线（固定版本快照校验、规则页拆分、两阶段审核引擎（全局检查 + 可选局部 Chunk 扫描 + 去重/语义合并）、结果页写入与结果页写入互斥、请求拒绝回报，供任务二 / 任务四共用，任务三 3-2 复用其中的快照与回报能力）、`workQueue.ts` 键控有界并发队列与键控互斥锁、`workDispatch.ts` 后台工作派发（认领后异步执行 / 未注入队列时同步内联）、`pageWriteLock.ts` 页面写入互斥、`linkCheck.ts` 参考文献 URL 可达性检查（URL 提取 / 探测 / `citation_links` 本地复用缓存）、`polling.ts` 近期变更轮询与轮询驱动、`eventstream.ts` EventStreams SSE 驱动、`changeFeed.ts` 两种驱动的统一入口、`schedule.ts` cron 定时调度）。
- `src/tasks/`：机器人任务模块，各独立一文件并暴露各自的 `TaskHandler`：
  - `src/tasks/chat.ts`：任务一（讨论页自由对话与章节多用户上下文应答，默认运行在 `User talk:Bot`）
  - `src/tasks/review.ts`：任务二（应请求条目/草稿校对评审，采用“全文全局检查 + 导言/二级/三级标题 Chunk 分块局部高覆盖率扫描 + 确定性/语义去重合并”流水线，与额度管控相配合，默认运行在 `User talk:Bot/review`；审核流水线与章节/模板/锁/回报等交互流程分别复用 `utils/articleReview` 与 `utils/requestWorkflow`）
  - `src/tasks/aiEditMonitor.ts`：任务三（3-1 定期动态扫描：按条目聚合近期条目编辑及其差异、新增 CJK 门槛过滤、结构化疑似线索、`ai_scan_stats` 成本统计、debugLog（含每日汇总）与可选 check/checkuser 发布）；同时维护 3-1/3-2 共用的线索判定契约（Zod schema、中立性系统提示词、规则页加载、差异送检输入与单次分析、新增 CJK / 分桶 / 每日汇总辅助函数、Diff 链接渲染）
  - `src/tasks/aiEditReview.ts`：任务三（3-2 模板请求式疑似 AI 分析，支持 article1…article20 与 diff1…diff20，按规范化条目名合并为「同一条目、不同 diff」后每个条目只送检一次并汇总结果页；交互流程复用 `utils/requestWorkflow`，条目快照与请求回报复用 `utils/articleReview`；当前按条目单次判定、不拆章节细查，审核引擎的 `chunkEnabled` 开关保留了后续启用局部扫描的能力）
  - `src/tasks/afc.ts`：任务四（新手条目发布前评审；审核流水线复用 `utils/articleReview`，交互流程复用 `utils/requestWorkflow`；规则页声明“局部扫描 未启用”时仅做全局评审）

## 文档

`README.md` 为面向中文读者的使用说明，包含：项目概述、本地安装（`npm i` / `.env` 与 `config.yaml` / `npm run start`）、Toolforge 部署（`toolforge envvars create` / `build start` / `jobs run`）、自动部署与热更新（GitHub Actions 工作流 `.github/workflows/deploy-toolforge.yml`：推送 `main` 后 `npm run check` → `ssh seija@dev.toolforge.org` + `become seijabot` → `toolforge build start -i amanojakubot <repo>` → `toolforge jobs restart amanojakubot`，两条 `toolforge` 命令用 `&&` 串联；密钥走仓库 Secret `TOOLFORGE_SSH_KEY`，其公钥加在开发者账号上，手工兜底流程为 `build start` + `jobs restart`）、代码结构，以及各功能概述与代码入口。

## 继续开发建议

从项目根目录阅读 README、代码和本文件。开发者偏好手工端到端验收，不强制或新增自动化测试；可运行 `npm run check` 做静态类型检查。先在可控的机器人测试页面以 dry-run 核对，再在显式打开写入后手工核查真实编辑，尤其是 API 响应形状、机器人账号过滤、断线恢复、幂等、额度及报告的误报。同步更新本文件：正文只写**现状**（行为变了就改正文，不要只在历史里追加一条），决策依据与线上踩坑按日期追加到「变更历史」。
