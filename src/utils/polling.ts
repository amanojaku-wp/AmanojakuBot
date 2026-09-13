/**
 * MediaWiki RecentChanges API 增量事件数据结构
 */
export type RecentChange = {
  type: string;
  ns: number;
  title: string;
  user: string;
  revid: number;
  timestamp: string;
  bot?: boolean;
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
      rcprop: "title|ids|user|timestamp|flags",
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
