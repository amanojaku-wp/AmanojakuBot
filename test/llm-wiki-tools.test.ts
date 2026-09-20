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
});
