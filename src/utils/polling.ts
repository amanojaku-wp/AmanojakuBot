import type { DatabaseSync } from "node:sqlite";
import type { Mwn } from "mwn";
import type { Logger } from "pino";
import type { AppConfig } from "../config/index.js";
import type { ChangeEvent } from "../handle.js";

/**
 * MediaWiki RecentChanges API 增量事件数据结构
 */
export type RecentChange = {
  type: string;
  ns: number;
  title: string;
  user: string;
  revid: number;
  old_revid?: number;
  oldlen?: number;
  newlen?: number;
  timestamp: string;
  bot?: boolean;
  /** 匿名（IP）编者标记，`rcprop=flags` 会返回该布尔字段 */
  anon?: boolean;
  /** 变更标签（如 AWB、Twinkle、回退功能），用于排除机械化/回退编辑 */
  tags?: string[];
  rcid: number;
};

export type RequestFn = (params: Record<string, string | number>) => Promise<{
  query?: { recentchanges?: RecentChange[] };
  continue?: { rccontinue?: string; continue?: string };
}>;

/**
 * 轮询拉取指定时间窗口内的 MediaWiki 近期变更 (RecentChanges)
 *
 * 业务与可靠性保障：
 * 1. 窗口增量读取：通过 `rcstart` 与 `rcend` 限定时间切片，并按时间正序 (`rcdir: "newer"`) 分页拉取。
 * 2. 分页游标完全遍历：严格处理 MediaWiki 的 `rccontinue` 游标，确保一个时间窗口内的所有变更全部加载至内存。
 * 3. 位点提交原则：必须由调用方在整批变更完全处理成功后统一推进 checkpoint，保证 At-least-once 语义。
 */
export async function fetchRecentChanges(
  request: RequestFn,
  title: string | undefined,
  start: string,
  end: string,
  namespaces?: number[],
): Promise<RecentChange[]> {
  const changes: RecentChange[] = [];
  let continuation: string | undefined;
  do {
    const response = await request({
      action: "query",
      list: "recentchanges",
      ...(title ? { rctitle: title } : {}),
      ...(namespaces ? { rcnamespace: namespaces.join("|") } : {}),
      rctype: "edit|new",
      rcprop: "title|ids|user|timestamp|flags|sizes|tags",
      rcdir: "newer",
      rcstart: start,
      rcend: end,
      rclimit: 100,
      formatversion: 2,
      ...(continuation ? { rccontinue: continuation } : {}),
    });
    if (!response.query?.recentchanges)
      throw new Error("RecentChanges response missing query data");
    changes.push(...response.query.recentchanges);
    continuation = response.continue?.rccontinue;
  } while (continuation);
  return changes;
}

/**
 * 计算带回溯重叠的轮询起始时间
 *
 * 容错设计：
 * 从上次 checkpoint 时间向前回溯 `overlapSeconds`（默认 60 秒），以对抗维基主从数据库同步延迟与服务器时钟偏差。
 * 重叠期间产生的重复修订由底层 SQLite 状态机（`events` / `ai_analyzed` 表）实现幂等去重。
 */
export function pollingStart(
  checkpoint: string,
  overlapSeconds: number,
): string {
  return new Date(Date.parse(checkpoint) - overlapSeconds * 1000).toISOString();
}

/**
 * RecentChanges 轮询驱动配置
 */
export type PollingFeedOptions = {
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
 * 启动 RecentChanges 定期轮询（常驻，不返回）
 *
 * 可靠性设计：
 * 1. 每个受监听的讨论页各维护独立 checkpoint，首次运行仅建立基准位点，不回溯历史留言。
 * 2. 整批变更全部成功处理后才推进位点，保证 At-least-once 语义（重叠窗口内的重复由幂等状态机去重）。
 * 3. 每个页面的轮询任务都经过串行队列，避免与定时清理/扫描任务并发写入 SQLite 或产生编辑冲突。
 * 4. 轮询窗口的上界固定为「本次 tick 开始时刻」：tick 本身也是串行的（前一个 tick 完成后才排下一个），
 *    若把上界推迟到任务实际执行时刻，队列积压期间到达的编辑将被永久跳过。
 */
export function startPollingFeed(options: PollingFeedOptions): void {
  const { cfg, db, bot, log, enqueue, onEvent } = options;

  const mark = db.prepare(
    "INSERT OR REPLACE INTO checkpoint(name,event_id,timestamp,last_revid) VALUES(?,?,?,?)",
  );
  const checkpoint = db.prepare(
    "SELECT event_id,timestamp,last_revid FROM checkpoint WHERE name=?",
  );

  const request = (params: Record<string, string | number>) =>
    bot.request(params);

  const poll = async (
    key: string,
    title: string | undefined,
    end: string,
    namespaces?: number[],
  ) => {
    const previous = (checkpoint.get(key) as { timestamp?: string } | undefined)
      ?.timestamp;
    if (!previous) {
      mark.run(key, null, end, null); // 首次启动建立基准位点，不补回历史留言
      return;
    }
    const changes = await fetchRecentChanges(
      request,
      title,
      pollingStart(previous, cfg.events.overlapSeconds),
      end,
      namespaces,
    );
    for (const rc of changes) {
      await onEvent({
        wiki: cfg.wiki.wikiId,
        type: rc.type,
        title: rc.title,
        namespace: rc.ns,
        bot: rc.bot,
        user: rc.user,
        revision: { new: rc.revid },
      });
    }
    mark.run(key, null, end, null); // 整批变更全部成功后再提交位点
  };

  const tick = async () => {
    // 窗口上界在本次 tick 开始时即固定：本 tick 的检查任务经串行队列排队，可能因前序任务
    // （如多个耗时评审）而推迟数分钟才真正执行。若改用任务执行时刻作为上界，推迟期间新增的
    // 编辑就会被永久跳过（首次建立基准位点时尤其致命），故此处统一取 tick 开始时刻。
    const end = new Date().toISOString();
    if (cfg.tasks.chat.enabled) {
      try {
        await enqueue(() =>
          poll(
            `poll:chat:${cfg.wiki.apiUrl}:${cfg.tasks.chat.talkPage}`,
            cfg.tasks.chat.talkPage,
            end,
          ),
        );
      } catch (error) {
        log.error(
          { err: error },
          "chat discussion polling failed; retaining checkpoint",
        );
      }
    }
    if (cfg.tasks.review.enabled) {
      try {
        await enqueue(() =>
          poll(
            `poll:review:${cfg.wiki.apiUrl}:${cfg.tasks.review.talkPage}`,
            cfg.tasks.review.talkPage,
            end,
          ),
        );
      } catch (error) {
        log.error(
          { err: error },
          "review discussion polling failed; retaining checkpoint",
        );
      }
    }
    if (cfg.tasks.afc.enabled) {
      try {
        await enqueue(() =>
          poll(
            `poll:afc:${cfg.wiki.apiUrl}:${cfg.tasks.afc.talkPage}`,
            cfg.tasks.afc.talkPage,
            end,
          ),
        );
      } catch (error) {
        log.error(
          { err: error },
          "afc discussion polling failed; retaining checkpoint",
        );
      }
    }
    // 任务三（3-2）：模板请求监听页在轮询模式下同样需要拉取
    if (cfg.tasks.aiEdit.enabled && cfg.tasks.aiEdit.talkPage) {
      try {
        await enqueue(() =>
          poll(
            `poll:aiEdit:${cfg.wiki.apiUrl}:${cfg.tasks.aiEdit.talkPage}`,
            cfg.tasks.aiEdit.talkPage,
            end,
          ),
        );
      } catch (error) {
        log.error(
          { err: error },
          "aiEdit discussion polling failed; retaining checkpoint",
        );
      }
    }
    setTimeout(tick, cfg.events.pollIntervalSeconds * 1000);
  };

  void tick();
}
