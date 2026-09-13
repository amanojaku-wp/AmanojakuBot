# MediaWiki agent — manual-testing build

Node.js / TypeScript daemon. Task 1: discussion chat; task 2: requested article/draft review; task 3: conservative AI-edit triage on two bot-owned user subpages. This build has **not** been exercised against a real wiki. Do not describe it as production-ready.

## Configuration and credentials

1. Run `npm install`, copy `config.example.yaml` to `config.yaml`, set the MediaWiki API URL, actual bot account (`wiki.username`), its talk/persona/control pages, and a wiki-specific `storage.dbPath`. If the login name uses a BotPassword suffix, set `wiki.loginUsername` separately; `wiki.username` remains the on-wiki username.
2. Supply `WIKI_BOT_PASSWORD` and either `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` in your process environment (not in YAML or Git). The project does **not** auto-load `.env`.
3. On the bot-owned control page put `enabled: true` and `emergencyStop: false`. Create the persona page. `writeEnabled: false` is the default; this is a genuine dry run: proposed replies/reports are logged and no wiki edit or review quota is committed. Set `writeEnabled: true` after examining the preview to allow authenticated edits. At each attempted write the control page is read again.
4. `npm run check` performs only static TypeScript validation; `npm start` runs the daemon. Automated tests are not required for the manual workflow.

The bot's only write destinations are the configured bot talk page and, if task 3 is enabled, its two configured bot-owned user subpages. Model output cannot choose a destination.

## Event source

`wiki.apiUrl` on `zh.wikipedia.org` defaults to EventStreams; other hosts default to RecentChanges polling. Override with `events.mode`. For non-zhwiki EventStreams, explicitly supply `wiki.wikiId` and `events.streamUrl`. Polling the discussion page is limited with `rctitle`. Enabling task 3 also polls article/draft namespace recent changes on non-EventStreams sites, which can consume many API calls; task 3 is disabled by default. The first polling run creates a fresh checkpoint instead of replying to historical edits. Keep a separate SQLite file per wiki.

## Manual acceptance path

1. Leave `writeEnabled: false`; add a signed, appended message to the bot talk page. Check the proposed chat reply in logs. A format-only change should not respond. Polling's first run only establishes its checkpoint, so add the message afterward.
2. Request `评审 [[条目标题]]` or `评审 https://<current-wiki>/wiki/条目标题` in a signed new message. Check the preview includes invalid/missing pages and quota logic. Requests accept existing namespace 0 or configured draft namespace targets, following redirects; non-owner quota is 10 first reviews per UTC day, with one recheck within 30 days. For the manual dry run no quota is consumed.
3. Only when ready, set `writeEnabled: true`, provide the bot credentials in the process environment, and start a fresh process. Post a **new** message and inspect the resulting bot talk page edit. Source revision markers avoid duplicate replies. A previously previewed revision will not be replayed automatically if its event checkpoint moved; post a new test request.
4. For task 3, first enable `tasks.aiEdit.enabled` with bot-owned report paths. Dry-run a deliberately created/expanded **article or draft** and inspect candidate reports after the UTC six-hour window closes. At most `maxAnalysesPerWindow` candidates are sent to the LLM per window (default 20). Check specific evidence and false positives manually. With live writes, report/user-page edits collectively occur no faster than once per six hours; the separate users page lists only accounts with evidence in three distinct article/draft titles and may be delayed by the publication cooldown.
5. Change the control page to `emergencyStop: true`; verify new write attempts stop. Then restore the desired state yourself. Use different credentials, pages, and DB files for local wiki/Miraheze vs zhwiki.

## Known gaps / cautions

- Discussion parsing only recognizes append-at-end, signed comments. New section insertions, unsigned comments, deleted/reordered text and nonstandard discussion systems can be missed. RC `bot` flags are not a complete bot-account lookup.
- Task 2 checks up to 50 supplied links, reviews only the first eligible pages within quota, and truncates large article text to 12,000 characters per page. Quota reservations occur before model generation in live mode; a failed generation can leave a reservation that retries under the same source revision. Review reports are provisional, not verified fact-checks.
- Task 3 intentionally caps analyses and skips short additions, large pages, anonymous/revision-hidden actors; this is **sampling/triage, not exhaustive detection**. A model's confidence is not evidence of authorship. No cross-window budget/cost accounting or independent human approval UI exists.
- If an SSE checkpoint is too old for upstream retention, there is no automatic Action API catch-up. Polling uses overlap and de-duplication, but RecentChanges retention can still expire during a long outage. This implementation has no authenticated live-wiki verification yet.
