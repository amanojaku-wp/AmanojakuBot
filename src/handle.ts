import type Database from "better-sqlite3";
import type { Mwn } from "mwn";
import type { Logger } from "pino";
import type { AppConfig } from "./config/index.js";
import { chatHandler } from "./tasks/chat.js";
import { reviewHandler } from "./tasks/review.js";
import { aiEditHandler } from "./tasks/aiEdit.js";

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
  db: Database.Database;
  bot: Mwn;
  cfg: AppConfig;
  log: Logger;
  canWrite: () => Promise<boolean>;
  seenStatement?: Database.Statement;
  saveStatement?: Database.Statement;
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
 * 按顺序执行各任务处理器，一旦有处理器拦截（intercepted: true），则终止后续处理。
 */
export const handlers: TaskHandler[] = [
  chatHandler,
  reviewHandler,
  aiEditHandler,
];

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
      throw error;
    }
  }
}
