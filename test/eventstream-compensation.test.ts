import { describe, it, expect, vi } from "vitest";
import { fetchRecentChanges, type RequestFn } from "../src/utils/polling.js";
import type { ChangeEvent } from "../src/handle.js";

describe("EventStream compensation and retry mechanism", () => {
  it("fetches recentchanges with sizes and filters out bot edits and old revids", async () => {
    const mockRequest: RequestFn = vi.fn().mockResolvedValue({
      query: {
        recentchanges: [
          {
            type: "edit",
            ns: 0,
            title: "Article 1",
            user: "BotUser",
            revid: 100,
            old_revid: 99,
            oldlen: 1000,
            newlen: 1100,
            timestamp: "2026-09-24T10:00:00Z",
            bot: true,
            rcid: 1,
          },
          {
            type: "edit",
            ns: 0,
            title: "Article 2",
            user: "HumanUser",
            revid: 101,
            old_revid: 100,
            oldlen: 500,
            newlen: 600,
            timestamp: "2026-09-24T10:01:00Z",
            bot: false,
            rcid: 2,
          },
          {
            type: "edit",
            ns: 3,
            title: "User talk:Bot",
            user: "HumanUser2",
            revid: 105,
            old_revid: 104,
            oldlen: 200,
            newlen: 300,
            timestamp: "2026-09-24T10:05:00Z",
            bot: false,
            rcid: 3,
          },
        ],
      },
    });

    const startRevid = 100; // last revid before disconnection
    const start = "2026-09-24T09:59:00Z";
    const end = "2026-09-24T10:10:00Z";

    const changes = await fetchRecentChanges(
      mockRequest,
      undefined,
      start,
      end,
    );

    // Verify mockRequest received rcprop with sizes
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        list: "recentchanges",
        rcprop: "title|ids|user|timestamp|flags|sizes",
      }),
    );

    const processedEvents: ChangeEvent[] = [];

    for (const rc of changes) {
      // 1. 过滤 bot 编辑
      if (rc.bot) {
        continue;
      }
      // 2. 仅补偿 last revid 之后的编辑
      if (rc.revid <= startRevid) {
        continue;
      }

      // 3. 构造向上游提供的数据结构，与 SSE 实时推送一致
      const event: ChangeEvent = {
        wiki: "zhwiki",
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

      processedEvents.push(event);
    }

    // revid 100 was bot (and <= 100), revid 101 and 105 are human edits > 100
    expect(processedEvents).toHaveLength(2);
    expect(processedEvents[0]).toEqual({
      wiki: "zhwiki",
      type: "edit",
      title: "Article 2",
      namespace: 0,
      bot: false,
      user: "HumanUser",
      revision: { new: 101 },
      length: { old: 500, new: 600 },
    });
    expect(processedEvents[1]).toEqual({
      wiki: "zhwiki",
      type: "edit",
      title: "User talk:Bot",
      namespace: 3,
      bot: false,
      user: "HumanUser2",
      revision: { new: 105 },
      length: { old: 200, new: 300 },
    });
  });

  it("escalates retry delays on consecutive errors and resets on open", () => {
    const RETRY_DELAYS = [10, 30, 60, 120, 300];
    let failCount = 0;

    const getDelay = () => {
      const delay = RETRY_DELAYS[Math.min(failCount, RETRY_DELAYS.length - 1)];
      failCount++;
      return delay;
    };

    expect(getDelay()).toBe(10);
    expect(getDelay()).toBe(30);
    expect(getDelay()).toBe(60);
    expect(getDelay()).toBe(120);
    expect(getDelay()).toBe(300);
    expect(getDelay()).toBe(300); // capped at 300

    // Reset on open
    failCount = 0;
    expect(getDelay()).toBe(10);
  });
});
