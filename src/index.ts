import { EventSource } from "eventsource";
import pino from "pino";
import { loadConfig } from "./config/index.js";
import {
  openDb,
  recordError,
  EVENT_SAVE_SQL,
  EVENT_SEEN_SQL,
} from "./utils/db.js";
import { createWiki, pageText } from "./utils/wiki.js";
import { fetchRecentChanges, pollingStart } from "./utils/polling.js";
import { cleanupBacklogReviews } from "./tasks/review.js";
import { publishReports } from "./tasks/aiEdit.js";
import { handle, type ChangeEvent, type HandlerContext } from "./handle.js";

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// 全局注册代理分发器，使 fetch 自动遵循系统代理环境变量 (HTTP_PROXY / HTTPS_PROXY 等)
setGlobalDispatcher(new EnvHttpProxyAgent());

/**
 * 机器人常驻主服务守护进程入口
 *
 * 核心架构与设计模式：
 * 1. 串行任务队列 (`queue`)：通过 Promise 链串行化处理所有事件消费与定时发版任务，
 *    彻底避免 SQLite 并发写入冲突与 MediaWiki 编辑冲突 (Edit Conflict)。
 * 2. 链上控制与紧急熔断 (`canWrite`)：在每一次写入维基前，动态拉取机器人配置的控制页，
 *    实现外部维基页面对机器人行为的实时停止（emergencyStop）与启动（enabled）。
 * 3. 幂等与状态机保障：结合本地 SQLite 记录与维基页面 HTML 注释标记（source revid 锚点），
 *    防止网络重试、进程重启或位点回退导致重复回复。
 * 4. 双事件驱动支持：支持 Wikimedia EventStreams (SSE) 高效流式消费与 Action API 定期重叠轮询。
 */

const cfg = loadConfig(process.env.CONFIG_PATH ?? "config.yaml");
const db = openDb(cfg.storage.dbPath);

const log = pino({
  level: process.env.LOG_LEVEL ?? cfg.log.level,
  hooks: {
    logMethod(inputArgs, method, level) {
      if (level >= 50) {
        try {
          let err: unknown;
          let msg = "";
          let context: unknown;
          if (typeof inputArgs[0] === "object" && inputArgs[0] !== null) {
            const obj = inputArgs[0] as Record<string, unknown>;
            err = obj.err ?? obj.error;
            const rest = { ...obj };
            delete rest.err;
            delete rest.error;
            context = Object.keys(rest).length > 0 ? rest : undefined;
            msg = typeof inputArgs[1] === "string" ? inputArgs[1] : "";
          } else if (typeof inputArgs[0] === "string") {
            msg = inputArgs[0];
          }
          recordError(db, {
            level: level >= 60 ? "fatal" : "error",
            message: msg || (err instanceof Error ? err.message : "Error"),
            error: err,
            context,
          });
        } catch {
          // 防止日志记录异常影响主链路
        }
      }
      return method.apply(this, inputArgs);
    },
  },
});

const bot = createWiki(
  cfg.wiki.apiUrl,
  cfg.wiki.loginUsername ?? cfg.wiki.username,
  process.env.WIKI_BOT_PASSWORD ?? "",
);

if (cfg.writeEnabled && !process.env.WIKI_BOT_PASSWORD) {
  throw new Error("WIKI_BOT_PASSWORD required for writes");
}
if (cfg.writeEnabled) {
  await bot.login();
}

// 预编译 SQLite 语句
const seen = db.prepare(EVENT_SEEN_SQL);
const save = db.prepare(EVENT_SAVE_SQL);
const mark = db.prepare(
  "INSERT OR REPLACE INTO checkpoint(name,event_id,timestamp) VALUES(?,?,?)",
);
const checkpoint = db.prepare(
  "SELECT event_id,timestamp FROM checkpoint WHERE name=?",
);

const streamKey = `stream:${cfg.events.streamUrl}:${cfg.wiki.wikiId ?? "default"}`;
let lastEventId = (
  checkpoint.get(streamKey) as { event_id?: string } | undefined
)?.event_id;

/** 串行任务调度队列 */
let queue = Promise.resolve();

/**
 * 实时读取维基链上控制页面，校验机器人是否处于允许运行且未触发紧急停止的状态
 */
async function canWrite(): Promise<boolean> {
  const control = await pageText(bot, cfg.wiki.controlPage);
  return (
    /^enabled:\s*true\s*$/m.test(control) &&
    !/^emergencyStop:\s*true\s*$/m.test(control)
  );
}

const handlerContext: HandlerContext = {
  db,
  bot,
  cfg,
  log,
  canWrite,
  seenStatement: seen,
  saveStatement: save,
};

// watchdog
let lastActivityAt = Date.now();
const IDLE_TIMEOUT = 5 * 60_000;
function touch() {
  lastActivityAt = Date.now();
}

// -------------------------------------------------------------
// 事件监听驱动：EventStreams (SSE) vs RecentChanges Polling
// -------------------------------------------------------------
if (cfg.events.mode === "eventstream") {
  let prevSource: EventSource | null = null;
  const createSource = () => {
    if (prevSource !== null) {
      prevSource.close();
    }
    const source = new EventSource(cfg.events.streamUrl, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          },
        }),
    });
    source.addEventListener("message", (event) => {
      queue = queue.then(async () => {
        try {
          touch();
          await handle(JSON.parse(event.data) as ChangeEvent, handlerContext);
          if (event.lastEventId) {
            lastEventId = event.lastEventId;
            mark.run(streamKey, lastEventId, new Date().toISOString());
          }
        } catch (error) {
          log.error(
            { err: error },
            "event processing failed; checkpoint unchanged",
          );
          source.close();
          process.exit(1);
        }
      });
    });
    source.addEventListener("error", (error) =>
      log.warn(
        { err: error },
        "stream disconnected; EventSource will reconnect",
      ),
    );
    source.addEventListener("open", () => {
      touch();
      log.info({}, "stream connected; EventSource is open");
    });
    prevSource = source;
  };

  createSource();
  // watchdog: 如果 EventSource 5 分钟内没有收到任何事件，则认为可能卡死，强制重连
  setInterval(() => {
    const idleMs = Date.now() - lastActivityAt;

    if (idleMs > IDLE_TIMEOUT) {
      log.warn({ idleMs }, "EventSource appears stalled");
      createSource();
    }
  }, 30_000);
} else {
  const request = (params: Record<string, string | number>) =>
    bot.request(params);

  const poll = async (
    key: string,
    title: string | undefined,
    namespaces?: number[],
  ) => {
    const end = new Date().toISOString();
    const previous = (checkpoint.get(key) as { timestamp?: string } | undefined)
      ?.timestamp;
    if (!previous) {
      mark.run(key, null, end); // 首次启动建立基准位点，不补回历史留言
      return;
    }
    const changes = await fetchRecentChanges(
      request,
      title,
      pollingStart(previous, cfg.events.overlapSeconds),
      end,
      namespaces,
    );
    //if (changes.length > 0) {
    //  log.debug({ changes }, "fetched recent changes for polling");
    //}
    for (const rc of changes) {
      await handle(
        {
          wiki: cfg.wiki.wikiId,
          type: rc.type,
          title: rc.title,
          namespace: rc.ns,
          bot: rc.bot,
          user: rc.user,
          revision: { new: rc.revid },
        },
        handlerContext,
      );
    }
    mark.run(key, null, end); // 整批变更全部成功后再提交位点
  };

  const tick = async () => {
    if (cfg.tasks.chat.enabled) {
      try {
        await poll(
          `poll:chat:${cfg.wiki.apiUrl}:${cfg.tasks.chat.talkPage}`,
          cfg.tasks.chat.talkPage,
        );
      } catch (error) {
        log.error(
          { err: error },
          "chat discussion polling failed; retaining checkpoint",
        );
      }
    }
    if (cfg.tasks.review.enabled) {
      try {
        await poll(
          `poll:review:${cfg.wiki.apiUrl}:${cfg.tasks.review.talkPage}`,
          cfg.tasks.review.talkPage,
        );
      } catch (error) {
        log.error(
          { err: error },
          "review discussion polling failed; retaining checkpoint",
        );
      }
    }
    if (cfg.tasks.aiEdit.enabled) {
      try {
        await poll(`ai:${cfg.wiki.apiUrl}`, undefined, [
          0,
          cfg.tasks.aiEdit.draftNamespace,
        ]);
      } catch (error) {
        log.error(
          { err: error },
          "article polling failed; retaining checkpoint",
        );
      }
    }
    setTimeout(tick, cfg.events.pollIntervalSeconds * 1000);
  };
  void tick();
}

// -------------------------------------------------------------
// 任务二：定期/启动清理积压校对请求兜底机制（启动时及每 1 小时执行一次）
// -------------------------------------------------------------
if (cfg.tasks.review.enabled) {
  const runReviewCleanup = async () => {
    // 串行编排入全局任务队列，确保清理操作与事件处理互斥执行
    queue = queue.then(() => cleanupBacklogReviews(handlerContext));
    try {
      await queue;
    } catch (error) {
      log.error({ err: error }, "backlog review cleanup failed");
      queue = Promise.resolve();
    }
    setTimeout(runReviewCleanup, 3600_000);
  };
  void runReviewCleanup();
}

// -------------------------------------------------------------
// 任务三：定时报告发布任务（每 60 秒轮询检查是否有满足条件的窗口可发布）
// -------------------------------------------------------------
if (cfg.tasks.aiEdit.enabled) {
  const reportCfg = {
    draftNamespace: cfg.tasks.aiEdit.draftNamespace,
    models: cfg.tasks.aiEdit.models,
    minConfidence: cfg.tasks.aiEdit.minConfidence,
    maxAnalysesPerWindow: cfg.tasks.aiEdit.maxAnalysesPerWindow,
    reportPagePrefix: cfg.tasks.aiEdit.reportPagePrefix!,
    usersPage: cfg.tasks.aiEdit.usersPage!,
    writeEnabled: cfg.writeEnabled,
  };
  const publish = async () => {
    // 串行编排入全局任务队列，确保发版操作与事件处理互斥执行
    queue = queue.then(() => publishReports(db, bot, reportCfg, canWrite));
    try {
      await queue;
    } catch (error) {
      log.error({ err: error }, "report publication failed");
      queue = Promise.resolve();
    }
    setTimeout(publish, 60_000);
  };
  setTimeout(publish, 60_000);
}

log.info(
  {
    mode: cfg.events.mode,
    apiUrl: cfg.wiki.apiUrl,
    writeEnabled: cfg.writeEnabled,
  },
  "bot listening",
);
