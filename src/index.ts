import pino from "pino";
import { loadConfig } from "./config/index.js";
import {
  openDb,
  recordError,
  EVENT_CLAIM_SQL,
  EVENT_SAVE_SQL,
  EVENT_SEEN_SQL,
} from "./utils/db.js";
import { createWiki, pageText } from "./utils/wiki.js";
import { startChangeFeed } from "./utils/changeFeed.js";
import { scheduleCron } from "./utils/schedule.js";
import { createWorkQueue } from "./utils/workQueue.js";
import { configureLlmRuntime, llmRuntimeStats } from "./utils/llm.js";
import { cleanupBacklogReviews } from "./tasks/review.js";
import { cleanupBacklogAfcs } from "./tasks/afc.js";
import {
  publishAiReports,
  scanAiEdits,
  writeAiScanDailySummary,
} from "./tasks/aiEditMonitor.js";
import {
  handle,
  recoverUnfinishedEvents,
  type HandlerContext,
} from "./handle.js";

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// 全局注册代理分发器，使 fetch 自动遵循系统代理环境变量 (HTTP_PROXY / HTTPS_PROXY 等)
setGlobalDispatcher(new EnvHttpProxyAgent());

/**
 * 机器人常驻主服务守护进程入口
 *
 * 核心架构与设计模式：
 * 1. 两层队列（认领 / 执行分离）：
 *    - **认领队列** (`enqueue`)：极短的串行链，只负责「归属判定 + 幂等校验 + 位点推进 +
 *      认领落库」。保持串行是刻意的：事件位点的推进必须严格有序，且这一段只做同步 SQLite 写入，
 *      不存在耗时 IO，因此不会成为堆颈。
 *    - **工作队列** (`workQueue`)：LLM 调用与维基写入等重活，键控有界并发。同键（同一页面/章节）
 *      严格串行以保证页面写入互斥，异键并行以消除「一笔评审阻塞后续所有请求」的堆颈。
 * 2. 链上控制与紧急熔断 (`canWrite`)：认领阶段与写入阶段都读取控制页，
 *    实现外部维基页面对机器人行为的实时停止（emergencyStop）与启动（enabled）。
 * 3. 幂等与状态机保障：结合本地 SQLite 记录与维基页面 HTML 注释标记（source revid 锚点），
 *    防止网络重试、进程重启或位点回退导致重复回复；认领即落库（state=claimed），
 *    重启时由 handle.recoverUnfinishedEvents 回收上次未完成的工作。
 * 4. 变更事件源统一入口：EventStreams (SSE) 与 RecentChanges 轮询两种底层驱动都封装在
 *    `src/utils`（changeFeed / eventstream / polling），此处只保留一个参数形态一致的调用。
 * 5. 定时任务统一 cron 调度：任务二/任务四的积压兜底清理与任务三（3-1）定期扫描
 *    都由 `src/utils/schedule` 按 UTC 时区的 cron 表达式驱动；定时任务同样走工作队列，
 *    不再阻塞实时事件。
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

// -------------------------------------------------------------
// 全局闸门：后台工作并发上限 + LLM 并发/超时
// （认领与执行解耦后会有多笔工作并行，需要统一限流避免打爆 API/模型配额）
// -------------------------------------------------------------
const workQueue = createWorkQueue({
  concurrency: cfg.runtime.workConcurrency,
  slowWaitMs: cfg.runtime.slowWaitSeconds * 1000,
  log,
});
configureLlmRuntime({
  maxConcurrent: cfg.runtime.llmMaxConcurrent,
  timeoutMs: cfg.runtime.llmTimeoutSeconds * 1000,
});

// 预编译 SQLite 语句
const seen = db.prepare(EVENT_SEEN_SQL);
const save = db.prepare(EVENT_SAVE_SQL);
const claim = db.prepare(EVENT_CLAIM_SQL);

/** 串行认领队列的队尾（只包短临界区：归属判定、幂等校验、位点推进、认领落库） */
let queue: Promise<void> = Promise.resolve();

/**
 * 把任务追加到串行认领队列并返回该任务的完成 Promise。
 *
 * 队列自身吞掉异常（`queue` 始终保持 resolved），因此单次任务失败不会阻断后续任务；
 * 异常会原样抛给调用方，由调用方决定如何记录。
 *
 * 注意：这里只应包「短临界区」（同步 SQLite 写入 / 事件位点推进）。
 * LLM 调用与维基写入等重活请用 workQueue，否则又会退回「一笔耗时评审阻塞所有事件」。
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
  claimStatement: claim,
  schedule: workQueue,
};

/**
 * 把一个定时任务提交到工作队列（重活不入认领队列，避免阻塞实时事件），并兜底记录异常。
 *
 * 同一 label 的定时任务共用一个并发键，天然串行（叠加 scheduleCron 的「上轮未完则跳过本轮」）。
 */
async function runScheduled(
  label: string,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await workQueue.submit(`cron:${label}`, label, task);
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
// 崩溃恢复：回收上次运行期「已认领但未完成」的事件
// 重活异步执行后，事件位点不再等待工作完成，因此靠认领期落库的 events 行保证至少一次。
// dry-run（writeEnabled=false）下无持久副作用，函数内部会直接跳过。
// -------------------------------------------------------------
void (async () => {
  try {
    await recoverUnfinishedEvents(handlerContext);
  } catch (error) {
    log.error({ err: error }, "unfinished-event recovery failed");
  }
})();

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
// 位点推进：有 checkpoint 从位点开始；没有则回到上一个 cron 周期起点（不回溯更久远的历史）。
// -------------------------------------------------------------
if (cfg.tasks.aiEdit.enabled) {
  scheduleTask(cfg.tasks.aiEdit.cron, "aiEdit 3-1 scan", async () => {
    await scanAiEdits(handlerContext);
    await publishAiReports(handlerContext);
  });

  // 每日扫描成本汇总（tasks.aiEdit.summaryCron，默认每天 20:00 UTC）：
  // 把最近 24 小时的扫描统计与 Token 用量（含缓存命中）追加到 debugLog，便于核对「跳过规则」省下了多少额度。
  scheduleTask(cfg.tasks.aiEdit.summaryCron, "aiEdit 3-1 daily summary", () =>
    writeAiScanDailySummary(handlerContext),
  );
}

log.info(
  {
    mode: cfg.events.mode,
    apiUrl: cfg.wiki.apiUrl,
    writeEnabled: cfg.writeEnabled,
    workConcurrency: workQueue.concurrency,
    llm: llmRuntimeStats(),
  },
  "bot listening",
);

// -------------------------------------------------------------
// 运行状态可观测：定期输出队列深度 / 最长排队时长 / LLM 闸门占用
// （无任何活动时不输出，避免日志噪声）
// -------------------------------------------------------------
if (cfg.runtime.statsIntervalSeconds > 0) {
  const timer = setInterval(() => {
    const stats = workQueue.stats();
    const llm = llmRuntimeStats();
    if (
      stats.active === 0 &&
      stats.queued === 0 &&
      llm.active === 0 &&
      llm.waiting === 0
    ) {
      return;
    }
    log.info({ queue: stats, llm }, "runtime status");
  }, cfg.runtime.statsIntervalSeconds * 1000);
  timer.unref();
}

// -------------------------------------------------------------
// 优雅停机：等待在途工作完成（Toolforge 重部署 / 本地 Ctrl-C）
// 未完成的工作依赖下次启动的认领回收与定时兜底扫描补救。
// -------------------------------------------------------------
const SHUTDOWN_DRAIN_MS = 60_000;
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(
    { signal, stats: workQueue.stats() },
    "shutting down: draining in-flight work",
  );

  await Promise.race([
    workQueue.drain(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref();
    }),
  ]);

  log.info({ stats: workQueue.stats() }, "shutdown drain finished");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
