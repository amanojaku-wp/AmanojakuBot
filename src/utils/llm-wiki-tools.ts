import { tool } from "ai";
import { z } from "zod";
import { Mwn } from "mwn";
import type { Logger } from "pino";
import {
  hasDiscussionComments,
  parseStructuredDiscussionPage,
  type StructuredDiscussionSection,
} from "./wikitext.js";
import { revisionDiff } from "./wiki.js";
import { interwikiApiUrlForPrefix, resolveInterwiki } from "./interwiki.js";
import { fetchUrlContent } from "./urlFetch.js";

const MAX_RESULTS = 20;
const MAX_SEARCH_RESULTS = 10;
const MAX_CONTENT_CHARS = 120000;

/** 跨维基只读客户端的 User-Agent（沿用主客户端的 Wikimedia UA 策略）。 */
const INTERWIKI_USER_AGENT = "AmanojakuBot/0.1 (contact via bot talk page)";

/** 按 `api.php` 地址缓存的跨维基只读客户端（匿名，仅用于读取公开内容）。 */
const interwikiClients = new Map<string, Mwn>();

/**
 * 取得目标维基的只读客户端：未指定跨维基前缀（`apiUrl` 为空）时回退到当前站点客户端。
 *
 * 跨维基站点只做只读查询，因此不携带登录凭据；写入路径永远走当前站点客户端。
 */
function interwikiBot(apiUrl: string | undefined, fallback: Mwn): Mwn {
  if (!apiUrl) return fallback;
  let client = interwikiClients.get(apiUrl);
  if (!client) {
    client = new Mwn({ apiUrl, userAgent: INTERWIKI_USER_AGENT });
    interwikiClients.set(apiUrl, client);
  }
  return client;
}

/** `Special:Diff/<a>` / `Special:Diff/<a>/<b>` / `Special:差异/…` / `Special:差異/…`。 */
const SPECIAL_DIFF_RE = /^special:(?:diff|差异|差異)\/(\d+)(?:\/(\d+))?$/i;
/** `Special:Permalink/<n>` 及其本地化别名。 */
const SPECIAL_PERMALINK_RE =
  /^special:(?:permalink|perma|permanentlink|固定连接|固定連結)\/(\d+)$/i;
/** `oldid=12345`（含 index.php URL 查询串）。 */
const OLDID_RE = /[?&]?oldid=(\d+)/i;

/**
 * Special:Diff / Special:Permalink 等固定链接（已去除跨维基前缀与锚点）。
 *
 * `[[Special:Diff/A/B]]` 中 B 是目标版本、A 是基准版本。
 */
type SpecialLink =
  | { kind: "diff"; revid: number; fromRevid?: number }
  | { kind: "permalink"; revid: number };

/** 解析结果：页面标题、锚点、跨维基前缀与 Special 链接彼此独立。 */
type ParsedWikiInput = {
  /** 去除锚点与跨维基前缀后的页面标题；Special 链接时为空字符串。 */
  title: string;
  /** `#` 之后的页面内锚点（不含 `#`）。 */
  anchor?: string;
  /** 命中的跨维基前缀，如 `en`、`c`、`d`。 */
  prefix?: string;
  /** 跨维基前缀对应的目标维基 `api.php` 地址。 */
  apiUrl?: string;
  /** Special:Diff / Special:Permalink 之类的固定链接。 */
  special?: SpecialLink;
};

/**
 * 解析用户 / 模型给出的页面标题或链接，统一处理三类常见写法：
 *
 * 1. 页面内锚点：`条目#锚点`、`Special:Diff/123#锚点` —— `#` 及其后内容只是位置标记，
 *    不是标题 / 版本号的一部分，必须在请求 MediaWiki API 之前丢弃（否则 API 会因
 *    `#` 属于非法标题字符而报 `invalidtitle`）。
 * 2. 跨语言 / 跨维基前缀：`en:Foo`、`c:File:Bar.svg`、`d:Q42`。
 * 3. 固定链接：`Special:Diff/…`、`Special:Permalink/…`、`oldid=…`。
 *
 * 前导冒号（`[[:en:Foo]]` 形式的 `:en:Foo`）会被忽略。
 */
function parseWikiInput(rawInput: string): ParsedWikiInput {
  let value = (rawInput ?? "").trim().replace(/^:+/, "").trim();

  // 1. 去掉页面内锚点
  let anchor: string | undefined;
  const hash = value.indexOf("#");
  if (hash !== -1) {
    anchor = value.slice(hash + 1).trim() || undefined;
    value = value.slice(0, hash).trim();
  }

  // 2. 跨语言 / 跨维基前缀
  let prefix: string | undefined;
  let apiUrl: string | undefined;
  const interwiki = resolveInterwiki(value);
  if (interwiki) {
    prefix = interwiki.prefix;
    apiUrl = interwiki.apiUrl;
    value = interwiki.title;
  }

  // 3. Special:Diff / Special:Permalink / oldid
  const special = parseSpecialLink(value);

  return { title: special ? "" : value, anchor, prefix, apiUrl, special };
}

/** 从（已去除锚点的）标题中识别 Special:Diff / Special:Permalink / oldid 固定链接。 */
function parseSpecialLink(value: string): SpecialLink | undefined {
  const normalized = value.replace(/_/g, " ").trim();

  const diff = SPECIAL_DIFF_RE.exec(normalized);
  if (diff) {
    const first = Number(diff[1]);
    const second = diff[2] ? Number(diff[2]) : undefined;
    // [[Special:Diff/A/B]]：B 为目标版本、A 为基准版本
    if (second !== undefined)
      return { kind: "diff", revid: second, fromRevid: first };
    return { kind: "diff", revid: first };
  }

  const permalink = SPECIAL_PERMALINK_RE.exec(normalized);
  if (permalink) return { kind: "permalink", revid: Number(permalink[1]) };

  const oldid = OLDID_RE.exec(normalized);
  if (oldid) return { kind: "permalink", revid: Number(oldid[1]) };

  return undefined;
}

/** 读取指定修订版本的完整内容与元数据（用于 Special:Permalink / oldid）。 */
async function fetchRevisionContent(
  bot: Mwn,
  revid: number,
): Promise<
  | {
      found: true;
      title: string;
      pageid?: number;
      revid: number;
      user?: string;
      timestamp?: string;
      comment: string;
      content: string;
      truncated: boolean;
    }
  | { found: false; revid: number }
> {
  const response = await bot.request({
    action: "query",
    prop: "revisions",
    revids: revid,
    rvprop: "ids|timestamp|user|comment|flags|content",
    rvslots: "main",
    formatversion: 2,
  });

  const page = response?.query?.pages?.[0];
  const rev = page?.revisions?.[0];
  if (!page || page.missing || !rev) return { found: false, revid };

  const content =
    rev.slots?.main?.content ??
    rev.slots?.main?.["*"] ??
    rev.content ??
    rev["*"] ??
    "";

  return {
    found: true,
    title: page.title as string,
    pageid: page.pageid as number | undefined,
    revid: rev.revid as number,
    user: rev.user as string | undefined,
    timestamp: rev.timestamp as string | undefined,
    comment: (rev.comment ?? "") as string,
    content: content.slice(0, MAX_CONTENT_CHARS),
    truncated: content.length > MAX_CONTENT_CHARS,
  };
}

/** 允许的日志查询条目数上限（与其它工具一致，避免一次拉取过多）。 */
const MAX_LOG_RESULTS = MAX_RESULTS;

/** 去掉用户名的命名空间前缀（User: / 用户: / 用戶: / 使用者:）。 */
function normalizeUserName(user: string): string {
  return user
    .trim()
    .replace(/^(?:user|用户|用戶|使用者)\s*:\s*/i, "")
    .trim();
}

/** MediaWiki `list=logevents` 单条记录（formatversion=2 形状）。 */
type RawLogEvent = {
  logid?: number;
  pageid?: number;
  ns?: number;
  title?: string;
  logpage?: string;
  type?: string;
  action?: string;
  user?: string;
  userid?: number;
  timestamp?: string;
  comment?: string;
  params?: Record<string, unknown>;
  tags?: string[];
};

/**
 * 查询日志（`list=logevents`），用户日志与页面日志共用。
 *
 * 注意：`letype` **只接受单个**日志类型（并非多值参数），因此这里只传一个 `type`；
 * 不传 `type` 时返回该用户 / 页面全部类型的日志。
 */
async function queryLogEvents(
  bot: Mwn,
  {
    user,
    title,
    type,
    limit,
    continueToken,
  }: {
    user?: string;
    title?: string;
    type?: string;
    limit: number;
    continueToken?: string;
  },
): Promise<{
  events: ReturnType<typeof mapLogEvent>[];
  continueToken: string | null;
  hasMore: boolean;
}> {
  const response = await bot.request({
    action: "query",
    list: "logevents",
    leprop: "ids|title|type|user|timestamp|comment|details|tags",
    ...(user ? { leuser: user } : {}),
    ...(title ? { letitle: title } : {}),
    ...(type ? { letype: type } : {}),
    lelimit: limit,
    ledir: "older",
    ...(continueToken ? { lecontinue: continueToken } : {}),
    formatversion: 2,
  });

  const events = ((response?.query?.logevents ?? []) as RawLogEvent[]).map(
    mapLogEvent,
  );
  const nextContinueToken = response?.continue?.lecontinue ?? null;

  return {
    events,
    continueToken: nextContinueToken,
    hasMore: Boolean(nextContinueToken),
  };
}

/** 把 `logevents` 原始记录整理为稳定、精简的输出形状。 */
function mapLogEvent(ev: RawLogEvent) {
  return {
    logid: ev.logid,
    logpage: ev.logpage,
    namespace: ev.ns,
    title: ev.title,
    pageid: ev.pageid,
    type: ev.type,
    action: ev.action,
    user: ev.user,
    userid: ev.userid,
    timestamp: ev.timestamp,
    comment: ev.comment ?? "",
    tags: ev.tags ?? [],
    params: ev.params ?? {},
  };
}

export type WikiPageResult =
  | {
      found: false;
      title: string;
      anchor?: string;
      prefix?: string;
      apiUrl?: string;
      note?: string;
    }
  | {
      found: true;
      title: string;
      revid?: number;
      kind: "document";
      content: string;
      truncated?: boolean;
      anchor?: string;
      prefix?: string;
      apiUrl?: string;
    }
  | {
      found: true;
      title: string;
      revid?: number;
      kind: "discussion";
      sections: StructuredDiscussionSection[];
      anchor?: string;
      prefix?: string;
      apiUrl?: string;
    }
  | {
      found: true;
      title: string;
      kind: "diff";
      revid?: number;
      fromRevid?: number;
      user?: string;
      timestamp?: string;
      comment?: string;
      diffText: string;
      changesCount: number;
      truncated?: boolean;
      isNewPage?: boolean;
      anchor?: string;
      prefix?: string;
      apiUrl?: string;
      note?: string;
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
        "读取指定维基页面的当前内容（默认中文维基百科）。" +
        "该工具会自动根据命名空间（如各类 Talk 讨论页面）或内容是否包含签名时间戳留言智能决定返回格式：" +
        "1. 若为讨论页（各类 Talk 页面、互助客栈、存废讨论、申请评选等），返回 kind: 'discussion' 及按标题分层的结构化 JSON 数据（包含 id, author, timestamp, text, indentLevel 及嵌套子章节）；" +
        "2. 若为常规文档/条目页面（条目正文、模板代码、方针指引文档等），返回 kind: 'document' 及页面的 Wikitext 正文内容。" +
        "支持跨语言 / 跨维基前缀（如 en、ja、c、d、m、wikt 等），例如 'en:Artificial intelligence'、'c:File:Example.svg'、'd:Q42'；" +
        "也支持固定链接 Special:Permalink/123、Special:Diff/123（含 [[Special:Diff/123/456]] 双版本形式）。" +
        "标题中的「#锚点」只是页面内位置标记，会自动忽略，无需手动去除。" +
        "当需要了解某个条目、模板、Wikipedia页面、用户页、讨论页等内容时使用。",

      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .describe(
            "完整MediaWiki页面标题，例如“人工智能”、“User talk:Example”、“Wikipedia:互助客栈/方针”、“Template:Cite web”。也可传入跨语言/跨维基前缀（如“en:Artificial intelligence”、“d:Q42”）或固定链接（如“Special:Permalink/123”、“Special:Diff/123”）。标题中的“#锚点”会被自动忽略。",
          ),
      }),

      execute: async ({ title }): Promise<WikiPageResult> => {
        const startedAt = Date.now();
        const parsed = parseWikiInput(title ?? "");
        const special = parsed.special;
        const targetBot = interwikiBot(parsed.apiUrl, bot);

        log?.debug({ input: title, ...parsed }, "tool getWikiPage started");

        /** 把锚点 / 跨维基前缀等元信息附加到结果上，便于模型理解。 */
        const withMeta = <T extends object>(value: T): WikiPageResult =>
          ({
            ...value,
            ...(parsed.anchor ? { anchor: parsed.anchor } : {}),
            ...(parsed.prefix ? { prefix: parsed.prefix } : {}),
            ...(parsed.apiUrl ? { apiUrl: parsed.apiUrl } : {}),
          }) as unknown as WikiPageResult;

        // 固定链接：Special:Diff / Special:Permalink（含跨维基形式，如 [[d:Special:Permalink/123#锚点]]）
        if (special) {
          if (special.kind === "diff") {
            const diff = await revisionDiff(targetBot, special.revid, {
              fromRevid: special.fromRevid,
            });
            if (!diff) {
              return withMeta({
                found: false,
                title: title ?? "",
                note: `修订版本 ${special.revid} 不存在或已被删除`,
              });
            }
            return withMeta({
              found: true,
              title: diff.title,
              kind: "diff",
              revid: diff.revid,
              fromRevid: diff.parentid,
              user: diff.user,
              timestamp: diff.timestamp,
              comment: diff.comment,
              diffText: diff.diffText,
              changesCount: diff.changesCount,
              truncated: diff.truncated,
              isNewPage: diff.isNewPage,
            });
          }

          const fixed = await fetchRevisionContent(targetBot, special.revid);
          if (!fixed.found) {
            return withMeta({
              found: false,
              title: title ?? "",
              note: `修订版本 ${special.revid} 不存在或已被删除`,
            });
          }
          if (hasDiscussionComments(fixed.content)) {
            return withMeta({
              found: true,
              title: fixed.title,
              revid: fixed.revid,
              kind: "discussion",
              sections: parseStructuredDiscussionPage(fixed.content, {
                revid: fixed.revid,
              }),
            });
          }
          return withMeta({
            found: true,
            title: fixed.title,
            revid: fixed.revid,
            kind: "document",
            content: fixed.content,
            truncated: fixed.truncated,
          });
        }

        const response = await targetBot.request({
          action: "query",
          prop: "revisions",
          titles: parsed.title,
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
            {
              title: parsed.title,
              found: false,
              elapsedMs: Date.now() - startedAt,
            },
            "tool getWikiPage not found",
          );
          return withMeta({ found: false, title: parsed.title });
        }

        const resolvedTitle = page.title ?? parsed.title;
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
          return withMeta({
            found: true,
            title: resolvedTitle,
            revid,
            kind: "discussion",
            sections,
          });
        }

        return withMeta({
          found: true,
          title: resolvedTitle,
          revid,
          kind: "document",
          content: content.slice(0, MAX_CONTENT_CHARS),
          truncated: content.length > MAX_CONTENT_CHARS,
        });
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
        "查询指定页面最近的编辑历史（默认中文维基百科）。" +
        "返回版本ID、父版本ID、编辑者、时间、编辑摘要等信息。" +
        "当用户询问某页面最近发生了什么、谁修改了页面、某次修改的版本号，" +
        "或者需要定位应进一步读取的revision时使用。" +
        "支持跨语言 / 跨维基前缀（如 en、ja、c、d）；标题中的「#锚点」会被自动忽略。" +
        "支持传入 continueToken 进行接续（翻页）查询。注意：接续查询代价较高且消耗多次工具轮次，只有在首次查询未能找到所需历史且确有必要追溯更早历史时才进行接续查询。",

      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(255)
          .describe(
            "完整MediaWiki页面标题；也可使用跨语言/跨维基前缀（如“en:Artificial intelligence”）。标题中的“#锚点”会被自动忽略。",
          ),

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
        const parsed = parseWikiInput(title);
        const targetBot = interwikiBot(parsed.apiUrl, bot);

        // 固定链接不是「页面历史」的查询对象：如实说明，避免用空标题请求 API。
        if (parsed.special) {
          return {
            found: false,
            title,
            revisions: [],
            continueToken: null,
            hasMore: false,
            note: "该输入是 Special:Diff / Special:Permalink / oldid 固定链接，请改用 getWikiPage、getWikiRevision 或 getWikiDiff 查询。",
          };
        }

        const response = await targetBot.request({
          action: "query",
          prop: "revisions",
          titles: parsed.title,
          rvprop: "ids|timestamp|user|comment|flags",
          rvlimit: limit,
          ...(continueToken ? { rvcontinue: continueToken } : {}),
          formatversion: 2,
        });

        const page = response?.query?.pages?.[0];

        if (!page || page.missing) {
          return {
            found: false,
            title: parsed.title,
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
          title: page.title ?? parsed.title,
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
        "读取指定revision的内容和基本元数据（默认中文维基百科）。" +
        "当用户提供revision ID、oldid，或者形如 [[Special:Permalink/12345]]、[[Special:Perma/12345]]、[[Special:固定连接/12345]]、[[Special:固定連結/12345]] 的固定版本链接，" +
        "或者通过 getPageHistory/getUserContribs 定位到某个具体版本后需要查看该版本实际内容时使用。" +
        "只传入纯数字版本号：链接中的「#锚点」不属于版本号，必须丢弃。跨维基固定链接（如 [[d:Special:Permalink/123]]）可用 wiki 参数指定站点。",

      inputSchema: z.object({
        revid: z
          .number()
          .int()
          .positive()
          .describe(
            "MediaWiki revision ID（正整数，例如 94394322）。从固定链接 [[Special:Permalink/xxx]]、[[Special:Perma/xxx]]、[[Special:固定连接/xxx]]、[[Special:固定連結/xxx]] 或 oldid 中提取纯数字 ID；链接中的“#锚点”不是版本号的一部分，必须去掉。",
          ),
        wiki: z
          .string()
          .min(1)
          .optional()
          .describe(
            "可选，跨语言/跨维基前缀，例如 en（英文维基百科）、ja、c（共享资源）、d（维基数据）、m（元维基）、wikt 等；省略则在当前站点查询。",
          ),
      }),

      execute: async ({ revid, wiki }) => {
        const targetBot = interwikiBot(
          wiki ? interwikiApiUrlForPrefix(wiki) : undefined,
          bot,
        );
        const response = await targetBot.request({
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
        "查询指定修订版本（revision）的修改差异（Diff，默认中文维基百科）。" +
        "当用户提供形如 [[Special:Diff/12345]]、[[Special:差异/12345]]、[[Special:差異/12345]]、" +
        "[[Special:Diff/12345/67890]]、[[Special:差异/12345/67890]]、[[Special:差異/12345/67890]]，" +
        "或询问某次修改/版本改动了什么时使用。" +
        "只传入纯数字版本号：链接中的「#锚点」不属于版本号，必须丢弃。跨维基差异可用 wiki 参数指定站点。" +
        "返回修订版本元数据、编辑摘要及详细差异对比（Wikitext diff 行）。",

      inputSchema: z.object({
        revid: z
          .number()
          .int()
          .positive()
          .describe(
            "目标修订版本 ID (toRevid)。若不提供 fromRevid，则对比该版本与其上一版本（父版本）。对应 [[Special:Diff/12345]]、[[Special:差异/12345]]、[[Special:差異/12345]]；链接中的“#锚点”不是版本号的一部分，必须去掉。",
          ),
        fromRevid: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "可选，对比的起始修订版本 ID (fromRevid)。若提供，则对比 fromRevid 到 revid 之间的差异（对应 Special:Diff/12345/67890）。若省略，则对比 revid 与其父版本。",
          ),
        wiki: z
          .string()
          .min(1)
          .optional()
          .describe(
            "可选，跨语言/跨维基前缀，例如 en、ja、c、d、m 等；省略则在当前站点查询。",
          ),
      }),

      execute: async ({ revid, fromRevid, wiki }) => {
        const startedAt = Date.now();
        log?.debug({ revid, fromRevid, wiki }, "tool getWikiDiff started");

        const targetBot = interwikiBot(
          wiki ? interwikiApiUrlForPrefix(wiki) : undefined,
          bot,
        );
        const diff = await revisionDiff(targetBot, revid, { fromRevid });
        if (!diff) {
          return {
            found: false,
            revid,
            fromRevid,
            error: `修订版本 ${revid} 不存在或已被删除`,
          };
        }

        log?.debug(
          {
            revid,
            fromRevid: diff.parentid,
            elapsedMs: Date.now() - startedAt,
          },
          "tool getWikiDiff completed",
        );

        return {
          found: true,
          title: diff.title,
          pageid: diff.pageid,
          targetRevision: {
            revid: diff.revid,
            parentid: diff.parentid,
            user: diff.user,
            timestamp: diff.timestamp,
            comment: diff.comment,
            minor: diff.minor,
          },
          baseRevision: diff.base,
          isNewPage: diff.isNewPage,
          diffText: diff.diffText,
          changesCount: diff.changesCount,
          truncated: diff.truncated,
        };
      },
    }),

    /**
     * 查询指定用户的维基操作日志（用户日志）。
     * 覆盖封禁 / 解封、用户权限变更、页面移动 / 保护 / 删除、上传、巡查等。
     */
    getUserLogs: tool({
      description:
        "查询指定用户的维基操作日志（用户日志，默认中文维基百科）。" +
        "包括封禁 / 解封（block）、用户权限变更（rights）、页面移动（move）、保护（protect）、删除 / 恢复（delete）、上传（upload）、巡查（patrol）、创建账户（newusers）等。" +
        "当需要了解某用户做过哪些管理操作、权限何时变更、移动过哪些页面时使用。" +
        "type 只接受单个日志类型（MediaWiki 限制）；省略 type 则返回该用户全部类型的日志。需要注意：封禁日志里的「被封禁者」是页面标题（User:XXX），若只想确认某用户当前是否被封禁，应改用 getUserRights 的 blockinfo，或用 getPageLogs 查询“User:XXX”的 block 日志。" +
        "支持传入 continueToken 接续翻页；跨维基可用 wiki 参数指定站点。",

      inputSchema: z.object({
        user: z
          .string()
          .min(1)
          .max(255)
          .describe(
            "MediaWiki用户名，不要添加User:前缀，例如“逆襲的天邪鬼”；也可传入IP地址。",
          ),
        type: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "可选，日志类型过滤（只能填一个）。常见值：block（封禁/解封）、rights（用户权限变更）、move（页面移动）、protect（保护/解除保护）、delete（删除/恢复）、upload（上传）、patrol（巡查）、newusers（创建账户）、renameuser、import、tag、thanks 等；省略则返回该用户全部类型的日志。",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_RESULTS)
          .default(10)
          .describe("返回最近多少条日志，默认10，最多20"),
        continueToken: z
          .string()
          .optional()
          .describe("可选，上一页返回的接续令牌（continueToken）。"),
        wiki: z
          .string()
          .min(1)
          .optional()
          .describe(
            "可选，跨语言/跨维基前缀，例如 en、ja、c、d、m 等；省略则在当前站点查询。",
          ),
      }),

      execute: async ({ user, type, limit, continueToken, wiki }) => {
        const targetBot = interwikiBot(
          wiki ? interwikiApiUrlForPrefix(wiki) : undefined,
          bot,
        );
        const normalizedUser = normalizeUserName(user);
        const result = await queryLogEvents(targetBot, {
          user: normalizedUser,
          type,
          limit,
          continueToken,
        });
        return {
          user: normalizedUser,
          type: type ?? null,
          ...(wiki ? { prefix: wiki } : {}),
          ...result,
        };
      },
    }),

    /**
     * 查询指定页面的维基操作日志（页面日志）。
     * 覆盖移动、保护、删除 / 恢复、创建、导入等。
     */
    getPageLogs: tool({
      description:
        "查询指定页面的维基操作日志（页面日志，默认中文维基百科）。" +
        "包括页面移动（move）、保护 / 解除保护（protect）、删除 / 恢复（delete）、创建（create）、导入（import）、内容模型变更（contentmodel）、合并（merge）等。" +
        "当需要了解某页面何时被删除、移动、保护，或页面曾用名、删除原因、操作者时使用。" +
        "type 只接受单个日志类型；省略 type 则返回该页面全部类型的日志。" +
        "标题可使用跨语言/跨维基前缀（如“en:Example”），「#锚点」会被自动忽略；支持 continueToken 接续翻页。",

      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(255)
          .describe(
            "完整页面标题，例如“人工智能”、“User talk:Example”；可使用跨语言/跨维基前缀（如“en:Example”），“#锚点”会被自动忽略。",
          ),
        type: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "可选，日志类型过滤（只能填一个）。常见值：move（移动）、protect（保护/解除保护）、delete（删除/恢复）、create（创建）、import（导入）、contentmodel、upload、merge、patrol 等；省略则返回该页面全部类型的日志。",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_RESULTS)
          .default(10)
          .describe("返回最近多少条日志，默认10，最多20"),
        continueToken: z
          .string()
          .optional()
          .describe("可选，上一页返回的接续令牌（continueToken）。"),
      }),

      execute: async ({ title, type, limit, continueToken }) => {
        const parsed = parseWikiInput(title);
        if (parsed.special) {
          return {
            found: false,
            title,
            events: [],
            continueToken: null,
            hasMore: false,
            note: "该输入是 Special:Diff / Special:Permalink / oldid 固定链接，不是页面标题；请传入页面标题。",
          };
        }
        const targetBot = interwikiBot(parsed.apiUrl, bot);
        const result = await queryLogEvents(targetBot, {
          title: parsed.title,
          type,
          limit,
          continueToken,
        });
        return {
          found: true,
          title: parsed.title,
          ...(parsed.prefix ? { prefix: parsed.prefix } : {}),
          ...(type ? { type } : {}),
          ...result,
        };
      },
    }),

    /**
     * 查询指定用户的当前用户组、权限、编辑数与封禁状态。
     */
    getUserRights: tool({
      description:
        "查询指定用户的当前用户组、权限、编辑数、注册时间与封禁状态（默认中文维基百科）。" +
        "当需要确认某用户是否拥有管理员 / 回退员 / 机器人等权限，或了解其是否被封禁、何时注册、编辑数时使用。" +
        "返回 groups（显式用户组）、implicitGroups（隐式用户组）、rights（权限列表）、editcount、registration 及封禁信息。" +
        "跨维基可用 wiki 参数指定站点。",

      inputSchema: z.object({
        user: z
          .string()
          .min(1)
          .max(255)
          .describe("MediaWiki用户名，不要添加User:前缀，例如“逆襲的天邪鬼”。"),
        wiki: z
          .string()
          .min(1)
          .optional()
          .describe(
            "可选，跨语言/跨维基前缀，例如 en、ja、c、d、m 等；省略则在当前站点查询。",
          ),
      }),

      execute: async ({ user, wiki }) => {
        const targetBot = interwikiBot(
          wiki ? interwikiApiUrlForPrefix(wiki) : undefined,
          bot,
        );
        const normalizedUser = normalizeUserName(user);
        const response = await targetBot.request({
          action: "query",
          list: "users",
          ususers: normalizedUser,
          usprop:
            "groups|implicitgroups|rights|editcount|registration|blockinfo|centralids",
          formatversion: 2,
        });

        const info = response?.query?.users?.[0];
        if (!info || info.missing) {
          return {
            found: false,
            user: normalizedUser,
            ...(wiki ? { prefix: wiki } : {}),
          };
        }

        const blocked = info.blockid !== undefined;
        return {
          found: true,
          user: info.name ?? normalizedUser,
          userid: info.userid,
          groups: info.groups ?? [],
          implicitGroups: info.implicitgroups ?? [],
          rights: info.rights ?? [],
          editcount: info.editcount,
          registration: info.registration,
          blocked,
          blockInfo: blocked
            ? {
                blockId: info.blockid,
                blockedBy: info.blockedby,
                reason: info.blockreason,
                timestamp: info.blockedtimestamp,
                expiry: info.blockexpiry,
              }
            : null,
          ...(wiki ? { prefix: wiki } : {}),
        };
      },
    }),

    /**
     * 查询指定用户的用户权限变更日志（rights 日志）。
     */
    getUserRightsLog: tool({
      description:
        "查询指定用户的用户权限变更日志（rights 日志，默认中文维基百科）。" +
        "返回每次权限变更的时间、操作者、摘要，以及变更前后的用户组（params.oldgroups / params.newgroups）。" +
        "当需要了解某用户何时被授予或移除管理员 / 回退员 / 机器人等权限、由谁操作时使用。" +
        "支持传入 continueToken 接续翻页；跨维基可用 wiki 参数指定站点。",

      inputSchema: z.object({
        user: z
          .string()
          .min(1)
          .max(255)
          .describe("MediaWiki用户名，不要添加User:前缀，例如“逆襲的天邪鬼”。"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_RESULTS)
          .default(10)
          .describe("返回最近多少条权限变更日志，默认10，最多20"),
        continueToken: z
          .string()
          .optional()
          .describe("可选，上一页返回的接续令牌（continueToken）。"),
        wiki: z
          .string()
          .min(1)
          .optional()
          .describe(
            "可选，跨语言/跨维基前缀，例如 en、ja、c、d、m 等；省略则在当前站点查询。",
          ),
      }),

      execute: async ({ user, limit, continueToken, wiki }) => {
        const targetBot = interwikiBot(
          wiki ? interwikiApiUrlForPrefix(wiki) : undefined,
          bot,
        );
        const normalizedUser = normalizeUserName(user);
        const result = await queryLogEvents(targetBot, {
          user: normalizedUser,
          type: "rights",
          limit,
          continueToken,
        });
        return {
          user: normalizedUser,
          ...(wiki ? { prefix: wiki } : {}),
          ...result,
        };
      },
    }),

    /**
     * 按任意 URL 抓取页面正文（仅 GET、自动跟随重定向、只取静态文本、禁止内网）。
     */
    fetchUrl: tool({
      description:
        "根据任意网址（http/https）读取其页面内容。" +
        "当用户给出站外链接并要求了解该网页内容，或需要用维基百科以外的资料核实信息时使用。" +
        "仅支持 GET 请求、自动跟随重定向；只返回静态文本内容，**不会执行页面中的 JavaScript / CSS**。" +
        "HTML 会先剥离 script/style 等再转为纯文本；正文过长或文件过大时会截断。" +
        "出于安全考虑禁止访问本机与内部网络地址（127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、*.local、localhost 等，以及解析到这些地址的域名），此类请求会被拒绝。" +
        "仅支持 http / https，不支持 file、ftp、data 等协议；未写协议时默认按 https 处理。",

      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .max(2048)
          .describe(
            "要访问的完整网址，例如“https://example.com/news/2026/01/01/”。未写协议时默认按 https 处理。",
          ),
      }),

      execute: async ({ url }) => {
        const startedAt = Date.now();
        const result = await fetchUrlContent(url, { log });
        log?.debug(
          {
            url,
            ok: result.ok,
            status: result.status,
            elapsedMs: Date.now() - startedAt,
          },
          "tool fetchUrl completed",
        );
        return result;
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
