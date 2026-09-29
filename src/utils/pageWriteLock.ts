import type { Logger } from "pino";
import { createKeyedMutex } from "./workQueue.js";

/**
 * 维基页面写入互斥
 *
 * 并发化的代价：不同请求的工作现在可以同时运行（不同页面/章节），但**对同一个维基页面的
 * 读-改-写绝不能重叠**，否则会出现丢更新（`bot.save` 全量覆盖）或编辑冲突
 * （`bot.edit` 基于旧 revid 提交）。
 *
 * 因此把「同一页面串行」收敛到这一把进程内互斥锁，覆盖三类写入：
 * 1. 讨论页请求章节的就地回报（replyToRequest）；
 * 2. 结果页的「读取现有章节 → 生成唯一标题 → 全量写回」临界区；
 * 3. 其它针对单一页面的读改写流程。
 *
 * 与 utils/workQueue 的键控队列不同，互斥锁不占用并发槽位，可安全地嵌套在已持有
 * 槽位的工作任务内部（避免嵌套提交造成槽位饥饿）。
 *
 * 加锁顺序约定：**先结果页、后讨论页**（各任务天然就是这个顺序：先写结果页再回报请求章节），
 * 只要所有调用点遵守该顺序就不会死锁。
 */
const pageMutex = createKeyedMutex();

/** 排队等待超过该时长即输出 warn（毫秒） */
const SLOW_LOCK_MS = 30_000;

function pageKey(page: string): string {
  return `page:${page.replaceAll("_", " ").trim().toLowerCase()}`;
}

/**
 * 在「同一页面串行」的临界区内执行任务。
 *
 * @param log 用于输出排队超时告警
 * @param page 目标维基页面名（内部会做大小写/下划线归一化）
 * @param label 日志标签（如 reply / result page）
 */
export async function withWikiPageLock<T>(
  log: Logger,
  page: string,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const enqueuedAt = Date.now();
  let acquiredAt = enqueuedAt;

  const result = await pageMutex.withLock(pageKey(page), label, async () => {
    acquiredAt = Date.now();
    return task();
  });

  const waitedMs = acquiredAt - enqueuedAt;
  if (waitedMs >= SLOW_LOCK_MS) {
    log.warn(
      { page, label, waitedMs },
      "wiki page write lock waited a long time",
    );
  }

  return result;
}
