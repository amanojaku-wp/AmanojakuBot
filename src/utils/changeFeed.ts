import type { DatabaseSync } from "node:sqlite";
import type { Mwn } from "mwn";
import type { Logger } from "pino";
import type { AppConfig } from "../config/index.js";
import type { ChangeEvent } from "../handle.js";
import { startEventStreamFeed } from "./eventstream.js";
import { startPollingFeed } from "./polling.js";

/**
 * 维基变更事件源统一入口
 *
 * 把两种底层驱动（Wikimedia EventStreams SSE / RecentChanges 定期轮询）都收敛到本模块，
 * 上层只调用参数形态完全一致的 {@link startChangeFeed}，无需感知具体驱动：
 * - 分发结果统一为 ChangeEvent，由 onEvent 处理；
 * - 两种驱动都通过 enqueue 走同一条串行任务队列，避免与定时任务并发。
 */
export type ChangeFeedMode = "eventstream" | "polling";

export type ChangeFeedOptions = {
  /** 事件监听模式（由配置 events.mode 决定） */
  mode: ChangeFeedMode;
  cfg: AppConfig;
  db: DatabaseSync;
  bot: Mwn;
  log: Logger;
  /** 串行任务队列：把处理任务追加到全局队列，保证与其它定时任务互斥执行 */
  enqueue: (task: () => Promise<void>) => Promise<void>;
  /** 与驱动方式无关的单条变更事件处理入口 */
  onEvent: (event: ChangeEvent) => Promise<void>;
};

/**
 * 按配置启动变更事件监听（常驻，不返回）。
 */
export function startChangeFeed(options: ChangeFeedOptions): void {
  const { mode, log } = options;
  log.info({ mode }, "starting wiki change feed");

  if (mode === "eventstream") {
    startEventStreamFeed(options);
    return;
  }
  startPollingFeed(options);
}
