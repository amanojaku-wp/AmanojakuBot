import type { Logger } from "pino";

/**
 * 键控有界并发工作队列
 *
 * 架构定位（取代「所有事件共用一个串行队列」的旧做法）：
 * 旧实现把「归属判定」与「把这件事做完」耦合在同一个串行闭包里，导致任一耗时评审
 * （含多次 LLM 往返，单次可达数分钟）都会阻塞队列后面的所有事件与定时任务。
 * 现在把重活交给本模块，规则如下：
 *
 * 1. **同键串行**：同一 key（如 `talkPage#章节标题`）的任务严格按提交顺序先后执行，
 *    保证对同一维基页面的读-改-写不会互相覆盖；
 * 2. **异键并行**：不同 key 的任务并行执行，因此「讨论页 A 的评审」不再阻塞「讨论页 B 的请求」；
 * 3. **有界并发**：全局同时执行的任务数不超过 concurrency，避免打爆 LLM 限流与 MediaWiki API；
 * 4. **不丢任务**：并发已满时任务在队列中排队等待，绝不会像旧版请求锁那样「撞锁即跳过」；
 * 5. **可观测**：统计活动/排队任务数与排队等待时长，超时等待打 warn 日志。
 */
export type WorkQueueStats = {
  /** 并发上限 */
  concurrency: number;
  /** 正在执行的任务数 */
  active: number;
  /** 尚未开始执行的任务数（含同键排队） */
  queued: number;
  /** 有任务在身的键数量 */
  keys: number;
  completed: number;
  failed: number;
  /** 已完成任务中出现过的最大排队等待时长（毫秒） */
  maxWaitMs: number;
};

export type WorkQueue = {
  readonly concurrency: number;
  /**
   * 提交一个任务。
   *
   * 返回的 Promise 在任务真正执行完毕后 settle（成功 resolve / 失败 reject），
   * 因此「认领后异步执行」的调用方需要自行接住 rejection（见 handle.ts 的 runWork）。
   */
  submit(key: string, label: string, task: () => Promise<void>): Promise<void>;
  stats(): WorkQueueStats;
  /** 等待所有已提交任务（含排队中）结束；用于优雅停机 */
  drain(): Promise<void>;
};

type Job = {
  key: string;
  label: string;
  task: () => Promise<void>;
  enqueuedAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type KeyState = {
  jobs: Job[];
  /** 该键上是否有任务正在执行 */
  running: boolean;
  /** 是否已进入「等待空闲槽位」列表，避免重复入列 */
  awaitingSlot: boolean;
};

/**
 * 创建一个键控有界并发工作队列。
 */
export function createWorkQueue(options: {
  /** 全局并发上限（建议 2~4） */
  concurrency: number;
  log: Logger;
  /** 排队等待超过该时长时输出 warn 日志，默认 30 秒 */
  slowWaitMs?: number;
}): WorkQueue {
  const { log } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency) || 1);
  const slowWaitMs = options.slowWaitMs ?? 30_000;

  const keys = new Map<string, KeyState>();
  /** 有任务待执行、但尚未拿到并发槽位的键（FIFO） */
  const awaitingSlot: string[] = [];
  const idleWaiters: (() => void)[] = [];

  let active = 0;
  let completed = 0;
  let failed = 0;
  let maxWaitMs = 0;
  let outstanding = 0;

  const queuedCount = (): number => {
    let total = 0;
    for (const state of keys.values()) total += state.jobs.length;
    return total;
  };

  const settleIdle = (): void => {
    if (outstanding > 0) return;
    for (const waiter of idleWaiters.splice(0)) waiter();
  };

  /** 在并发额度允许的前提下，按 FIFO 启动尽可能多的键 */
  const pump = (): void => {
    while (active < concurrency && awaitingSlot.length > 0) {
      const key = awaitingSlot.shift()!;
      const state = keys.get(key);
      if (!state) continue;
      state.awaitingSlot = false;
      // 该键可能已被其它路径清空，或已因故处于执行中状态
      if (state.running || state.jobs.length === 0) continue;
      const job = state.jobs.shift()!;
      state.running = true;
      active++;
      void runJob(state, job);
    }
  };

  const runJob = async (state: KeyState, job: Job): Promise<void> => {
    const waitedMs = Date.now() - job.enqueuedAt;
    if (waitedMs > maxWaitMs) maxWaitMs = waitedMs;
    if (waitedMs >= slowWaitMs) {
      log.warn(
        {
          key: job.key,
          label: job.label,
          waitedMs,
          queued: queuedCount(),
          active,
        },
        "work item waited a long time in queue",
      );
    }

    const startedAt = Date.now();
    try {
      await job.task();
      completed++;
      log.debug(
        {
          key: job.key,
          label: job.label,
          waitedMs,
          runMs: Date.now() - startedAt,
          queued: queuedCount(),
          active,
        },
        "work item finished",
      );
      job.resolve();
    } catch (error) {
      // 失败不中断队列：错误原样交给提交方（runWork 会记录日志与 error_logs）
      failed++;
      job.reject(error);
    } finally {
      active--;
      outstanding--;
      state.running = false;
      if (state.jobs.length > 0) {
        // 同一键上还有后续任务：重新排队等待下一个槽位，保证与本次严格串行
        state.awaitingSlot = true;
        awaitingSlot.push(job.key);
      } else if (!state.awaitingSlot) {
        keys.delete(job.key);
      }
      settleIdle();
      pump();
    }
  };

  const submit = (
    key: string,
    label: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    const state = keys.get(key) ?? {
      jobs: [],
      running: false,
      awaitingSlot: false,
    };
    keys.set(key, state);

    return new Promise<void>((resolve, reject) => {
      outstanding++;
      state.jobs.push({
        key,
        label,
        task,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
      if (state.running || state.awaitingSlot) return;
      state.awaitingSlot = true;
      awaitingSlot.push(key);
      pump();
    });
  };

  return {
    concurrency,
    submit,
    stats: () => ({
      concurrency,
      active,
      queued: queuedCount(),
      keys: keys.size,
      completed,
      failed,
      maxWaitMs,
    }),
    drain: () => {
      if (outstanding === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}

/**
 * 键控互斥锁
 *
 * 与 {@link createWorkQueue} 的区别：互斥锁**不占用并发槽位**，只保证同一 key 上的临界区
 * 不重叠执行。用于「已持有并发槽位、还需要在临界区内再做一次页面级读-改-写」的场景
 * （如写入结果页），避免嵌套提交到有界队列造成槽位饥饿。
 */
export type KeyedMutex = {
  withLock<T>(key: string, label: string, task: () => Promise<T>): Promise<T>;
  /** 当前仍在排队或执行中的键数量（排查用） */
  size(): number;
};

export function createKeyedMutex(
  options: {
    log?: Logger;
    slowWaitMs?: number;
  } = {},
): KeyedMutex {
  const { log } = options;
  const slowWaitMs = options.slowWaitMs ?? 30_000;
  const tails = new Map<string, Promise<void>>();

  const withLock = <T>(
    key: string,
    label: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const enqueuedAt = Date.now();
    const previous = tails.get(key) ?? Promise.resolve();
    // 前一个临界区失败不应阻断后续临界区，因此先吞掉错误再执行本次任务
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const waitedMs = Date.now() - enqueuedAt;
        if (log && waitedMs >= slowWaitMs) {
          log.warn(
            { key, label, waitedMs },
            "keyed mutex waited a long time for page lock",
          );
        }
        return task();
      });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      // 仅当自己仍是队尾时才清理，避免误删后续排队者的链
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };

  return { withLock, size: () => tails.size };
}
