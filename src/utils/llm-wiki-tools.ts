import { tool } from "ai";
import { z } from "zod";
import type { Mwn } from "mwn";
import { pageText } from "./wiki.js";
import type { Logger } from "pino";

const MAX_RESULTS = 20;
const MAX_SEARCH_RESULTS = 10;

export function createWikiTools(bot: Mwn, log?: Logger) {
  return {
    /**
     * 读取指定页面的当前 Wikitext。
     */
    getWikiPage: tool({
      description:
        "读取中文维基百科指定页面的当前Wikitext。" +
        "当需要了解某个条目、模板、Wikipedia页面、用户页等的实际当前内容时使用。",

      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(255)
          .describe(
            "完整MediaWiki页面标题，例如“人工智能”、“Template:Cite web”、“Wikipedia:机器人方针”",
          ),
      }),

      execute: async ({ title }) => {
        const startedAt = Date.now();

        log?.debug({ title }, "tool getWikiPage started");

        const text = await pageText(bot, title);

        log?.debug(
          {
            title,
            found: text != null,
            chars: text?.length ?? 0,
            elapsedMs: Date.now() - startedAt,
          },
          "tool getWikiPage fetched",
        );

        if (text == null) {
          return {
            found: false,
            title,
          };
        }

        return {
          found: true,
          title,
          content: text.slice(0, 12000),
          truncated: text.length > 12000,
        };
      },
    }),

    /**
     * 查询页面最近的编辑历史。
     *
     * 不返回 revision content，只返回元数据。
     * 如果模型需要查看某个具体版本，再调用 getWikiRevision。
     */
    getPageHistory: tool({
      description:
        "查询中文维基百科指定页面最近的编辑历史。" +
        "返回版本ID、父版本ID、编辑者、时间、编辑摘要等信息。" +
        "当用户询问某页面最近发生了什么、谁修改了页面、某次修改的版本号，" +
        "或者需要定位应进一步读取的revision时使用。",

      inputSchema: z.object({
        title: z.string().min(1).max(255).describe("完整MediaWiki页面标题"),

        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .default(10)
          .describe("返回最近多少次编辑，默认10，最多20"),
      }),

      execute: async ({ title, limit }) => {
        const response = await bot.request({
          action: "query",
          prop: "revisions",
          titles: title,
          rvprop: "ids|timestamp|user|comment|flags",
          rvlimit: limit,
          formatversion: 2,
        });

        const page = response?.query?.pages?.[0];

        if (!page || page.missing) {
          return {
            found: false,
            title,
            revisions: [],
          };
        }

        const revisions = (page.revisions ?? []).map(
          (rev: {
            revid?: number;
            parentid?: number;
            user?: string;
            timestamp?: string;
            comment?: string;
            minor?: boolean;
            bot?: boolean;
          }) => ({
            revid: rev.revid,
            parentid: rev.parentid,
            user: rev.user,
            timestamp: rev.timestamp,
            comment: rev.comment ?? "",
            minor: !!rev.minor,
            bot: !!rev.bot,
          }),
        );

        return {
          found: true,
          title: page.title ?? title,
          pageid: page.pageid,
          revisions,
        };
      },
    }),

    /**
     * 查询用户最近的贡献。
     */
    getUserContribs: tool({
      description:
        "查询中文维基百科指定用户最近的编辑贡献。" +
        "返回页面标题、命名空间、版本ID、父版本ID、时间、编辑摘要等。" +
        "当需要了解某用户最近编辑了哪些页面、定位某次用户编辑，" +
        "或查看用户近期贡献记录时使用。",

      inputSchema: z.object({
        user: z
          .string()
          .min(1)
          .max(255)
          .describe("MediaWiki用户名，不要添加User:前缀，例如“逆襲的天邪鬼”"),

        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .default(10)
          .describe("返回最近多少次贡献，默认10，最多20"),
      }),

      execute: async ({ user, limit }) => {
        const response = await bot.request({
          action: "query",
          list: "usercontribs",
          ucuser: user,
          ucprop: "ids|title|timestamp|comment|flags",
          uclimit: limit,
          ucdir: "older",
          formatversion: 2,
        });

        const contributions = (response?.query?.usercontribs ?? []).map(
          (edit: {
            userid?: number;
            user?: string;
            pageid?: number;
            revid?: number;
            parentid?: number;
            ns?: number;
            title?: string;
            timestamp?: string;
            comment?: string;
            minor?: boolean;
            new?: boolean;
            top?: boolean;
          }) => ({
            pageid: edit.pageid,
            revid: edit.revid,
            parentid: edit.parentid,
            namespace: edit.ns,
            title: edit.title,
            timestamp: edit.timestamp,
            comment: edit.comment ?? "",
            minor: !!edit.minor,
            new: !!edit.new,
            top: !!edit.top,
          }),
        );

        return {
          user,
          contributions,
        };
      },
    }),

    /**
     * 全站搜索。
     */
    searchWiki: tool({
      description:
        "搜索中文维基百科页面。" +
        "当不知道准确页面标题、需要寻找与某个关键词相关的页面，" +
        "或用户提到的名称可能不准确时使用。" +
        "这个工具只用于寻找页面；找到目标页面后，如需了解实际内容，应继续调用getWikiPage。",

      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("搜索关键词或MediaWiki搜索表达式"),

        namespace: z
          .array(z.number().int().min(0))
          .max(10)
          .optional()
          .describe(
            "可选的MediaWiki命名空间编号，例如0为条目、10为模板、4为Wikipedia",
          ),

        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_RESULTS)
          .default(5)
          .describe("最多返回多少个搜索结果，默认5，最多10"),
      }),

      execute: async ({ query, namespace, limit }) => {
        const response = await bot.request({
          action: "query",
          list: "search",
          srsearch: query,
          ...(namespace?.length ? { srnamespace: namespace.join("|") } : {}),
          srprop: "snippet|titlesnippet|sectiontitle|wordcount|timestamp",
          srlimit: limit,
          formatversion: 2,
        });

        const searchInfo = response?.query?.searchinfo;
        const results = (response?.query?.search ?? []).map(
          (result: {
            ns?: number;
            title?: string;
            pageid?: number;
            size?: number;
            wordcount?: number;
            snippet?: string;
            titlesnippet?: string;
            sectiontitle?: string;
            timestamp?: string;
          }) => ({
            pageid: result.pageid,
            namespace: result.ns,
            title: result.title,
            wordcount: result.wordcount,
            timestamp: result.timestamp,

            // MediaWiki search snippet可能包含<span class="searchmatch">
            // 保留给模型通常没有必要，简单去掉HTML标签。
            snippet: stripHtml(result.snippet ?? ""),

            sectionTitle: result.sectiontitle || undefined,
          }),
        );

        return {
          query,
          totalHits: searchInfo?.totalhits,
          results,
        };
      },
    }),

    getWikiRevision: tool({
      description:
        "读取中文维基百科指定revision的内容和基本元数据。" +
        "当用户提供revision ID、oldid，或者通过getPageHistory/getUserContribs定位到某个具体版本后，" +
        "需要查看该版本实际内容时使用。",

      inputSchema: z.object({
        revid: z
          .number()
          .int()
          .positive()
          .describe("MediaWiki revision ID，例如94394322"),
      }),

      execute: async ({ revid }) => {
        const response = await bot.request({
          action: "query",
          prop: "revisions",
          revids: revid,
          rvprop: "ids|timestamp|user|comment|flags|content",
          rvslots: "main",
          formatversion: 2,
        });

        const page = response?.query?.pages?.[0];

        if (!page || page.missing) {
          return {
            found: false,
            revid,
          };
        }

        const rev = page.revisions?.[0];

        if (!rev) {
          return {
            found: false,
            revid,
          };
        }

        const content =
          rev.slots?.main?.content ??
          rev.slots?.main?.["*"] ??
          rev.content ??
          rev["*"] ??
          "";

        const MAX_CONTENT_CHARS = 12000;

        return {
          found: true,
          title: page.title,
          pageid: page.pageid,
          revid: rev.revid,
          parentid: rev.parentid,
          user: rev.user,
          timestamp: rev.timestamp,
          comment: rev.comment ?? "",
          minor: !!rev.minor,
          content: content.slice(0, MAX_CONTENT_CHARS),
          truncated: content.length > MAX_CONTENT_CHARS,
        };
      },
    }),
  };
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
