import { Cron } from "croner";
import type { Logger } from "pino";

/**
 * 机器人定时任务统一 cron 调度
 *
 * 设计要点：
 * 1. 统一时区：所有 cron 表达式一律按 UTC 解释（与任务二每日额度、报告月份等 UTC 语义保持一致），
 *    避免依赖宿主机本地时区导致调度时刻漂移。
 * 2. 不重叠执行：同一个定时任务的上一轮尚未结束时，跳过本轮（避免 LLM 调用过长时叠加执行）。
 * 3. 配置即校验：`isValidCron` 供配置层 (Zod) 复用，非法表达式在启动阶段即快速失败。
 */
export const CRON_TIMEZONE = "UTC";

/**
 * 校验 cron 表达式是否合法（5/6/7 段或 @hourly 等别名，时区固定 UTC）。
 */
export function isValidCron(expression: string): boolean {
  try {
    new Cron(expression, { paused: true, timezone: CRON_TIMEZONE });
    return true;
  } catch {
    return false;
  }
}

export type CronScheduleOptions = {
  /** cron 表达式（UTC 时区解释） */
  expression: string;
  /** 日志中的任务名，用于区分多个定时任务 */
  label: string;
  log: Logger;
  /** 单个 tick 的执行体；返回的 Promise 完成前不会再次触发本轮任务 */
  run: () => Promise<void>;
};

/**
 * 登记一个 cron 定时任务并开始调度。
 *
 * - 任务体内抛出的异常在此兜底捕获，不会中断进程，也不会产生未处理拒绝。
 * - 单次执行过久时跳过后续 tick，避免任务叠加。
 */
export function scheduleCron(options: CronScheduleOptions): Cron {
  const { expression, label, log, run } = options;

  let running = false;
  const job = new Cron(expression, { timezone: CRON_TIMEZONE }, async () => {
    if (running) {
      log.warn({ label, expression }, "cron task still running, skip tick");
      return;
    }
    running = true;
    try {
      await run();
    } catch (error) {
      log.error({ err: error, label }, "cron task failed");
    } finally {
      running = false;
    }
  });

  log.info(
    { label, expression, timezone: CRON_TIMEZONE, next: job.nextRun() },
    "cron task scheduled",
  );
  return job;
}
