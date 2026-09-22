import { describe, it, expect, vi } from "vitest";
import { createWikiTools } from "../src/utils/llm-wiki-tools.js";
import type { Mwn } from "mwn";

describe("LLM Wiki Tools", () => {
  it("provides getPageHistory with continuation support", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      query: {
        pages: [
          {
            pageid: 101,
            title: "人工智能",
            revisions: [
              {
                revid: 200,
                parentid: 199,
                user: "Alice",
                timestamp: "2026-09-20T10:00:00Z",
                comment: "update intro",
                minor: false,
                bot: false,
              },
            ],
          },
        ],
      },
      continue: {
        rvcontinue: "20260920100000|199",
        continue: "||",
      },
    });

    const mockBot = {
      request: mockRequest,
      read: vi.fn(),
    } as unknown as Mwn;

    const tools = createWikiTools(mockBot);
    const result = (await tools.getPageHistory.execute!(
      { title: "人工智能", limit: 5, continueToken: "prev_token" },
      { messages: [], toolCallId: "call_1", context: {} as never },
    )) as {
      found: boolean;
      continueToken: string | null;
      hasMore: boolean;
      revisions: { user: string }[];
    };

    expect(mockRequest).toHaveBeenCalledWith({
      action: "query",
      prop: "revisions",
      titles: "人工智能",
      rvprop: "ids|timestamp|user|comment|flags",
      rvlimit: 5,
      rvcontinue: "prev_token",
      formatversion: 2,
    });

    expect(result.found).toBe(true);
    expect(result.continueToken).toBe("20260920100000|199");
    expect(result.hasMore).toBe(true);
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0].user).toBe("Alice");
  });

  it("provides getUserContribs with continuation support", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      query: {
        usercontribs: [
          {
            userid: 42,
            user: "Alice",
            pageid: 101,
            revid: 200,
            parentid: 199,
            ns: 0,
            title: "人工智能",
            timestamp: "2026-09-20T10:00:00Z",
            comment: "edit",
          },
        ],
      },
      continue: {
        uccontinue: "20260920100000|200",
      },
    });

    const mockBot = {
      request: mockRequest,
    } as unknown as Mwn;

    const tools = createWikiTools(mockBot);
    const result = (await tools.getUserContribs.execute!(
      { user: "Alice", limit: 10, continueToken: "uc_prev" },
      { messages: [], toolCallId: "call_2", context: {} as never },
    )) as {
      user: string;
      continueToken: string | null;
      hasMore: boolean;
      contributions: unknown[];
    };

    expect(mockRequest).toHaveBeenCalledWith({
      action: "query",
      list: "usercontribs",
      ucuser: "Alice",
      ucprop: "ids|title|timestamp|comment|flags",
      uclimit: 10,
      ucdir: "older",
      uccontinue: "uc_prev",
      formatversion: 2,
    });

    expect(result.user).toBe("Alice");
    expect(result.continueToken).toBe("20260920100000|200");
    expect(result.hasMore).toBe(true);
    expect(result.contributions).toHaveLength(1);
  });

  it("provides searchWiki with offset pagination support", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      query: {
        searchinfo: { totalhits: 42 },
        search: [
          {
            ns: 0,
            title: "机器学习",
            pageid: 102,
            wordcount: 500,
            snippet: '关于<span class="searchmatch">机器学习</span>的介绍',
            timestamp: "2026-09-20T00:00:00Z",
          },
        ],
      },
      continue: {
        sroffset: 5,
        continue: "-||",
      },
    });

    const mockBot = {
      request: mockRequest,
    } as unknown as Mwn;

    const tools = createWikiTools(mockBot);
    const result = (await tools.searchWiki.execute!(
      { query: "机器学习", limit: 5, offset: 0, namespace: [0] },
      { messages: [], toolCallId: "call_3", context: {} as never },
    )) as {
      totalHits: number;
      nextOffset: number | null;
      hasMore: boolean;
      results: { snippet: string }[];
    };

    expect(mockRequest).toHaveBeenCalledWith({
      action: "query",
      list: "search",
      srsearch: "机器学习",
      srnamespace: "0",
      srprop: "snippet|titlesnippet|sectiontitle|wordcount|timestamp",
      srlimit: 5,
      sroffset: 0,
      formatversion: 2,
    });

    expect(result.totalHits).toBe(42);
    expect(result.nextOffset).toBe(5);
    expect(result.hasMore).toBe(true);
    expect(result.results[0].snippet).toBe("关于机器学习的介绍");
  });

  it("provides getWikiDiff for revision diff against parent", async () => {
    const mockRequest = vi.fn().mockImplementation((params) => {
      if (params.revids === 200) {
        return Promise.resolve({
          query: {
            pages: [
              {
                pageid: 101,
                title: "测试条目",
                revisions: [
                  {
                    revid: 200,
                    parentid: 199,
                    user: "Bob",
                    timestamp: "2026-09-20T11:00:00Z",
                    comment: "新增段落",
                    slots: {
                      main: {
                        content: "第一行\n第二行新内容\n第三行",
                      },
                    },
                  },
                ],
              },
            ],
          },
        });
      }
      if (params.revids === 199) {
        return Promise.resolve({
          query: {
            pages: [
              {
                pageid: 101,
                title: "测试条目",
                revisions: [
                  {
                    revid: 199,
                    user: "Alice",
                    timestamp: "2026-09-20T09:00:00Z",
                    slots: {
                      main: {
                        content: "第一行\n第三行",
                      },
                    },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({ query: { pages: [] } });
    });

    const mockBot = {
      request: mockRequest,
    } as unknown as Mwn;

    const tools = createWikiTools(mockBot);
    const result = (await tools.getWikiDiff.execute!(
      { revid: 200 },
      { messages: [], toolCallId: "call_4", context: {} as never },
    )) as {
      found: boolean;
      title: string;
      targetRevision: { user: string };
      baseRevision: { user: string } | null;
      diffText: string;
    };

    expect(result.found).toBe(true);
    expect(result.title).toBe("测试条目");
    expect(result.targetRevision.user).toBe("Bob");
    expect(result.baseRevision?.user).toBe("Alice");
    expect(result.diffText).toContain("+ 第二行新内容");
  });

  it("provides getWikiRevision to read specific revision content", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      query: {
        pages: [
          {
            pageid: 101,
            title: "固定版本条目",
            revisions: [
              {
                revid: 12345,
                parentid: 12344,
                user: "Charlie",
                timestamp: "2026-09-20T12:00:00Z",
                comment: "固定版本",
                slots: {
                  main: {
                    content: "固定版本内容",
                  },
                },
              },
            ],
          },
        ],
      },
    });

    const mockBot = {
      request: mockRequest,
    } as unknown as Mwn;

    const tools = createWikiTools(mockBot);
    const result = (await tools.getWikiRevision.execute!(
      { revid: 12345 },
      { messages: [], toolCallId: "call_5", context: {} as never },
    )) as {
      found: boolean;
      title: string;
      revid: number;
      content: string;
    };

    expect(result.found).toBe(true);
    expect(result.title).toBe("固定版本条目");
    expect(result.revid).toBe(12345);
    expect(result.content).toBe("固定版本内容");
  });

  it("provides getWikiPage returning kind: 'document' for normal articles and kind: 'discussion' for talk pages and discussion pages", async () => {
    const mockRequest = vi
      .fn()
      .mockImplementation((params: { titles: string }) => {
        // 1. 普通条目（无讨论留言，ns: 0）
        if (params.titles === "人工智能") {
          return Promise.resolve({
            query: {
              pages: [
                {
                  pageid: 101,
                  ns: 0,
                  title: "人工智能",
                  revisions: [
                    {
                      revid: 1001,
                      slots: {
                        main: { content: "人工智能是一门新兴的技术科学。" },
                      },
                    },
                  ],
                },
              ],
            },
          });
        }

        // 2. 讨论命名空间（User talk:, ns: 3）
        if (params.titles === "User talk:AmanojakuBot") {
          const talkWikitext = `== 主题一 ==
关于机器人运行的意见。 --[[User:Alice|Alice]] 2026年9月14日 (一) 01:00 (UTC)
:赞成！ --[[User:Bob|Bob]] 2026年9月14日 (一) 01:05 (UTC)

=== 子议题 1 ===
细节需要补充。 --[[User:Charlie|Charlie]] 2026年9月14日 (一) 01:10 (UTC)`;

          return Promise.resolve({
            query: {
              pages: [
                {
                  pageid: 102,
                  ns: 3,
                  title: "User talk:AmanojakuBot",
                  revisions: [
                    {
                      revid: 2001,
                      slots: { main: { content: talkWikitext } },
                    },
                  ],
                },
              ],
            },
          });
        }

        // 3. Wikipedia: 命名空间中的讨论页（ns: 4，但包含讨论留言）
        if (params.titles === "Wikipedia:互助客栈/方针") {
          const forumWikitext = `== 关于新提案讨论 ==
我认为该提案非常合理。 --[[User:Alice|Alice]] 2026年9月14日 (一) 01:00 (UTC)
:我也支持。 --[[User:Bob|Bob]] 2026年9月14日 (一) 01:05 (UTC)`;

          return Promise.resolve({
            query: {
              pages: [
                {
                  pageid: 103,
                  ns: 4,
                  title: "Wikipedia:互助客栈/方针",
                  revisions: [
                    {
                      revid: 3001,
                      slots: { main: { content: forumWikitext } },
                    },
                  ],
                },
              ],
            },
          });
        }

        // 4. Wikipedia: 命名空间中的方针正文（ns: 4，无讨论留言）
        if (params.titles === "Wikipedia:机器人方针") {
          const policyWikitext = `== 机器人方针 ==
本方针规定机器人的运作原则和权限申请流程。
=== 申请程序 ===
所有机器人均需在申请页面提交申请。`;

          return Promise.resolve({
            query: {
              pages: [
                {
                  pageid: 104,
                  ns: 4,
                  title: "Wikipedia:机器人方针",
                  revisions: [
                    {
                      revid: 4001,
                      slots: { main: { content: policyWikitext } },
                    },
                  ],
                },
              ],
            },
          });
        }

        return Promise.resolve({ query: { pages: [{ missing: true }] } });
      });

    const mockBot = {
      request: mockRequest,
    } as unknown as Mwn;

    const tools = createWikiTools(mockBot);

    // 1. 测试读取普通条目 -> kind: "document"
    const docResult = (await tools.getWikiPage.execute!(
      { title: "人工智能" },
      { messages: [], toolCallId: "call_doc", context: {} as never },
    )) as any;
    expect(docResult.found).toBe(true);
    expect(docResult.kind).toBe("document");
    expect(docResult.title).toBe("人工智能");
    expect(docResult.revid).toBe(1001);
    expect(docResult.content).toBe("人工智能是一门新兴的技术科学。");

    // 2. 测试读取 Talk 命名空间 -> kind: "discussion"
    const talkResult = (await tools.getWikiPage.execute!(
      { title: "User talk:AmanojakuBot" },
      { messages: [], toolCallId: "call_talk", context: {} as never },
    )) as any;
    expect(talkResult.found).toBe(true);
    expect(talkResult.kind).toBe("discussion");
    expect(talkResult.title).toBe("User talk:AmanojakuBot");
    expect(talkResult.revid).toBe(2001);
    expect(talkResult.sections).toHaveLength(1);
    expect(talkResult.sections[0].level).toBe(2);
    expect(talkResult.sections[0].title).toBe("主题一");
    expect(talkResult.sections[0].messages).toHaveLength(3);
    expect(talkResult.sections[0].messages[0].id).toBe("r-2001-202609140100");
    expect(talkResult.sections[0].messages[0].author).toBe("Alice");
    expect(talkResult.sections[0].messages[0].text).toBe(
      "关于机器人运行的意见。",
    );
    expect(talkResult.sections[0].messages[0].rawText).toBeUndefined();

    // 3. 测试读取 Wikipedia: 命名空间中的讨论页 -> kind: "discussion"
    const forumResult = (await tools.getWikiPage.execute!(
      { title: "Wikipedia:互助客栈/方针" },
      { messages: [], toolCallId: "call_forum", context: {} as never },
    )) as any;
    expect(forumResult.found).toBe(true);
    expect(forumResult.kind).toBe("discussion");
    expect(forumResult.title).toBe("Wikipedia:互助客栈/方针");
    expect(forumResult.revid).toBe(3001);
    expect(forumResult.sections).toHaveLength(1);
    expect(forumResult.sections[0].title).toBe("关于新提案讨论");
    expect(forumResult.sections[0].messages[0].id).toBe("r-3001-202609140100");
    expect(forumResult.sections[0].messages[0].author).toBe("Alice");

    // 4. 测试读取 Wikipedia: 命名空间中的方针正文 -> kind: "document"
    const policyResult = (await tools.getWikiPage.execute!(
      { title: "Wikipedia:机器人方针" },
      { messages: [], toolCallId: "call_policy", context: {} as never },
    )) as any;
    expect(policyResult.found).toBe(true);
    expect(policyResult.kind).toBe("document");
    expect(policyResult.title).toBe("Wikipedia:机器人方针");
    expect(policyResult.revid).toBe(4001);
    expect(policyResult.content).toContain(
      "本方针规定机器人的运作原则和权限申请流程。",
    );

    // 5. 测试不存在的页面 -> found: false
    const missingResult = (await tools.getWikiPage.execute!(
      { title: "不存在的页面_xyz" },
      { messages: [], toolCallId: "call_missing", context: {} as never },
    )) as any;
    expect(missingResult.found).toBe(false);
    expect(missingResult.title).toBe("不存在的页面_xyz");
  });
});
