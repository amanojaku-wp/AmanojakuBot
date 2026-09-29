import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Mwn } from "mwn";
import type { Logger } from "pino";
import type { AppConfig } from "./config/index.js";
import { chatHandler } from "./tasks/chat.js";
import { reviewHandler } from "./tasks/review.js";
import { aiEditHandler } from "./tasks/aiEditReview.js";
import { afcHandler } from "./tasks/afc.js";
import {
  EVENT_SAVE_SQL,
  listUnfinishedEvents,
  recordError,
} from "./utils/db.js";
import type { WorkQueue } from "./utils/workQueue.js";

/**
 * 维基变更事件数据结构
 */
export type ChangeEvent = {
  wiki?: string;
  type?: string;
  title?: string;
  namespace?: number;
  bot?: boolean;
  user?: string;
  revision?: { new?: number };
  length?: { old?: number; new?: number };
};

/**
 * 路由处理器依赖上下文
 */
export type HandlerContext = {
  db: DatabaseSync;
  bot: Mwn;
  cfg: AppConfig;
  log: Logger;
  canWrite: () => Promise<boolean>;
  seenStatement?: StatementSync;
  saveStatement?: StatementSync;
  /**
   * 键控有界并发工作队列（见 utils/workQueue）。
   *
   * 未注入时 runWork（见 utils/workDispatch）退化为同步内联执行，
   * 保持「认领即处理」的旧语义，便于单元测试与不关心并发调度的调用方。
   */
  schedule?: WorkQueue;
  /** 「事件认领」写入语句（events.state = claimed + 原始事件载荷） */
  claimStatement?: StatementSync;
};

/**
 * 处理器执行结果
 */
export type HandlerResult = {
  intercepted: boolean;
};

/**
 * 单个任务处理器接口定义
 */
export type TaskHandler = (
  e: ChangeEvent,
  ctx: HandlerContext,
) => Promise<HandlerResult | void>;

/**
 * 变更事件处理流水线
 *
 * 两阶段模型：
 * 1. **认领阶段**（本函数的调用过程）：只做归属判定、幂等校验、修订与章节定位，
 *    并在决定接管时把修订状态写为 `claimed`。此阶段必须保持轻量（毫秒~百毫秒级）。
 * 2. **工作阶段**（handler 内部经 runWork 派发）：LLM 调用与维基写入等重活交给
 *    键控有界并发队列，不同页面/章节可并行，同一页面严格串行。
 *
 * 一旦有处理器拦截（intercepted: true），则终止后续处理。
 */
export const handlers: TaskHandler[] = [
  chatHandler,
  reviewHandler,
  aiEditHandler,
  afcHandler,
];

/**
 * 回收上次运行期间「已认领但未完成」的事件（进程崩溃 / 被重启）。
 *
 * 背景：把重活交给并发队列后，事件凭据的推进不再等待工作完成，于是必须依赖
 * 认领期落库的 `events` 行来保证「至少一次」语义。重启时依据其中的原始事件载荷重新派发：
 * 工作阶段会重新读取当前维基页面复核，因此重复派发是幂等的。
 *
 * dry-run（writeEnabled=false）下不写入维基，没有持久副作用需要核对，直接跳过，
 * 避免每次重启都重放历史请求、白耗模型配额。
 */
export async function recoverUnfinishedEvents(
  ctx: HandlerContext,
  options: { withinHours?: number; limit?: number } = {},
): Promise<number> {
  const { log, cfg } = ctx;

  if (!cfg.writeEnabled) {
    log.info(
      "skipping unfinished-event recovery: writeEnabled=false (dry-run leaves no durable side effects)",
    );
    return 0;
  }

  const rows = listUnfinishedEvents(
    ctx.db,
    options.withinHours ?? 24,
    options.limit ?? 100,
  );
  if (rows.length === 0) return 0;

  log.warn(
    { count: rows.length, revids: rows.map((row) => row.revid) },
    "recovering events claimed before restart (durable claim recovery)",
  );

  let recovered = 0;
  for (const row of rows) {
    let event: ChangeEvent;
    try {
      event = JSON.parse(row.event_json) as ChangeEvent;
    } catch (error) {
      log.warn(
        { err: error, revid: row.revid },
        "unparsable claimed event payload, skipping recovery",
      );
      continue;
    }

    try {
      await handle(event, ctx);
      recovered++;
    } catch (error) {
      log.error(
        { err: error, revid: row.revid },
        "failed to recover unfinished event",
      );
    }
  }

  log.info({ recovered, total: rows.length }, "unfinished-event recovery done");
  return recovered;
}

/**
 * 变更事件主路由分发器
 */
export async function handle(
  e: ChangeEvent,
  ctx: HandlerContext,
): Promise<void> {
  for (const handler of handlers) {
    try {
      const result = await handler(e, ctx);
      if (result?.intercepted) {
        break;
      }
    } catch (error) {
      ctx.log.error({ err: error, event: e }, "handler execution failed");
      recordError(ctx.db, {
        message: "handler execution failed",
        error,
        context: { event: e },
      });
      throw error;
    }
  }
}
