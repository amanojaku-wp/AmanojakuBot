import { tool } from "ai";
import { z } from "zod";
import type { Mwn } from "mwn";
import type { Logger } from "pino";
import { diffLines } from "diff";
import {
  hasDiscussionComments,
  parseStructuredDiscussionPage,
  type StructuredDiscussionSection,
} from "./wikitext.js";

const MAX_RESULTS = 20;
const MAX_SEARCH_RESULTS = 10;
const MAX_CONTENT_CHARS = 120000;
const MAX_DIFF_CHARS = 120000;

export type WikiPageResult =
  | {
      found: false;
      title: string;
    }
  | {
      found: true;
      title: string;
      revid?: number;
      kind: "document";
      content: string;
      truncated?: boolean;
    }
  | {
      found: true;
      title: string;
      revid?: number;
      kind: "discussion";
      sections: StructuredDiscussionSection[];
    };

export function createWikiTools(bot: Mwn, log?: Logger) {
  return {
    /**
     * 读取指定页面的当前内容，根据命名空间或内容是否包含讨论留言智能决定返回格式：
     * - 若为讨论页（如各类 Talk 页面、互助客栈等讨论页面），返回 kind: "discussion" 及结构化 JSON 数据；
     * - 若为常规页面（如条目、模板、方针文档等），返回 kind: "document" 及 Wikitext 文本。
     */
    getWikiPage: tool({
      description:
        "读取中文维基百科指定页面的当前内容。" +
        "该工具会自动根据命名空间（如各类 Talk 讨论页面）或内容是否包含签名时间戳留言智能决定返回格式：" +
        "1. 若为讨论页（各类 Talk 页面、互助客栈、存废讨论、申请评选等），返回 kind: 'discussion' 及按标题分层的结构化 JSON 数据（包含 id, author, timestamp, text, indentLevel 及嵌套子章节）；" +
        "2. 若为常规文档/条目页面（条目正文、模板代码、方针指引文档等），返回 kind: 'document' 及页面的 Wikitext 正文内容。" +
        "当需要了解某个条目、模板、Wikipedia页面、用户页、讨论页等内容时使用。",

      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .describe(
            "完整MediaWiki页面标题，例如“人工智能”、“User talk:Example”、“Wikipedia:互助客栈/方针”、“Template:Cite web”。",
          ),
      }),

      execute: async ({ title }): Promise<WikiPageResult> => {
        const startedAt = Date.now();
        log?.debug({ title }, "tool getWikiPage started");

        let resolvedTitle = title ?? "";

        const response = await bot.request({
          action: "query",
          prop: "revisions",
          titles: title,
          rvprop: "ids|content",
          rvslots: "main",
          redirects: 1,
          converttitles: 1,
          formatversion: 2,
        });

        const page = response?.query?.pages?.[0];
        const rev = page?.revisions?.[0];

        if (!page || page.missing || !rev) {
          log?.debug(
            { title, found: false, elapsedMs: Date.now() - startedAt },
            "tool getWikiPage not found",
          );
          return {
            found: false,
            title,
          };
        }

        resolvedTitle = page.title ?? resolvedTitle;
        const revid = rev.revid;
        const content =
          rev.slots?.main?.content ??
          rev.slots?.main?.["*"] ??
          rev.content ??
          rev["*"] ??
          "";

        // 判断是否为讨论页：
        // 1. 命名空间判定：MediaWiki 中所有讨论命名空间 ID 均为奇数 (ns > 0 && ns % 2 !== 0)，如 Talk(1), User talk(3), Wikipedia talk(5) 等
        // 2. 标题前缀判定：若 ns 未明确给出但标题带有 Talk 讨论页前缀
        // 3. 内容特征判定：页面内容中包含用户签名链接及时间戳（如 Wikipedia:互助客栈、存废讨论、评选等 Project 命名空间页面）
        const isTalkNamespace =
          typeof page.ns === "number" && page.ns > 0 && page.ns % 2 !== 0;
        const hasComments = hasDiscussionComments(content);
        const isDiscussion = isTalkNamespace || hasComments;

        log?.debug(
          {
            title: resolvedTitle,
            ns: page.ns,
            isDiscussion,
            chars: content.length,
            elapsedMs: Date.now() - startedAt,
          },
          "tool getWikiPage completed",
        );

        if (isDiscussion) {
          const sections = parseStructuredDiscussionPage(content, { revid });
          return {
            found: true,
            title: resolvedTitle,
            revid,
            kind: "discussion",
            sections,
          };
        }

        return {
          found: true,
          title: resolvedTitle,
          revid,
          kind: "document",
          content: content.slice(0, MAX_CONTENT_CHARS),
          truncated: content.length > MAX_CONTENT_CHARS,
        };
      },
    }),

    /**
     * 查询页面最近的编辑历史。
     *
     * 不返回 revision content，只返回元数据。
     * 如果模型需要查看某个具体版本，再调用 getWikiRevision。
     * 支持使用 continueToken 进行接续（翻页）查询。
     */
    getPageHistory: tool({
      description:
        "查询中文维基百科指定页面最近的编辑历史。" +
        "返回版本ID、父版本ID、编辑者、时间、编辑摘要等信息。" +
        "当用户询问某页面最近发生了什么、谁修改了页面、某次修改的版本号，" +
        "或者需要定位应进一步读取的revision时使用。" +
        "支持传入 continueToken 进行接续（翻页）查询。注意：接续查询代价较高且消耗多次工具轮次，只有在首次查询未能找到所需历史且确有必要追溯更早历史时才进行接续查询。",

      inputSchema: z.object({
        title: z.string().min(1).max(255).describe("完整MediaWiki页面标题"),

        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .default(10)
          .describe("返回最近多少次编辑，默认10，最多20"),

        continueToken: z
          .string()
          .optional()
          .describe(
            "可选，上一页返回的接续令牌（continueToken）。注意：接续查询代价较高，仅在首批结果未命中且确有必要追溯更早历史时才使用。",
          ),
      }),

      execute: async ({ title, limit, continueToken }) => {
        const response = await bot.request({
          action: "query",
          prop: "revisions",
          titles: title,
          rvprop: "ids|timestamp|user|comment|flags",
          rvlimit: limit,
          ...(continueToken ? { rvcontinue: continueToken } : {}),
          formatversion: 2,
        });

        const page = response?.query?.pages?.[0];

        if (!page || page.missing) {
          return {
            found: false,
            title,
            revisions: [],
            continueToken: null,
            hasMore: false,
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

        const nextContinueToken = response?.continue?.rvcontinue ?? null;

        return {
          found: true,
          title: page.title ?? title,
          pageid: page.pageid,
          revisions,
          continueToken: nextContinueToken,
          hasMore: Boolean(nextContinueToken),
        };
      },
    }),

    /**
     * 查询用户最近的贡献。
     * 支持使用 continueToken 进行接续（翻页）查询。
     */
    getUserContribs: tool({
      description:
        "查询中文维基百科指定用户最近的编辑贡献。" +
        "返回页面标题、命名空间、版本ID、父版本ID、时间、编辑摘要等。" +
        "当需要了解某用户最近编辑了哪些页面、定位某次用户编辑，" +
        "或查看用户近期贡献记录时使用。" +
        "支持传入 continueToken 进行接续（翻页）查询。注意：接续查询代价较高，仅在首批结果未命中且确有必要查找更早贡献时才进行接续查询。",

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

        continueToken: z
          .string()
          .optional()
          .describe(
            "可选，上一页返回的接续令牌（continueToken）。注意：接续查询代价较高，仅在首批结果未命中且确有必要翻页时才使用。",
          ),
      }),

      execute: async ({ user, limit, continueToken }) => {
        const response = await bot.request({
          action: "query",
          list: "usercontribs",
          ucuser: user,
          ucprop: "ids|title|timestamp|comment|flags",
          uclimit: limit,
          ucdir: "older",
          ...(continueToken ? { uccontinue: continueToken } : {}),
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

        const nextContinueToken = response?.continue?.uccontinue ?? null;

        return {
          user,
          contributions,
          continueToken: nextContinueToken,
          hasMore: Boolean(nextContinueToken),
        };
      },
    }),

    /**
     * 全站搜索。
     * 支持使用 offset 进行接续（翻页）查询。
     */
    searchWiki: tool({
      description:
        "搜索中文维基百科页面。" +
        "当不知道准确页面标题、需要寻找与某个关键词相关的页面，" +
        "或用户提到的名称可能不准确时使用。" +
        "这个工具只用于寻找页面；找到目标页面后，如需了解实际内容，应继续调用getWikiPage。" +
        "支持传入 offset 进行接续（翻页）查询。注意：接续搜索代价较高，通常应优先优化搜索关键词，仅在确有必要查看下一批结果时才翻页。",

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

        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "可选，搜索结果偏移量（上一页返回的 nextOffset）。注意：接续搜索代价较高，优先优化搜索词，仅在必要时翻页。",
          ),
      }),

      execute: async ({ query, namespace, limit, offset }) => {
        const response = await bot.request({
          action: "query",
          list: "search",
          srsearch: query,
          ...(namespace?.length ? { srnamespace: namespace.join("|") } : {}),
          srprop: "snippet|titlesnippet|sectiontitle|wordcount|timestamp",
          srlimit: limit,
          ...(offset !== undefined ? { sroffset: offset } : {}),
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

        const nextOffset = response?.continue?.sroffset ?? null;

        return {
          query,
          totalHits: searchInfo?.totalhits,
          results,
          nextOffset,
          hasMore: Boolean(nextOffset),
        };
      },
    }),

    /**
     * 查询指定修订版本的内容和基本元数据。
     * 对应用户输入的 [[Special:Permalink/xxx]]、[[Special:Perma/xxx]]、[[Special:固定连接/xxx]]、[[Special:固定連結/xxxx]]。
     */
    getWikiRevision: tool({
      description:
        "读取中文维基百科指定revision的内容和基本元数据。" +
        "当用户提供revision ID、oldid，或者形如 [[Special:Permalink/12345]]、[[Special:Perma/12345]]、[[Special:固定连接/12345]]、[[Special:固定連結/12345]] 的固定版本链接，" +
        "或者通过 getPageHistory/getUserContribs 定位到某个具体版本后需要查看该版本实际内容时使用。",

      inputSchema: z.object({
        revid: z
          .number()
          .int()
          .positive()
          .describe(
            "MediaWiki revision ID（正整数，例如 94394322）。支持从固定链接 [[Special:Permalink/xxx]]、[[Special:Perma/xxx]]、[[Special:固定连接/xxx]]、[[Special:固定連結/xxx]] 或 oldid 中提取的 ID。",
          ),
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

    /**
     * 查询指定修订版本的修改差异（Diff）。
     * 对应用户输入的 [[Special:Diff/xxx]]、[[Special:差异/xxx]]、[[Special:差異/xxx]]。
     */
    getWikiDiff: tool({
      description:
        "查询中文维基百科指定修订版本（revision）的修改差异（Diff）。" +
        "当用户提供形如 [[Special:Diff/12345]]、[[Special:差异/12345]]、[[Special:差異/12345]]、" +
        "[[Special:Diff/12345/67890]]、[[Special:差异/12345/67890]]、[[Special:差異/12345/67890]]，" +
        "或询问某次修改/版本改动了什么时使用。" +
        "返回修订版本元数据、编辑摘要及详细差异对比（Wikitext diff 行）。",

      inputSchema: z.object({
        revid: z
          .number()
          .int()
          .positive()
          .describe(
            "目标修订版本 ID (toRevid)。若不提供 fromRevid，则对比该版本与其上一版本（父版本）。对应 [[Special:Diff/12345]]、[[Special:差异/12345]]、[[Special:差異/12345]]。",
          ),
        fromRevid: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "可选，对比的起始修订版本 ID (fromRevid)。若提供，则对比 fromRevid 到 revid 之间的差异（对应 Special:Diff/12345/67890）。若省略，则对比 revid 与其父版本。",
          ),
      }),

      execute: async ({ revid, fromRevid }) => {
        const startedAt = Date.now();
        log?.debug({ revid, fromRevid }, "tool getWikiDiff started");

        // 1. 获取目标版本详情与内容
        const targetRes = await bot.request({
          action: "query",
          prop: "revisions",
          revids: revid,
          rvprop: "ids|timestamp|user|comment|flags|content",
          rvslots: "main",
          formatversion: 2,
        });

        const targetPage = targetRes?.query?.pages?.[0];
        const targetRev = targetPage?.revisions?.[0];

        if (!targetPage || targetPage.missing || !targetRev) {
          return {
            found: false,
            revid,
            fromRevid,
            error: `修订版本 ${revid} 不存在或已被删除`,
          };
        }

        const targetContent =
          targetRev.slots?.main?.content ??
          targetRev.slots?.main?.["*"] ??
          targetRev.content ??
          targetRev["*"] ??
          "";

        // 2. 确定对比的基准版本 (baseRevId)
        const baseRevId = fromRevid ?? targetRev.parentid;

        let baseContent = "";
        let baseRevInfo: {
          revid?: number;
          user?: string;
          timestamp?: string;
          comment?: string;
        } | null = null;

        if (baseRevId && baseRevId > 0) {
          const baseRes = await bot.request({
            action: "query",
            prop: "revisions",
            revids: baseRevId,
            rvprop: "ids|timestamp|user|comment|flags|content",
            rvslots: "main",
            formatversion: 2,
          });
          const basePage = baseRes?.query?.pages?.[0];
          const bRev = basePage?.revisions?.[0];
          if (bRev) {
            baseContent =
              bRev.slots?.main?.content ??
              bRev.slots?.main?.["*"] ??
              bRev.content ??
              bRev["*"] ??
              "";
            baseRevInfo = {
              revid: bRev.revid,
              user: bRev.user,
              timestamp: bRev.timestamp,
              comment: bRev.comment ?? "",
            };
          }
        }

        // 3. 计算文本差异
        const diffs = diffLines(baseContent, targetContent);

        const changes: {
          type: "added" | "removed";
          value: string;
        }[] = [];

        let diffText = "";
        for (const part of diffs) {
          if (part.added) {
            changes.push({ type: "added", value: part.value });
            diffText += `+ ${part.value.trimEnd()}\n`;
          } else if (part.removed) {
            changes.push({ type: "removed", value: part.value });
            diffText += `- ${part.value.trimEnd()}\n`;
          }
        }

        const truncated = diffText.length > MAX_DIFF_CHARS;
        if (truncated) {
          diffText =
            diffText.slice(0, MAX_DIFF_CHARS) + "\n...[差异过长已截断]";
        }

        log?.debug(
          {
            revid,
            fromRevid: baseRevId,
            elapsedMs: Date.now() - startedAt,
          },
          "tool getWikiDiff completed",
        );

        return {
          found: true,
          title: targetPage.title,
          pageid: targetPage.pageid,
          targetRevision: {
            revid: targetRev.revid,
            parentid: targetRev.parentid,
            user: targetRev.user,
            timestamp: targetRev.timestamp,
            comment: targetRev.comment ?? "",
            minor: !!targetRev.minor,
          },
          baseRevision: baseRevInfo,
          isNewPage: !baseRevId || baseRevId === 0,
          diffText: diffText.trim(),
          changesCount: changes.length,
          truncated,
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
