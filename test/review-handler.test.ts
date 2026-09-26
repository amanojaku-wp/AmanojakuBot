import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mwn } from "mwn";
import pino, { type Logger } from "pino";
import { openDb } from "../src/utils/db.js";
import {
  acquireReviewLock,
  clearAllReviewLocks,
  cleanupBacklogReviews,
  isReviewLocked,
  releaseReviewLock,
  reviewHandler,
} from "../src/tasks/review.js";
import type { AppConfig } from "../src/config/index.js";
import type { HandlerContext, ChangeEvent } from "../src/handle.js";

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return {
    ...original,
    generateObject: vi.fn().mockImplementation(async ({ prompt }) => {
      if (
        typeof prompt === "string" &&
        prompt.includes("下面是多个独立检查单元")
      ) {
        return {
          object: {
            issues: [
              {
                severity: "confirmed",
                category: "language",
                title: "发现一处错别字",
                location: "第1段",
                originalText: "测试错字",
                description: "应为正确用字",
                suggestion: "修改为正字",
              },
            ],
          },
          usage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
        };
      }
      if (typeof prompt === "string" && prompt.includes("非百科页面测试")) {
        return {
          object: {
            isEncyclopedic: false,
            nonEncyclopedicReason: "系统测试与沙盒涂鸦",
            summary: "页面为测试涂鸦，非百科全书条目。",
            issues: [],
          },
          usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
        };
      }
      if (typeof prompt === "string" && prompt.includes("当前检查单元：")) {
        return {
          object: {
            issues: [
              {
                severity: "confirmed",
                category: "language",
                title: "发现一处错别字",
                location: "第1段",
                originalText: "测试错字",
                description: "应为正确用字",
                suggestion: "修改为正字",
              },
            ],
          },
          usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
        };
      }
      if (typeof prompt === "string" && prompt.includes("【校对规则】")) {
        return {
          object: {
            isEncyclopedic: true,
            summary: "条目语言流畅，发现一处错别字。",
            issues: [
              {
                severity: "confirmed",
                category: "language",
                title: "发现一处错别字",
                location: "第1段",
                originalText: "测试错字",
                description: "应为正确用字",
                suggestion: "修改为正字",
              },
            ],
          },
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      }
      if (typeof prompt === "string" && prompt.includes("草稿页面：")) {
        return {
          object: {
            name: "某某人物",
            confidence: "high",
          },
          usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
        };
      }
      return {
        object: {},
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    }),
  };
});

describe("Task 2 reviewHandler", () => {
  let db: ReturnType<typeof openDb>;
  let mockBot: {
    request: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    edit: ReturnType<typeof vi.fn>;
  };
  let cfg: AppConfig;
  let logger: Logger;
  let canWriteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearAllReviewLocks();
    db = openDb(":memory:");
    logger = pino({ level: "silent" }) as unknown as Logger;
    canWriteMock = vi.fn().mockResolvedValue(true);

    mockBot = {
      request: vi.fn(),
      read: vi.fn(),
      edit: vi.fn().mockResolvedValue({ newrevid: 9999 }),
    };

    cfg = {
      wiki: {
        apiUrl: "https://zh.wikipedia.org/w/api.php",
        username: "AmanojakuBot",
        controlPage: "User:AmanojakuBot/config/control",
        timestampFormat: "zhwiki",
        writeEnabled: true,
        talkPage: "User talk:AmanojakuBot",
        personaPage: "User:AmanojakuBot/config/persona",
      },
      events: {
        mode: "eventstream",
        streamUrl: "https://stream.wikimedia.org/v2/stream/recentchange",
        pollIntervalSeconds: 60,
        overlapSeconds: 60,
        allowBotEdits: false,
      },
      storage: {
        dbPath: "bot.sqlite",
      },
      log: {
        level: "info",
        responseTokenOnWiki: false,
      },
      writeEnabled: true,
      tasks: {
        chat: {
          enabled: true,
          talkPage: "User talk:AmanojakuBot",
          personaPage: "User:AmanojakuBot/config/persona",
          models: [{ provider: "openai", model: "gpt-5.6-luna" }],
        },
        review: {
          enabled: true,
          draftNamespace: [2, 118],
          draftNamespaces: [2, 118],
          userDailyLimit: 5,
          talkPage: "User talk:AmanojakuBot/review",
          rulePage: "User:AmanojakuBot/task/2/rule",
          template: "User:AmanojakuBot/template/ReviewRequest",
          models: [{ provider: "openai", model: "gpt-5.6-luna" }],
        },
        aiEdit: {
          enabled: false,
          draftNamespace: 118,
          maxAnalysesPerWindow: 20,
          minConfidence: 0.85,
          models: [],
        },
      },
    } as AppConfig;
  });

  it("ignores events from other pages or users", async () => {
    const event: ChangeEvent = {
      wiki: "zhwiki",
      type: "edit",
      title: "User talk:AmanojakuBot", // not review talk page
      namespace: 3,
      user: "Alice",
      revision: { new: 100 },
    };

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(false);
  });

  it("replies with standard template prompt when section lacks template", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 101 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 请求校对 ==\n请帮我校对一下条目！--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.prop === "revisions" && params.revids === 101) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 101,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);
    expect(mockBot.edit).toHaveBeenCalled();
    const editCall = mockBot.edit.mock.calls[0];
    expect(editCall[0]).toBe("User talk:AmanojakuBot/review");

    const transformFn = editCall[1];
    const transformed = transformFn({ content: afterContent });
    expect(transformed.text).toContain(
      "请点击上方按钮，使用标准请求模板进行申请。",
    );
  });

  it("skips sections already marked as status = done or not done", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 102 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 请求章节 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status = done
| oldid = 88888
}}
留言--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 102) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 102,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);
    expect(mockBot.edit).not.toHaveBeenCalled();
  });

  it("skips processing when requester signature does not match revision actor", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Mallory",
      revision: { new: 103 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 请求 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
伪造签名--[[User:Bob|Bob]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 103) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 103,
                    user: "Mallory",
                    userid: 99,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);
    expect(mockBot.edit).not.toHaveBeenCalled();
  });

  it("rejects request when user daily limit is exceeded", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 104 },
    };

    const today = new Date().toISOString().slice(0, 10);
    // Pre-populate 5 completed requests for Alice
    for (let i = 1; i <= 5; i++) {
      db.prepare(
        `INSERT INTO review_requests (source_revid, actor_id, username, article, status, utc_day, created_at)
         VALUES (?, 42, 'Alice', '条目', 'completed', ?, datetime('now'))`,
      ).run(1000 + i, today);
    }

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 请求 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
请校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 104) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 104,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);
    expect(mockBot.edit).toHaveBeenCalled();
    const editCall = mockBot.edit.mock.calls[0];
    const transformFn = editCall[1];
    const transformed = transformFn({ content: afterContent });

    expect(transformed.text).toContain("| status = not done");
    expect(transformed.text).toContain("今日次数已用完，将于明日重置。");
  });

  it("handles missing target page gracefully", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 105 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 请求 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 不存在的条目
| status =
}}
请校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 105) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 105,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.titles === "不存在的条目") {
        return Promise.resolve({
          query: {
            pages: [{ title: "不存在的条目", missing: true }],
          },
        });
      }
      return Promise.resolve({});
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);
    expect(mockBot.edit).toHaveBeenCalled();
    const editCall = mockBot.edit.mock.calls[0];
    const transformFn = editCall[1];
    const transformed = transformFn({ content: afterContent });

    expect(transformed.text).toContain("| status = not done");
    expect(transformed.text).toContain("不存在，无法进行校对");
  });

  it("rejects target page in disallowed namespace", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 106 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 请求 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = Template:SomeTemplate
| status =
}}
请校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 106) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 106,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.titles === "Template:SomeTemplate") {
        return Promise.resolve({
          query: {
            pages: [{ title: "Template:SomeTemplate", ns: 10 }],
          },
        });
      }
      return Promise.resolve({});
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);
    expect(mockBot.edit).toHaveBeenCalled();
    const editCall = mockBot.edit.mock.calls[0];
    const transformFn = editCall[1];
    const transformed = transformFn({ content: afterContent });

    expect(transformed.text).toContain("| status = not done");
    expect(transformed.text).toContain("位于无效命名空间");
  });

  it("successfully completes proofreading for namespace 0 article", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 107 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 校对请求 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
请帮忙校对！--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 107) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 107,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.titles === "测试条目") {
        return Promise.resolve({
          query: {
            pages: [
              {
                title: "测试条目",
                ns: 0,
                revisions: [
                  {
                    revid: 77777,
                    slots: {
                      main: {
                        content: "这是测试条目的正文内容。测试错字在这里。",
                      },
                    },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    mockBot.read.mockImplementation((title: string) => {
      if (title === "User:AmanojakuBot/task/2/rule") {
        return Promise.resolve({
          revisions: [{ content: "规则：严格检查错别字与语病。" }],
        });
      }
      if (title.startsWith("User talk:AmanojakuBot/review/")) {
        // Result page doesn't exist yet
        return Promise.resolve({ revisions: [] });
      }
      return Promise.resolve({ revisions: [{ content: "" }] });
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);

    // Verify 2 edits: 1 for result page, 1 for talk page
    expect(mockBot.edit).toHaveBeenCalledTimes(2);

    // Check Result page edit
    const resultPageEdit = mockBot.edit.mock.calls[0];
    expect(resultPageEdit[0]).toBe("User talk:AmanojakuBot/review/测试条目");
    const resultPageTransform = resultPageEdit[1];
    const resultPageRes = resultPageTransform({ content: "" });
    expect(resultPageRes.text).toContain("{{Talkarchive}}");
    expect(resultPageRes.text).toContain("[[Special:Permalink/77777|77777]]");
    expect(resultPageRes.text).toContain(
      "【校对概述】条目语言流畅，发现一处错别字。",
    );
    expect(resultPageRes.text).toContain("=== 确认问题 ===");
    expect(resultPageRes.text).toContain("<!-- 确认问题 -->");
    expect(resultPageRes.text).toContain("; 1.<!-- 语言文字 -->发现一处错别字");
    expect(resultPageRes.text).toContain(": '''原文'''：{{tq|测试错字}}");
    expect(resultPageRes.text).toContain("第二轮发现遗漏的参考资料问题");

    // Check Talk page edit
    const now = new Date();
    const expectedDate = `${now.getUTCFullYear()}年${now.getUTCMonth() + 1}月${now.getUTCDate()}日`;
    const talkPageEdit = mockBot.edit.mock.calls[1];
    expect(talkPageEdit[0]).toBe("User talk:AmanojakuBot/review");
    const talkPageTransform = talkPageEdit[1];
    const talkPageRes = talkPageTransform({ content: afterContent });
    expect(talkPageRes.text).toContain("| status = done");
    expect(talkPageRes.text).toContain("| oldid = 77777");
    expect(talkPageRes.text).toContain(`| section = ${expectedDate}`);
    expect(talkPageRes.text).toContain("{{ping|Alice}}校对已完成");
    expect(talkPageRes.text).toContain(
      "【校对概述】条目语言流畅，发现一处错别字。",
    );

    // Check database
    const reqRow = db
      .prepare("SELECT * FROM review_requests WHERE source_revid = 107")
      .get() as Record<string, unknown>;
    expect(reqRow).toBeDefined();
    expect(reqRow.status).toBe("completed");
    expect(reqRow.article).toBe("测试条目");
    expect(reqRow.article_revid).toBe(77777);
    expect(reqRow.result_name).toBe("测试条目");
  });

  it("infers article title for User namespace draft and sets resultpage", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 108 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 草稿校对 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = User:Alice/sandbox
| status =
}}
草稿请校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 108) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 108,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.titles === "User:Alice/sandbox") {
        return Promise.resolve({
          query: {
            pages: [
              {
                title: "User:Alice/sandbox",
                ns: 2,
                revisions: [
                  {
                    revid: 66666,
                    slots: {
                      main: {
                        content:
                          "'''某某人物'''（1990年－），是一名测试人物...",
                      },
                    },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    mockBot.read.mockImplementation(() => {
      return Promise.resolve({ revisions: [] });
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);

    // Verify Result page edit target is inferred name
    const resultPageEdit = mockBot.edit.mock.calls[0];
    expect(resultPageEdit[0]).toBe("User talk:AmanojakuBot/review/某某人物");

    // Verify Talk page edit has resultpage set
    const talkPageEdit = mockBot.edit.mock.calls[1];
    const talkPageTransform = talkPageEdit[1];
    const talkPageRes = talkPageTransform({ content: afterContent });
    expect(talkPageRes.text).toContain("| status = done");
    expect(talkPageRes.text).toContain("| oldid = 66666");
    expect(talkPageRes.text).toContain("| resultpage = 某某人物");
  });

  it("handles duplicate section titles by appending sequence number", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 109 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 再次校对 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
第二次校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 109) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 109,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.titles === "测试条目") {
        return Promise.resolve({
          query: {
            pages: [
              {
                title: "测试条目",
                ns: 0,
                revisions: [
                  {
                    revid: 77778,
                    slots: { main: { content: "更新后的内容。" } },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const now = new Date();
    const expectedDate = `${now.getUTCFullYear()}年${now.getUTCMonth() + 1}月${now.getUTCDate()}日`;
    const existingResultPage = `{{Talkarchive}}\n\n== ${expectedDate} ==\n早些时候的校对记录`;
    mockBot.read.mockImplementation((title: string) => {
      if (title === "User talk:AmanojakuBot/review/测试条目") {
        return Promise.resolve({
          revisions: [{ content: existingResultPage }],
        });
      }
      return Promise.resolve({ revisions: [] });
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);

    // Verify Result page has unique section == ${expectedDate} (2) ==
    const resultPageEdit = mockBot.edit.mock.calls[0];
    const resultPageTransform = resultPageEdit[1];
    const resultPageRes = resultPageTransform({ content: existingResultPage });
    expect(resultPageRes.text).toContain(`== ${expectedDate} (2) ==`);
    // Should NOT duplicate {{Talkarchive}}
    expect(
      (resultPageRes.text.match(/\{\{Talkarchive\}\}/g) || []).length,
    ).toBe(1);

    // Verify Talk page section parameter matches
    const talkPageEdit = mockBot.edit.mock.calls[1];
    const talkPageTransform = talkPageEdit[1];
    const talkPageRes = talkPageTransform({ content: afterContent });
    expect(talkPageRes.text).toContain(`| section = ${expectedDate} (2)`);
  });

  it("correctly replies to the second section when page has multiple sections with the same title", async () => {
    const existingSection1 = `== 测试条目 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status = done
| oldid = 11111
| section = 2026年9月19日
}}
:{{ping|Bob}}校对已完成。~~~~`;

    const newSection2 = `== 测试条目 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
新的校对申请--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    const fullTalkContent = `${existingSection1}\n\n${newSection2}`;

    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 110 },
    };

    const timestamp = "2026-09-20T12:00:00Z";

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 110) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 110,
                    parentid: 109,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: fullTalkContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.revids === 109) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 109,
                    slots: { main: { content: existingSection1 } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.titles === "测试条目") {
        return Promise.resolve({
          query: {
            pages: [
              {
                title: "测试条目",
                ns: 0,
                revisions: [
                  {
                    revid: 77779,
                    slots: { main: { content: "测试条目正文" } },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    mockBot.read.mockImplementation(() => Promise.resolve({ revisions: [] }));

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);

    const talkPageEdit = mockBot.edit.mock.calls[1];
    const talkPageTransform = talkPageEdit[1];
    const updatedTalk = talkPageTransform({ content: fullTalkContent });

    // Section 1 should remain untouched with status = done and oldid = 11111
    expect(updatedTalk.text)
      .toContain(`| oldid = 11111\n| section = 2026年9月19日\n}}
:{{ping|Bob}}校对已完成。`);

    // Section 2 should be updated with status = done, oldid = 77779, and ping Alice
    expect(updatedTalk.text).toContain(`| oldid = 77779`);
    expect(updatedTalk.text).toContain(`{{ping|Alice}}校对已完成`);
  });

  it("rejects review and marks not done when target page content is blank", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 111 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 空白页面校对 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 空白页面
| status =
}}
请校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 111) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 111,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.titles === "空白页面") {
        return Promise.resolve({
          query: {
            pages: [
              {
                title: "空白页面",
                ns: 0,
                revisions: [
                  {
                    revid: 88801,
                    slots: { main: { content: "  <!-- 仅有注释 -->  \n" } },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);
    expect(mockBot.edit).toHaveBeenCalledTimes(1);

    const talkPageEdit = mockBot.edit.mock.calls[0];
    const talkPageTransform = talkPageEdit[1];
    const transformed = talkPageTransform({ content: afterContent });

    expect(transformed.text).toContain("| status = not done");
    expect(transformed.text).toContain("内容为空，无法进行校对");

    const reqRow = db
      .prepare("SELECT * FROM review_requests WHERE source_revid = 111")
      .get() as Record<string, unknown>;
    expect(reqRow).toBeDefined();
    expect(reqRow.status).toBe("rejected");
    expect(reqRow.error).toBe("empty_content");
  });

  it("rejects review and marks not done when page is non-encyclopedic content", async () => {
    const event: ChangeEvent = {
      type: "edit",
      title: "User talk:AmanojakuBot/review",
      namespace: 3,
      user: "Alice",
      revision: { new: 112 },
    };

    const timestamp = "2026-09-20T12:00:00Z";
    const afterContent = `== 非百科内容校对 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 非百科页面测试
| status =
}}
请校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    mockBot.request.mockImplementation((params: Record<string, unknown>) => {
      if (params.revids === 112) {
        return Promise.resolve({
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 112,
                    user: "Alice",
                    userid: 42,
                    timestamp,
                    slots: { main: { content: afterContent } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.titles === "非百科页面测试") {
        return Promise.resolve({
          query: {
            pages: [
              {
                title: "非百科页面测试",
                ns: 0,
                revisions: [
                  {
                    revid: 88802,
                    slots: {
                      main: {
                        content: "非百科页面测试正文：asdf 12345 纯测试",
                      },
                    },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    mockBot.read.mockImplementation(() => Promise.resolve({ revisions: [] }));

    const ctx: HandlerContext = {
      db,
      bot: mockBot as unknown as Mwn,
      cfg,
      log: logger,
      canWrite: canWriteMock,
    };

    const res = await reviewHandler(event, ctx);
    expect(res?.intercepted).toBe(true);
    expect(mockBot.edit).toHaveBeenCalledTimes(1);

    const talkPageEdit = mockBot.edit.mock.calls[0];
    const talkPageTransform = talkPageEdit[1];
    const transformed = talkPageTransform({ content: afterContent });

    expect(transformed.text).toContain("| status = not done");
    expect(transformed.text).toContain(
      "内容明显非百科全书条目或草稿（原因：系统测试与沙盒涂鸦），不予校对。",
    );

    const reqRow = db
      .prepare("SELECT * FROM review_requests WHERE source_revid = 112")
      .get() as Record<string, unknown>;
    expect(reqRow).toBeDefined();
    expect(reqRow.status).toBe("rejected");
    expect(reqRow.error).toBe("non_encyclopedic");
  });

  describe("review locking mechanism", () => {
    it("manages lock acquisition, querying and release correctly", () => {
      const talkPage = "User talk:AmanojakuBot/review";
      const section = "== 请求校对：测试 ==";
      const revid = 999;

      expect(isReviewLocked(talkPage, section, revid)).toBe(false);

      const acquired = acquireReviewLock(talkPage, section, revid, "测试");
      expect(acquired).toBe(true);

      // Subsequent attempt with same section or revid should be locked
      expect(isReviewLocked(talkPage, section)).toBe(true);
      expect(isReviewLocked(talkPage, "other section", revid)).toBe(true);
      expect(acquireReviewLock(talkPage, section)).toBe(false);

      releaseReviewLock(talkPage, section, revid);
      expect(isReviewLocked(talkPage, section, revid)).toBe(false);
    });

    it("skips reviewHandler execution when request is already locked by another process", async () => {
      const event: ChangeEvent = {
        type: "edit",
        title: "User talk:AmanojakuBot/review",
        namespace: 3,
        user: "Alice",
        revision: { new: 201 },
      };

      const timestamp = "2026-09-20T12:00:00Z";
      const afterContent = `== 请求校对 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
校对请求--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

      mockBot.request.mockImplementation((params: Record<string, unknown>) => {
        if (params.revids === 201) {
          return Promise.resolve({
            query: {
              pages: [
                {
                  revisions: [
                    {
                      revid: 201,
                      user: "Alice",
                      userid: 42,
                      timestamp,
                      slots: { main: { content: afterContent } },
                    },
                  ],
                },
              ],
            },
          });
        }
        return Promise.resolve({});
      });

      // Manually acquire lock before handler runs
      acquireReviewLock(cfg.tasks.review.talkPage, "请求校对", 201);

      const ctx: HandlerContext = {
        db,
        bot: mockBot as unknown as Mwn,
        cfg,
        log: logger,
        canWrite: canWriteMock,
      };

      const res = await reviewHandler(event, ctx);
      expect(res?.intercepted).toBe(true);
      // Because it was locked, bot.edit should NOT have been called
      expect(mockBot.edit).not.toHaveBeenCalled();
    });

    it("skips cleanupBacklogReviews for sections currently locked", async () => {
      const talkContent = `== 正在校对的章节 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 条目A
| status =
}}
--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)

== 未锁定的章节 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 不存在的条目
| status =
}}
--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

      mockBot.read.mockImplementation((title: string) => {
        if (title === cfg.tasks.review.talkPage) {
          return Promise.resolve({ revisions: [{ content: talkContent }] });
        }
        return Promise.resolve({ revisions: [] });
      });

      mockBot.request.mockImplementation((params: Record<string, unknown>) => {
        if (
          params.action === "query" &&
          params.prop === "revisions" &&
          params.titles === cfg.tasks.review.talkPage
        ) {
          return Promise.resolve({
            query: {
              pages: [
                {
                  revisions: [
                    {
                      revid: 300,
                      user: "Alice",
                      userid: 42,
                      timestamp: "2026-09-20T12:00:00Z",
                      slots: { main: { content: talkContent } },
                    },
                  ],
                },
              ],
            },
          });
        }
        if (params.titles === "不存在的条目") {
          return Promise.resolve({
            query: {
              pages: [{ title: "不存在的条目", missing: true }],
            },
          });
        }
        return Promise.resolve({});
      });

      // Lock "正在校对的章节"
      acquireReviewLock(cfg.tasks.review.talkPage, "正在校对的章节");

      const ctx: HandlerContext = {
        db,
        bot: mockBot as unknown as Mwn,
        cfg,
        log: logger,
        canWrite: canWriteMock,
      };

      await cleanupBacklogReviews(ctx);

      // Only the unlocked section ("未锁定的章节") should be processed and edited
      expect(mockBot.edit).toHaveBeenCalledTimes(1);
      const editCall = mockBot.edit.mock.calls[0];
      const transformFn = editCall[1];
      const transformed = transformFn({ content: talkContent });
      expect(transformed.text).toContain("页面“不存在的条目”不存在");
    });
  });
});
