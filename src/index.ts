import pino from "pino";
import { loadConfig } from "./config/index.js";
import {
  openDb,
  recordError,
  EVENT_SAVE_SQL,
  EVENT_SEEN_SQL,
} from "./utils/db.js";
import { createWiki, pageText } from "./utils/wiki.js";
import { startChangeFeed } from "./utils/changeFeed.js";
import { scheduleCron } from "./utils/schedule.js";
import { cleanupBacklogReviews } from "./tasks/review.js";
import { cleanupBacklogAfcs } from "./tasks/afc.js";
import { publishAiReports, scanAiEdits } from "./tasks/aiEditMonitor.js";
import { handle, type HandlerContext } from "./handle.js";

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// 全局注册代理分发器，使 fetch 自动遵循系统代理环境变量 (HTTP_PROXY / HTTPS_PROXY 等)
setGlobalDispatcher(new EnvHttpProxyAgent());

/**
 * 机器人常驻主服务守护进程入口
 *
 * 核心架构与设计模式：
 * 1. 串行任务队列 (`enqueue`)：通过 Promise 链串行化处理所有事件消费与定时任务，
 *    彻底避免 SQLite 并发写入冲突与 MediaWiki 编辑冲突 (Edit Conflict)；
 *    单次任务失败只影响该次调用，不会阻断后续任务。
 * 2. 链上控制与紧急熔断 (`canWrite`)：在每一次写入维基前，动态拉取机器人配置的控制页，
 *    实现外部维基页面对机器人行为的实时停止（emergencyStop）与启动（enabled）。
 * 3. 幂等与状态机保障：结合本地 SQLite 记录与维基页面 HTML 注释标记（source revid 锚点），
 *    防止网络重试、进程重启或位点回退导致重复回复。
 * 4. 变更事件源统一入口：EventStreams (SSE) 与 RecentChanges 轮询两种底层驱动都封装在
 *    `src/utils`（changeFeed / eventstream / polling），此处只保留一个参数形态一致的调用。
 * 5. 定时任务统一 cron 调度：任务二/任务四的积压兜底清理与任务三（3-1）定期扫描
 *    都由 `src/utils/schedule` 按 UTC 时区的 cron 表达式驱动。
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

/** 串行任务调度队列的队尾 */
let queue: Promise<void> = Promise.resolve();

/**
 * 把任务追加到串行队列并返回该任务的完成 Promise。
 *
 * 队列自身吞掉异常（`queue` 始终保持 resolved），因此单次任务失败不会阻断后续任务；
 * 异常会原样抛给调用方，由调用方决定如何记录。
 */
const enqueue = (task: () => Promise<void>): Promise<void> => {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
};

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

/**
 * 把一个定时任务串行编排进全局队列，并兜底记录异常。
 */
async function runScheduled(
  label: string,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await enqueue(task);
  } catch (error) {
    log.error({ err: error, label }, "scheduled task failed");
  }
}

/**
 * 按 cron 表达式登记一个串行化的定时任务。
 */
function scheduleTask(
  expression: string,
  label: string,
  task: () => Promise<void>,
): void {
  scheduleCron({
    expression,
    label,
    log,
    run: () => runScheduled(label, task),
  });
}

// -------------------------------------------------------------
// 变更事件监听：EventStreams (SSE) / RecentChanges 轮询
// 两种底层机制均由 src/utils 内部按 mode 选择，这里只保留一个统一调用。
// -------------------------------------------------------------
startChangeFeed({
  mode: cfg.events.mode,
  cfg,
  db,
  bot,
  log,
  enqueue,
  onEvent: (event) => handle(event, handlerContext),
});

// -------------------------------------------------------------
// 任务二：积压校对请求兜底清理（启动时立即执行一次，之后按 cleanupCron 定期执行）
// -------------------------------------------------------------
if (cfg.tasks.review.enabled) {
  const label = "review backlog cleanup";
  const task = () => cleanupBacklogReviews(handlerContext);
  void runScheduled(label, task); // 启动时兜底
  scheduleTask(cfg.tasks.review.cleanupCron, label, task);
}

// -------------------------------------------------------------
// 任务四：积压 AfC 请求兜底清理（启动时立即执行一次，之后按 cleanupCron 定期执行）
// -------------------------------------------------------------
if (cfg.tasks.afc.enabled) {
  const label = "afc backlog cleanup";
  const task = () => cleanupBacklogAfcs(handlerContext);
  void runScheduled(label, task); // 启动时兜底
  scheduleTask(cfg.tasks.afc.cleanupCron, label, task);
}

// -------------------------------------------------------------
// 任务三（3-1）：按 tasks.aiEdit.cron 定期执行动态扫描
// 扫描完成后立即汇总发布（tasks.aiEdit.silent=true 时仅写本地 debugLog，不写维基）
// 首次 tick 仅建立基准位点，不回溯历史编辑。
// -------------------------------------------------------------
if (cfg.tasks.aiEdit.enabled) {
  scheduleTask(cfg.tasks.aiEdit.cron, "aiEdit 3-1 scan", async () => {
    await scanAiEdits(handlerContext);
    await publishAiReports(handlerContext);
  });
}

log.info(
  {
    mode: cfg.events.mode,
    apiUrl: cfg.wiki.apiUrl,
    writeEnabled: cfg.writeEnabled,
  },
  "bot listening",
);
