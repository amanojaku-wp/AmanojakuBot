import { EVENT_SAVE_SQL, EVENT_STATE_FAILED, recordError } from "./db.js";
import type { HandlerContext } from "../handle.js";

/**
 * 后台工作派发
 *
 * 为什么单独一个模块：任务处理器（tasks/*）与 requestWorkflow 都需要派发后台工作，
 * 而 handle.ts 又要 import 任务处理器。如果这里放进 handle.ts，就会形成
 * `handle → tasks → requestWorkflow → handle` 的运行时循环，触发顶层常量 TDZ 报错。
 * 本模块只依赖 db / workQueue，且对 HandlerContext 仅做**类型**引用（编译后擦除），
 * 因此不引入任何运行时循环。
 */

/** 一次后台工作的定位信息（用于日志与失败时的状态回写） */
export type WorkTarget = {
  /** 并发调度键：同键串行、异键并行 */
  key: string;
  /** 日志标签 */
  label: string;
  /** 触发本次工作的修订号（失败时标记为 failed，便于排查与回溯） */
  revid?: number;
};

/**
 * 派发一次后台工作。
 *
 * - 已注入工作队列：提交后立即返回，调用方（认领阶段）不再被重活阻塞；
 * - 未注入工作队列（如单元测试）：内联 await，保持「认领即处理」的同步语义。
 *
 * 后台失败不会向上游抛出（认领阶段已经返回），而是记录日志 + error_logs，
 * 并把该修订标记为 failed：后续重复投递会被重试，定时兜底扫描也会补处理。
 */
export async function runWork(
  ctx: HandlerContext,
  target: WorkTarget,
  task: () => Promise<void>,
): Promise<void> {
  const { schedule } = ctx;
  if (!schedule) {
    await task();
    return;
  }

  void schedule.submit(target.key, target.label, task).catch((error) => {
    ctx.log.error(
      { err: error, key: target.key, label: target.label },
      "background work failed",
    );
    recordError(ctx.db, {
      message: "background work failed",
      error,
      context: { key: target.key, label: target.label },
    });

    if (target.revid && target.revid > 0) {
      try {
        const save = ctx.saveStatement ?? ctx.db.prepare(EVENT_SAVE_SQL);
        save.run(
          target.revid,
          EVENT_STATE_FAILED,
          null,
          null,
          null,
          null,
          null,
        );
      } catch {
        // 状态回写失败不影响主流程
      }
    }
  });
}
