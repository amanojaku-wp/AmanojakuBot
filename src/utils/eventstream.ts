import { EventSource } from "eventsource";
import type { DatabaseSync } from "node:sqlite";
import type { Mwn } from "mwn";
import type { Logger } from "pino";
import type { AppConfig } from "../config/index.js";
import type { ChangeEvent } from "../handle.js";
import { fetchRecentChanges, pollingStart } from "./polling.js";

/**
 * Wikimedia EventStreams (SSE) 事件监听驱动
 *
 * 可靠性设计：
 * 1. SSE checkpoint：同时记录 `lastEventId` 与 `last_revid`，断线续传时回传 `Last-Event-ID`。
 * 2. 断线自动重连：按 10/30/60/120/300 秒递增超时强制重连，避免 EventSource 内部静默重试卡死。
 * 3. 遗漏补偿：重连成功后按 checkpoint 经由 `list=recentchanges` 补齐断线期间的编辑，
 *    并向调用方提供与实时推送完全一致的 ChangeEvent 结构。
 */
export type EventStreamFeedOptions = {
  cfg: AppConfig;
  db: DatabaseSync;
  bot: Mwn;
  log: Logger;
  /** 串行任务队列：把处理任务追加到全局队列，保证与其它定时任务互斥执行 */
  enqueue: (task: () => Promise<void>) => Promise<void>;
  /** 与驱动方式无关的单条变更事件处理入口 */
  onEvent: (event: ChangeEvent) => Promise<void>;
};

/** SSE 断线重连的递增等待超时（秒）。 */
const RETRY_DELAYS_SECONDS = [10, 30, 60, 120, 300];

/**
 * 启动 EventStreams SSE 监听（常驻，不返回）。
 */
export function startEventStreamFeed(options: EventStreamFeedOptions): void {
  const { cfg, db, bot, log, enqueue, onEvent } = options;

  const mark = db.prepare(
    "INSERT OR REPLACE INTO checkpoint(name,event_id,timestamp,last_revid) VALUES(?,?,?,?)",
  );
  const checkpoint = db.prepare(
    "SELECT event_id,timestamp,last_revid FROM checkpoint WHERE name=?",
  );

  const streamKey = `stream:${cfg.events.streamUrl}:${cfg.wiki.wikiId ?? "default"}`;
  const initialCheckpoint = checkpoint.get(streamKey) as
    { event_id?: string; timestamp?: string; last_revid?: number } | undefined;
  let lastEventId = initialCheckpoint?.event_id;
  let lastRevid = initialCheckpoint?.last_revid;
  let checkpointTimestamp = initialCheckpoint?.timestamp;

  let prevSource: EventSource | null = null;
  let errorTimer: NodeJS.Timeout | null = null;
  let failCount = 0;

  const request = (params: Record<string, string | number>) =>
    bot.request(params);

  /** 断线补偿：用 RecentChanges 补齐 lastRevid 之后遗漏的编辑。 */
  const compensateMissingEdits = async (
    startRevid: number,
    startTimestamp?: string,
  ) => {
    let start = startTimestamp
      ? pollingStart(startTimestamp, cfg.events.overlapSeconds)
      : undefined;

    if (!start) {
      try {
        const res = await bot.request({
          action: "query",
          prop: "revisions",
          revids: startRevid,
          rvprop: "timestamp",
          formatversion: 2,
        });
        const revTimestamp = res.query?.pages?.[0]?.revisions?.[0]?.timestamp;
        if (revTimestamp) {
          start = pollingStart(revTimestamp, cfg.events.overlapSeconds);
        }
      } catch {
        // fallback
      }
    }
    if (!start) {
      start = new Date(Date.now() - 3600_000).toISOString();
    }
    const end = new Date().toISOString();

    log.info(
      { startRevid, start, end },
      "compensating missing edits via recentchanges",
    );

    const changes = await fetchRecentChanges(request, undefined, start, end);

    let count = 0;
    for (const rc of changes) {
      // 1. 过滤 bot 编辑
      if (rc.bot) {
        continue;
      }
      // 2. 仅对 last revid 之后的编辑进行补偿
      if (rc.revid <= startRevid) {
        continue;
      }

      // 3. 补偿时向上游提供的数据结构和实时推送一样
      const changeEvent: ChangeEvent = {
        wiki: cfg.wiki.wikiId,
        type: rc.type,
        title: rc.title,
        namespace: rc.ns,
        bot: rc.bot,
        user: rc.user,
        revision: { new: rc.revid },
        length:
          rc.oldlen !== undefined && rc.newlen !== undefined
            ? { old: rc.oldlen, new: rc.newlen }
            : undefined,
      };

      await onEvent(changeEvent);

      count++;
      if (rc.revid > (lastRevid ?? 0)) {
        lastRevid = rc.revid;
      }
      checkpointTimestamp = new Date().toISOString();
      mark.run(
        streamKey,
        lastEventId ?? null,
        checkpointTimestamp,
        lastRevid ?? null,
      );
    }

    log.info({ count, lastRevid }, "compensation completed");
  };

  const createSource = () => {
    if (prevSource !== null) {
      try {
        prevSource.close();
      } catch {
        // ignore
      }
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
      void enqueue(async () => {
        try {
          const data = JSON.parse(event.data) as ChangeEvent;
          await onEvent(data);
          if (data.revision?.new) {
            lastRevid = data.revision.new;
          }
          if (event.lastEventId) {
            lastEventId = event.lastEventId;
          }
          checkpointTimestamp = new Date().toISOString();
          mark.run(
            streamKey,
            lastEventId ?? null,
            checkpointTimestamp,
            lastRevid ?? null,
          );
        } catch (error) {
          // 位点不可信时直接退出，交由进程管理器依据 checkpoint 重新拉起并补偿。
          log.error(
            { err: error },
            "event processing failed; checkpoint unchanged",
          );
          source.close();
          process.exit(1);
        }
      });
    });

    source.addEventListener("error", (error) => {
      log.warn(
        { err: error },
        "stream disconnected; EventSource encountered error",
      );

      if (errorTimer) {
        clearTimeout(errorTimer);
        errorTimer = null;
      }
      const delaySec =
        RETRY_DELAYS_SECONDS[
          Math.min(failCount, RETRY_DELAYS_SECONDS.length - 1)
        ];
      failCount++;

      log.warn(
        { delaySec, failCount },
        `EventSource error; waiting ${delaySec}s before forcing reconnect`,
      );

      errorTimer = setTimeout(() => {
        errorTimer = null;
        log.warn(
          { delaySec },
          "EventSource did not open within timeout; forcing reconnect",
        );
        if (prevSource) {
          try {
            prevSource.close();
          } catch {
            // ignore
          }
          prevSource = null;
        }
        createSource();
      }, delaySec * 1000);
    });

    source.addEventListener("open", () => {
      log.info({}, "stream connected; EventSource is open");

      if (errorTimer) {
        clearTimeout(errorTimer);
        errorTimer = null;
      }
      failCount = 0;

      if (lastRevid) {
        const compensateFromRevid = lastRevid;
        const compensateFromTime = checkpointTimestamp;
        void enqueue(async () => {
          try {
            await compensateMissingEdits(
              compensateFromRevid,
              compensateFromTime,
            );
          } catch (err) {
            log.error({ err }, "compensation during stream open failed");
          }
        });
      }
    });

    prevSource = source;
  };

  createSource();
}
