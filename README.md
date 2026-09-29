# AmanojakuBot

中文维基百科常驻机器人（Node.js + TypeScript）。本仓库目前处于**人工测试阶段**：只在机器人自己的用户页/讨论页上验证，**尚未在真实维基上做过完整端到端验证**，请不要当作生产可用系统来使用。

---

## 1. 概述

### 这是什么

一个 7×24 常驻的维基百科守护进程，通过 MediaWiki API 监听编辑事件、调用大模型（LLM）处理，并把结果写回**机器人自己的页面**。

### 能做什么（共四项任务）

| 任务 | 功能 | 说明 |
| --- | --- | --- |
| 任务一 讨论页聊天 | 在机器人讨论页自由对话 | 识别留言者、时间戳、缩进与章节，结构化后交给 LLM，就地追加回复 |
| 任务二 条目校对 | 按请求评审条目/草稿 | 用户用模板提交请求，机器人按规则页输出校对结果页并回写状态 |
| 任务三 疑似 AI 编辑 | 3-1 定期动态扫描 + 3-2 模板请求式分析 | 生成「人工复核线索」，只描述客观疑点，不作人格判断或确定性归因 |
| 任务四 AfC | 新手条目发布前评审 | 与任务二共用评审流水线，只是讨论页不同 |

### 技术栈

- **运行时**：Node.js（使用原生 `node:sqlite` 的 `DatabaseSync`，建议 Node.js 22.5+，本机在 v26 上开发）
- **语言**：TypeScript（ESM，`tsx` 直跑，`npm run check` 静态检查）
- **维基交互**：`mwn`（MediaWiki API 客户端）
- **大模型**：Vercel AI SDK（`ai`），provider 可选 OpenAI / Google
- **存储**：原生 `node:sqlite` + 裸 SQL，无 ORM，自己维护 `schema_migrations` 增量迁移
- **配置**：YAML + Zod 严格校验（含 cron 表达式校验）
- **日志**：Pino（error 级同时写入 `error_logs` 表）
- **定时**：`croner`（全部按 UTC 时区）

### 三条重要设计原则

1. **默认 dry-run**：`wiki.writeEnabled` 默认为 `false`，只打印预览、不真正编辑、不消耗额度。
2. **模型不能决定写入位置**：写入目标、命名空间、额度与紧急停止全部由确定性代码检查；LLM 输出永远不能直接获得编辑权限。
3. **链上总开关**：每次写入前都重新读取机器人控制页，`enabled: true` 且 `emergencyStop: false` 才允许写入。

---

## 2. 如何本地安装运行

### 2.0 前置要求

- Node.js 22.5 以上（需要 `node:sqlite`），推荐使用当前 LTS 或更新版本
- 一个可用的 MediaWiki 账号（机器人账号 / BotPassword）
- 至少一个 LLM 的 API Key（OpenAI 或 Google）

### 2.1 安装依赖

```bash
npm i
```

### 2.2 配置环境变量

先复制模板：

```bash
cp .env.example .env.zhwp     # 名字随意，见下
```

需要填写的变量：

```dotenv
WIKI_BOT_PASSWORD=            # 机器人账号（或 BotPassword）密码
OPENAI_API_KEY=               # 使用 openai provider 时填写
GOOGLE_GENERATIVE_AI_API_KEY= # 使用 google provider 时填写
```

> ⚠️ **本项目不会自动加载 `.env`**（代码里没有 dotenv）。密钥只放环境变量，不要写进 YAML，也不要提交进 Git。
>
> 加载方式有两种：
>
> - 用 npm 脚本内置的 `--env-file`（推荐）：`npm run start:zhwp` 读取 `.env.zhwp`，`npm run start:testwiki` 读取 `.env.testwiki`；
> - 或者先在 shell 里 `export`，再执行 `npm run start`。

### 2.3 配置 `config.yaml`

```bash
cp config.example.yaml config.yaml
```

重点需要改的字段：

| 字段 | 说明 |
| --- | --- |
| `wiki.apiUrl` | 目标站点的 `api.php` 地址 |
| `wiki.wikiId` | 非 zhwiki 且强制定向 EventStreams 时必须提供 |
| `wiki.username` | 维基上的机器人用户名 |
| `wiki.loginUsername` | 使用 BotPassword 后缀（如 `Bot@bot`）时单独填写 |
| `wiki.ownerUserId` | 机器人拥有者的 user id（额度归属用） |
| `wiki.controlPage` | 控制页，**必须**是 `User:xxx/...` 形式 |
| `wiki.writeEnabled` | 保持 `false` 做 dry-run；确认无误后再改 `true` |
| `storage.dbPath` | SQLite 文件路径，**每个 wiki 用不同文件** |
| `events.mode` | `eventstream`（SSE）或 `polling`（轮询）；不填则 zhwiki 默认 SSE、其他站默认轮询 |
| `llm.provider` / `llm.model` | 全局默认模型；各任务下还可覆盖 |
| `tasks.*` | 各任务的开关、讨论页、规则页、模板与 cron |

### 2.4 准备维基上的页面

1. **控制页**（`wiki.controlPage`）写入：

   ```yaml
   enabled: true
   emergencyStop: false
   ```

2. **人格页**（`tasks.chat.personaPage`）：创建它，用于定义聊天语气与角色。
3. **规则页**（各任务的 `rulePage`）：校对规则 / 疑似 AI 判定规则由这些页面提供。
4. 确认所有可写页面都属于机器人用户名下（配置校验会检查）。

### 2.5 启动

```bash
npm run start          # 读取 config.yaml 与系统环境变量
npm run start:zhwp     # 读取 .env.zhwp + config.yaml
npm run start:testwiki # 读取 .env.testwiki + config.yaml
```

也可以用 `CONFIG_PATH` 指定别的配置文件：`CONFIG_PATH=config.zhwp.yaml npm start`。

### 2.6 其他命令

```bash
npm run check   # TypeScript 静态类型检查（提交前建议跑）
npm test        # Vitest 单元测试
npm run lint    # ESLint
```

### 2.7 本地验收建议

1. 保持 `writeEnabled: false`，在机器人讨论页追加一条**已签名**的新留言，看日志里的回复预览；纯格式修改不应触发回复。
2. 提交一条校对请求，检查日志预览里的无效页面/额度逻辑。
3. 确认无误后，把 `writeEnabled: true`（并提供密码）、重新启动进程，再发一条**新**留言，检查真实编辑结果。
4. 把控制页改成 `emergencyStop: true`，确认新的写入被拦截。

---

## 3. 如何在 Toolforge 运行

以下命令在 Toolforge 的登录节点（`toolforge login`）执行，`seijabot` 为工具账号名，按需替换。

### 3.1 配置环境变量

```bash
toolforge envvars create WIKI_BOT_PASSWORD '<机器人密码>'
toolforge envvars create OPENAI_API_KEY '<你的 API Key>'
# 使用 Google provider 时：
toolforge envvars create GOOGLE_GENERATIVE_AI_API_KEY '<你的 API Key>'
```

> 运行时的配置通过环境变量传入：`*.env` 文件不会自动加载，所以 Toolforge 上用 `envvars` 注入密钥；`config.yaml` 需要预先放在 `/data/project/seijabot/AmanojakuBot/`（注意改为你自己的tool）下，并通过 `CONFIG_PATH` 指过去。

### 3.2 构建镜像

```bash
toolforge build start -i amanojakubot https://github.com/amanojaku-wp/AmanojakuBot
```

`-i` 指定镜像名，仓库地址指向 GitHub 上的本仓库；构建完成后镜像为 `tool-seijabot/amanojakubot:latest`。

### 3.3 以常驻任务（continuous job）运行

```bash
toolforge jobs run --image tool-seijabot/amanojakubot:latest \
  --command "startbot" --continuous --mount=all amanojakubot \
  -o /data/project/seijabot/AmanojakuBot/stdout.out \
  -e /data/project/seijabot/AmanojakuBot/stderr.out
```

说明：

- `--command "startbot"`：对应仓库根目录 `Procfile` 中的 `startbot: npm start`；
- `--continuous`：常驻守护进程，不自动退出；
- `--mount=all`：挂载 `/data/project/seijabot`，使 SQLite 数据库与 `debugLog` 等文件持久化；
- `-o` / `-e`：标准输出 / 错误的落盘路径。

### 3.4 查看状态与日志

```bash
toolforge jobs list
tail -f /data/project/seijabot/AmanojakuBot/stdout.out
```

---

## 4. 自动部署与热更新

### 4.1 自动部署（GitHub Actions）

仓库内置 `.github/workflows/deploy-toolforge.yml`：**推送到 `main` 分支**（也可以在 Actions 页面用 `workflow_dispatch` 手动触发）后自动执行：

1. `npm ci` + `npm run check` 静态类型检查（构建镜像时 `tsx` 不做类型检查，这一步用来拦住低级错误）；
2. SSH 登录 Toolforge 登录节点，切换到工具账号，然后依次执行：

```bash
ssh seija@dev.toolforge.org
become seijabot                      # 切换工具账号（会切换当前用户）
toolforge build start -i amanojakubot https://github.com/amanojaku-wp/AmanojakuBot
toolforge jobs restart amanojakubot
```

> 自动部署里用官方推荐的脚本写法 `ssh <开发者账号>@dev.toolforge.org become <工具名> "bash -c '<命令>'"` 达到同样的效果；两条 `toolforge` 命令用 `&&` 串联，**构建失败就不会重启任务**（不会把老进程带下去）。

#### 启用前的一次性配置

1. 本地生成一对**专用**密钥（不要复用日常登录用的私钥）：

   ```bash
   ssh-keygen -t ed25519 -C "github-actions-toolforge" -f ~/.ssh/amanojakubot_deploy
   ```

2. 把**公钥**（`~/.ssh/amanojakubot_deploy.pub`）内容粘贴到 <https://toolsadmin.wikimedia.org/profile/settings/ssh-keys/>，加到你自己的**开发者账号**（本例 `seija`）上。该账号同时必须是工具 `seijabot` 的 maintainer，`become seijabot` 才有权限。
3. 把**私钥**（`~/.ssh/amanojakubot_deploy`）全文添加为仓库 Secret：`Settings → Secrets and variables → Actions → New repository secret`，名字必须是 `TOOLFORGE_SSH_KEY`。
4. 工作流顶部 `env:` 中的 `TOOLFORGE_TOOL` / `TOOLFORGE_IMAGE` / `TOOLFORGE_REPO` / `TOOLFORGE_JOB` 按需修改（默认已对应本仓库）。

> 工作流用 `ssh-keyscan` 抓取登录节点的主机公钥；如需更严格的凭据固定，可比对 [login.toolforge.org 的指纹](https://wikitech.wikimedia.org/wiki/Help:SSH_Fingerprints/login.toolforge.org)后改用固定的 `known_hosts`。
>
> 首次启用建议先在 Actions 页面手动跑一次，确认能构建成功并重启任务。

### 4.2 手工热更新（重新构建 + 重启）

改完代码推送到 GitHub 之后，两步完成更新：

```bash
# 1. 重新构建镜像
toolforge build start -i amanojakubot https://github.com/amanojaku-wp/AmanojakuBot

# 2. 重启常驻任务，使其使用新镜像
toolforge jobs restart amanojakubot
```

> 每次重新构建都会产生新的 `:latest`，`jobs restart` 会拉取该镜像重新启动进程；如果只是改了 `config.yaml`，同样需要 `toolforge jobs restart amanojakubot`（或者把配置放环境变量后用 `envvars` 更新）。

---

## 5. 代码结构

```text
src/
├── index.ts                  # 守护进程入口：加载配置、打开 DB、登录维基、认领队列 + 工作队列、注册 change feed 与 cron
├── handle.ts                 # 变更事件主路由（责任链流水线，可拦截）+ 重启后未完成事件回收
├── config/
│   └── index.ts              # YAML + Zod 配置契约与加载器
├── tasks/                    # 各业务任务，一个任务一个文件，导出 TaskHandler
│   ├── chat.ts               # 任务一：讨论页聊天
│   ├── review.ts             # 任务二：按请求条目/草稿校对
│   ├── aiEditMonitor.ts      # 任务三 3-1：定期动态扫描 + 线索判定契约（被 3-2 复用）
│   ├── aiEditReview.ts       # 任务三 3-2：模板请求式疑似 AI 分析
│   └── afc.ts                # 任务四：新手条目发布前评审
└── utils/                    # 通用基础设施
    ├── db.ts                 # SQLite 打开、迁移、预编译语句、请求/额度记录、错误日志
    ├── wiki.ts               # MediaWiki 客户端：建号、读页面、读修订、读差异（revisionDiff）
    ├── wikitext.ts           # 维基文本与讨论页解析（签名/时间戳/缩进/章节/模板/回复插入）
    ├── llm.ts                # LLM 调用与多模型降级（executeWithFallback）、token 统计
    ├── llm-wiki-tools.ts     # 提供给模型的维基工具（供聊天任务使用）
    ├── requestWorkflow.ts    # 模板请求工作流：章节定位、请求提取、事件认领、幂等复核、状态回报、积压兜底扫描
    ├── articleReview.ts      # 条目审核流水线：快照校验、规则页解析、两阶段审核引擎、结果页写入（含结果页写入互斥）
    ├── workQueue.ts          # 键控有界并发队列 + 页面级互斥锁（同键串行、异键并行、不丢任务）
    ├── workDispatch.ts       # 后台工作派发（认领后异步执行；未注入队列时退化为同步内联）
    ├── pageWriteLock.ts      # 维基页面写入互斥（同一页面的读-改-写串行，避免丢更新与编辑冲突）
    ├── changeFeed.ts         # 变更事件统一入口（按 mode 分发）
    ├── eventstream.ts        # EventStreams(SSE) 驱动（含 checkpoint、断线重连与补偿）
    ├── polling.ts            # RecentChanges 轮询驱动（窗口增量、分页、重叠去重）
    └── schedule.ts           # cron 定时调度（UTC、跳过重叠 tick）
```

**运行主链路**：`index.ts` 打开配置与数据库 → `startChangeFeed(...)` 按 `events.mode` 选择 SSE 或轮询 → 每个事件交给 `handle.ts` 的流水线 `[chatHandler, reviewHandler, aiEditHandler, afcHandler]` 依次处理。

**并发模型（认领 / 执行分离）**：事件驱动的消费路径分成两段，避免一笔耗时评审把后续所有事件与定时任务挡在门外。

- **认领阶段**（驱动层 `enqueue`，极短串行链）：只做「归属判定 + 幂等校验 + 事件位点推进 + 认领落库（`events.state = claimed` + 原始事件载荷）」。该阶段只有同步 SQLite 写入与少量只读请求，毫秒~百毫秒级；位点推进保持严格有序。
- **工作阶段**（`utils/workQueue` 键控有界并发队列）：LLM 调用与维基写入等重活。**同键（同一讨论页同一章节）严格串行**，保证同一页面的读-改-写不互相覆盖；**异键并行**（并发上限 `runtime.workConcurrency`），所以「讨论页 A 的评审」不再阻塞「讨论页 B 的请求」。
- **不丢任务**：并发已满时任务排队等待，而不是像旧版请求锁那样「撞锁即跳过」；认领即落库，进程被重启后由 `handle.recoverUnfinishedEvents` 回收重派；单次任务失败只影响该次调用，并把该修订标记为 `failed` 交由定时兜底扫描重试。
- **页面写入互斥**（`utils/pageWriteLock`）：同一维基页面的读-改-写（请求章节回报、结果页「读现有章节 → 生成唯一标题 → 全量写回」）串行化，避免丢更新与编辑冲突。
- **限流与超时**：`runtime.llmMaxConcurrent` 限制同时进行的模型调用，`runtime.llmTimeoutSeconds` 为单次调用超时；队列深度与 LLM 闸门占用按 `runtime.statsIntervalSeconds` 输出到日志；收到 SIGTERM/SIGINT 后先排空在途工作再退出。

---

## 6. 各功能概述与代码入口

### 任务一：讨论页聊天

- **入口**：`src/tasks/chat.ts` → `chatHandler`（核心逻辑 `respond` / `prepareChatReply`）
- **触发**：监听 `tasks.chat.talkPage` 上的新留言事件
- **流程**：从修订记录取**实际编辑者 user_id**（签名只是文本，不用于认证）→ 排除机器人自己与机器人账户 → 通过差异分析 + 时间戳区分「新留言」与「格式整理/历史文本修改」→ 解析二级标题章节与多人会话（谁、何时、缩进、去签名噪声的正文）→ 结构化 XML 交给 LLM → **就地**在该章节安全追加回复。
- **要点**：
  - 留言修订时间戳超过 30 分钟（`MAX_REPLY_AGE_MS`）直接跳过，避免断线补偿时回复陈旧留言；
  - 读取机器人用户页的 persona/control 设置，按 `user_id` 保存近期对话记忆；
  - 回复后记录来源与回复 revision、模型使用情况，避免重复回复；
  - 控制页 `emergencyStop` 在编辑层生效。

### 任务二：条目辅助校对（Review）

- **入口**：`src/tasks/review.ts` → `processReviewRequest` / `reviewHandler`；流水线与交互分别复用 `src/utils/articleReview.ts`、`src/utils/requestWorkflow.ts`
- **触发**：`tasks.review.talkPage` 上使用 `tasks.review.template`（`User:AmanojakuBot/template/ReviewRequest`）的二级标题章节，每个章节有且仅有一个请求
- **流程**：请求者身份由「触发 revision 的编辑者 + 签名用户」双重校验 → 校验目标页面（命名空间 0 或 `draftNamespace`，跟随重定向）→ 检查空/非条目内容并标记 `status = not done` 说明原因 → 按 UTC 自然日额度 `userDailyLimit` 限制 → 绑定固定 revision ID → 读取 `rulePage` 规则 → LLM 结构化输出（Zod schema）→ 写入结果页 `<talkPage>/<name>`（唯一日期章节 + 警告文案）→ 回写模板 `status = done`、`resultpage`、`section` 并 ping 用户。
- **要点**：
  - 审核采用「全文全局检查 + 导言/二级/三级标题分块局部扫描 + 确定性/语义去重合并」流水线（`runArticleReviewEngine`，`chunkEnabled` 可关）；
  - 请求互斥锁按 `talkPage#sectionTitle` + `revid` 加锁，防多路并发重复校对；
  - 兜底：启动时先扫一次，之后按 `tasks.review.cleanupCron`（UTC，默认每小时整点）补处理积压请求；只处理 `status` 为空的章节；
  - 写入前会回到「当前页面」复核模板是否已被处理，防止位点回放或并发实例重复发送。

### 任务三：疑似 AI 编辑线索

#### 3-1 定期动态扫描

- **入口**：`src/tasks/aiEditMonitor.ts` → `scanAiEdits` + `publishAiReports`
- **触发**：按 `tasks.aiEdit.cron`（UTC，默认每小时整点）定时执行；**首次 tick 只建立基准位点**，不回溯历史编辑
- **流程**：RecentChanges API 扫描自上次 checkpoint 以来的编辑（周期超过 API 上限时自动分段查询）→ 只保留命名空间 0 的 `edit`/`new` → 忽略机器人/机器用户/匿名 IP 与 AWB、Twinkle、回退功能标签 → 丢弃净增加量 < 100 字节的 diff → **同一条目的全部差异合并为一次请求**（一个条目一轮只送检一次）→ 送检「全部差异 + 完整条目正文」（24 小时内已送过完整正文或正文过长时降级为只送差异）→ LLM 输出结构化线索 → 程序拼接 Markdown 追加到 `tasks.aiEdit.debugLog`。
- **线索字段**：线索强度 `confidence`（**整体线索强度**，越大越指向疑似 AI 辅助编辑，**不是**「使用 AI 的概率」）、问题概述、位置、具体证据、分析、其他合理解释、建议核查、所属差异修订号。
- **发布（可选）**：`silent = false` 时才写维基 —— `reportPagePrefix/YYYY-MM`（按扫描时间设二级标题、条目设三级标题、`{{anchor|紧凑时间+条目名}}` 锚点、`{{La}}` 整理链接、逐条 Diff）与 `usersPage`（同一编者在 ≥3 个不同规范化条目中出现达标线索时，在 `== YYYY-MM ==` 下合并/追加编者行）。
- **`silent` 默认 `true`**（仅写本地日志）；发布与 checkuser 汇总都额外要求「记录中确实存在线索」，无线索记录绝不公开。

#### 3-2 模板请求式疑似 AI 分析

- **入口**：`src/tasks/aiEditReview.ts` → `aiEditHandler`（参数解析 `parseDiffParam`，主流程 `processAiCheckRequest`）
- **触发**：`tasks.aiEdit.talkPage` 上使用 `tasks.aiEdit.template` 的请求章节
- **参数**：`article1` … `article20`（条目名，允许命名空间 0 与 `tasks.aiEdit.draftNamespace`），以及 `diff1` … `diff20`（裸修订号、`[[Special:Diff/修订号]]`、`[[Special:Diff/A/B]]` 以 B 为目标）；不带编号的 `article` / `diff` 也支持
- **流程**：先按规范化条目名把 article 与 diff 参数合并 → **同一条目只分析一次，全部差异合并为一次送检** → 命名空间校验、24 小时完整正文复用与降级规则同 3-1（共用 `ai_edit_sends` 表；若本次没有任何差异可送，则仍送完整条目）→ 按任务（日期 + 提交人用户名）汇总到同一结果页。
- **结果页**：用 `{{La}}` 整理条目相关链接，按送检差异逐条列出 Diff；无法识别的参数、不存在/不可读取的修订或命名空间不受支持的页面会如实列入结果页与日志。
- **定位说明**：页面展示的是**人工复核线索**，作为发起 AI 调查的初步分析，**不代表确认或否认**该编者滥用 AI。

### 任务四：AfC（新手条目发布前评审）

- **入口**：`src/tasks/afc.ts` → `processAfcRequest` / `afcHandler`；审核流水线复用 `src/utils/articleReview.ts`，交互流程复用 `src/utils/requestWorkflow.ts`
- **触发**：`tasks.afc.talkPage` 上的请求章节（模板同为 `ReviewRequest`，靠讨论页区分任务）
- **要点**：与任务二同构，输出「发布就绪度」（`not_ready` / `needs_work` / `appears_ready`）而非校对问题列表；规则页声明「局部扫描未启用」时只做全局评审；兜底扫描由 `tasks.afc.cleanupCron` 调度。

### 共用基础设施入口

| 模块 | 入口 | 作用 |
| --- | --- | --- |
| 事件路由 | `src/handle.ts` → `handle`、`handlers` | 责任链流水线，`intercepted` 可中断后续处理器 |
| 变更源统一入口 | `src/utils/changeFeed.ts` → `startChangeFeed` | 按 `events.mode` 分发到 SSE 或轮询 |
| SSE 驱动 | `src/utils/eventstream.ts` → `startEventStreamFeed` | checkpoint（含 `lastEventId`/`last_revid`）、10/30/60/120/300 秒递增重连、`recentchanges` 遗漏补偿 |
| 轮询驱动 | `src/utils/polling.ts` → `startPollingFeed` / `fetchRecentChanges` | 时间窗口增量、分页、重叠去重；窗口上界固定在 tick 开始时刻 |
| 数据库 | `src/utils/db.ts` → `openDb` / `runMigrations` / `countDailyCompletedReviews` / `recordError` | 迁移、额度统计、错误持久化 |
| 定时调度 | `src/utils/schedule.ts` → `scheduleCron` / `isValidCron` | UTC cron，跳过重叠 tick |
| 配置 | `src/config/index.ts` → `loadConfig` | YAML + Zod 校验，含安全约束（可写页面必须属于机器人） |
| LLM | `src/utils/llm.ts` → `executeWithFallback` | 多模型依次降级，`generateObject` + Zod 结构化输出 |
| 差异读取 | `src/utils/wiki.ts` → `revisionDiff` | 读取目标/基准修订元数据与 `+`/`-` 差异文本（有长度上限） |

---

## 7. 已知限制与注意事项

- 讨论页解析只识别「追加在末尾且已签名」的留言；新章节插入、无签名留言、删除/重排文本与非标准讨论系统可能漏判。RecentChanges 的 `bot` 标记并不等于完整的机器人账号查询。
- 任务二最多检查 50 个链接、只评审额度内靠前的合格页面，单页正文截断到 12,000 字符；额度预留在生成之前，生成失败可能留下同源修订重试的预留。校对报告是**初步结论，不是已核实的事实核查**。
- 任务三 3-1 刻意只扫描命名空间 0、限制每轮分析数量并跳过短增量，它是**抽样/线索筛查，不是穷尽检测**；降级为只送差异时模型可能缺少上下文；标签过滤依赖 API 返回标签；**模型给出的置信度不是作者归属证据**。3-2 结果是 AI 生成的初步线索，明确不代表确认或否认滥用 AI。
- 若 SSE checkpoint 早于上游保留期限，没有自动 Action API 补洞；轮询虽有重叠与去重，长时间中断仍可能遗漏。
- 所有输出只写机器人讨论页或指定的机器人用户子页；模型不能选择写入目标。
- 不要把本项目描述为生产可用；切换到真实写入前请先做人工端到端核查（API 响应形状、机器人账号过滤、断线恢复、幂等、额度与误报）。
