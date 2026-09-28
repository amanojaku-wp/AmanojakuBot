# MediaWiki agent — manual-testing build

Node.js / TypeScript daemon. Task 1: discussion chat; task 2: requested article/draft review; task 3: conservative AI-edit triage on two bot-owned user subpages. This build has **not** been exercised against a real wiki. Do not describe it as production-ready.

## Configuration and credentials

1. Run `npm install`, copy `config.example.yaml` to `config.yaml`, set the MediaWiki API URL, actual bot account (`wiki.username`), its talk/persona/control pages, and a wiki-specific `storage.dbPath`. If the login name uses a BotPassword suffix, set `wiki.loginUsername` separately; `wiki.username` remains the on-wiki username.
2. Supply `WIKI_BOT_PASSWORD` and either `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` in your process environment (not in YAML or Git). The project does **not** auto-load `.env`.
3. On the bot-owned control page put `enabled: true` and `emergencyStop: false`. Create the persona page. `writeEnabled: false` is the default; this is a genuine dry run: proposed replies/reports are logged and no wiki edit or review quota is committed. Set `writeEnabled: true` after examining the preview to allow authenticated edits. At each attempted write the control page is read again.
4. `npm run check` performs only static TypeScript validation; `npm start` runs the daemon. Automated tests are not required for the manual workflow.

The bot's only write destinations are the configured bot talk page and, if task 3 is enabled, its two configured bot-owned user subpages. Model output cannot choose a destination.

## Event source

`wiki.apiUrl` on `zh.wikipedia.org` defaults to EventStreams; other hosts default to RecentChanges polling. Override with `events.mode`. For non-zhwiki EventStreams, explicitly supply `wiki.wikiId` and `events.streamUrl`. Polling the discussion page is limited with `rctitle`. Task 3 (3-1) always scans namespace 0 recent changes on its own cron schedule (`tasks.aiEdit.cron`, interpreted in UTC; both EventStreams and polling sites), so it consumes extra API calls; task 3 is disabled by default. The first scan/checkpoint only establishes its baseline instead of processing historical edits. The review/AfC backlog sweep runs once at startup and then on `tasks.review.cleanupCron` / `tasks.afc.cleanupCron` (UTC). Keep a separate SQLite file per wiki.

## Manual acceptance path

1. Leave `writeEnabled: false`; add a signed, appended message to the bot talk page. Check the proposed chat reply in logs. A format-only change should not respond. Polling's first run only establishes its checkpoint, so add the message afterward.
2. Request `评审 [[条目标题]]` or `评审 https://<current-wiki>/wiki/条目标题` in a signed new message. Check the preview includes invalid/missing pages and quota logic. Requests accept existing namespace 0 or configured draft namespace targets, following redirects; non-owner quota is 10 first reviews per UTC day, with one recheck within 30 days. For the manual dry run no quota is consumed.
3. Only when ready, set `writeEnabled: true`, provide the bot credentials in the process environment, and start a fresh process. Post a **new** message and inspect the resulting bot talk page edit. Source revision markers avoid duplicate replies. A previously previewed revision will not be replayed automatically if its event checkpoint moved; post a new test request.
4. For task 3 (3-1), first enable `tasks.aiEdit.enabled` with `rulePage`, `debugLog`, and (for live writes) bot-owned `reportPagePrefix`/`usersPage`. Keep `silent: true` to only append local Markdown to `debugLog`; set `silent: false` to also publish. Scanning runs on the `tasks.aiEdit.cron` schedule; the first run only sets a baseline. Create/expand a namespace-0 **article** (drafts are not scanned by 3-1), wait for a scan, then inspect `debugLog` for the per-article `diff`/`user`/`confidence`/result entries (net additions under 100 bytes, bot/anonymous editors and AWB/Twinkle/rollback tags are skipped). At most `maxAnalysesPerWindow` articles are sent to the LLM per scan (default 20). Check specific evidence and false positives manually. With live writes, check entries are grouped by scan time under `reportPagePrefix/YYYY-MM`; `usersPage` lists only accounts with evidence in three distinct titles at or above `minConfidence`.
5. For task 3 (3-2), post a signed request using template `tasks.aiEdit.template` on `tasks.aiEdit.talkPage` with `article1`, `article2`, … parameters. With `writeEnabled: false` inspect the preview in logs; with live writes check the result page under the talk page (`…/YYYYMMDD-<user>`) and the template status reply.
6. Change the control page to `emergencyStop: true`; verify new write attempts stop. Then restore the desired state yourself. Use different credentials, pages, and DB files for local wiki/Miraheze vs zhwiki.

## Known gaps / cautions

- Discussion parsing only recognizes append-at-end, signed comments. New section insertions, unsigned comments, deleted/reordered text and nonstandard discussion systems can be missed. RC `bot` flags are not a complete bot-account lookup.
- Task 2 checks up to 50 supplied links, reviews only the first eligible pages within quota, and truncates large article text to 12,000 characters per page. Quota reservations occur before model generation in live mode; a failed generation can leave a reservation that retries under the same source revision. Review reports are provisional, not verified fact-checks.
- Task 3 (3-1) intentionally scans only namespace 0, caps analyses per scan, skips short net additions and large pages, and only analyzes the article's *current* version (not the diff text); it is **sampling/triage, not exhaustive detection**. Tag-based exclusions (AWB/Twinkle/rollback) depend on RecentChanges tags being returned. A model's confidence is not evidence of authorship. No cross-scan budget/cost accounting or independent human approval UI exists. 3-2 results are AI-generated provisional leads and are explicitly framed as not confirming or denying AI use.
- Task 3 publication: with `silent: false`, check/user pages are appended idempotently via HTML-comment markers; an interrupted write is retried on the next cycle. Records below `minConfidence` are never published (and are marked handled). `usersPage` merging assumes the `== YYYY-MM ==` section and `* {{user|name}}：` line format.
- If an SSE checkpoint is too old for upstream retention, there is no automatic Action API catch-up. Polling uses overlap and de-duplication, but RecentChanges retention can still expire during a long outage. This implementation has no authenticated live-wiki verification yet.

## 任务三工作流

### 3-1 动态扫描

1. 使用mediawiki api，每隔tasks.aiEdit.intervalSeconds扫描一下该周期内的编辑（如果周期超过mediawiki api限制则将时间拆开分段查询），只保留纯条目命名空间编辑。同一条目的多次编辑要按条目名称合并判断。忽略机器人、机器用户编辑，忽略标签为AWB、Twinkle、回退功能的编辑。
2. 对每个diff进行判断，净增加量小于100字节的，排除掉这些diff。
3. 2步骤形成了涉及近期条目变化清单。按照清单里的条目，对每个条目的当前版本内容进行检查，检查规则参照tasks.aiEdit.rulePage提及页面进行。 AI分析应输出结构化数据格式，形成结构化分析结果。由程序来完成文字拼接。
4. 输出到日志文件，tasks.aiEdit.debugLog，格式：

```markdown
# 2026-09-28 17:09

## 条目名称

* diff: 12341234, 12341235, 12341236
* user: AAA, BBB, CCC （与diff一一对应）
* confidence: 0.2
* result:

1. 问题概述（位置）
分析：xxxx
2. ……

## 条目名称

* diff: 12341234, 12341235, 12341236
* user: AAA, BBB, CCC
* confidence: 0.5
* result:

1. 问题概述（位置）
分析：xxxx
2. ……

```

1. 如tasks.aiEdit.silent = false则按下面格式在User:AmanojakuBot/task/U3/check/2026-09 （具体到当前月份）写内容

```
== 2026-09-01 12:23 ==
=== 条目名称 ===
{{anchor|202609011223条目名称}}
{{main|条目名称}}

* Diff: [[Special:Diff/12341234|12341234]]<sup>[[User:用户1|用户1]]</sup>, [[Special:Diff/12341234|12341234]]<sup>[[User:用户2|用户2]]</sup>
* Confidence: 0.5
* 问题分析：【分析结论】

; 问题概述<small>（位置）</small>
: 分析：xxxx
; 问题概述<small>（位置）</small>
: 分析：xxxx
```

1. 如tasks.aiEdit.silent = false，且某个用户在三个不同的、confidence大于0.5的条目中，则在User:AmanojakuBot/task/U3/checkuser 记录该用户，格式（有重复标题时要合并、追加，而不是另外创建重复标题）：

```
== 2026-09 ==
* {{user|用户名}}：[[User:AmanojakuBot/task/U3/check/2026-09#202609011223条目名称|条目名称]]、[[User:AmanojakuBot/task/U3/check/2026-09#202609011223条目名称2|条目名称2]]、[[User:AmanojakuBot/task/U3/check/2026-09#202609011223条目名称3|条目名称3]]
* {{user|用户名}}：[[User:AmanojakuBot/task/U3/check/2026-09#202609011223条目名称|条目名称]]、[[User:AmanojakuBot/task/U3/check/2026-09#202609011223条目名称2|条目名称2]]、[[User:AmanojakuBot/task/U3/check/2026-09#202609011223条目名称3|条目名称3]]
```

### 3-2 疑似AI分析

工作流程类似afc.ts（监视tasks.aiEdit.talkPage，模板使用tasks.aiEdit.template），但是根据User:AmanojakuBot/task/U3/rule来判断条目内的疑似ai线索。

支持article1、article2……article20参数，按任务（日期+提交人用户名）将结果汇总到一个页面中。

页面展示可疑之处，作为发起AI调查的初步分析线索。该页面信息不代表确认或否认此人滥用AI。

### 3-3 疑问

如何制定客观的疑似滥用AI标准？

## TODO

识别跨语言链接
ai检查
