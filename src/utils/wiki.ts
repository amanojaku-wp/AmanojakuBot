import {
  Mwn,
  type ApiParams,
  type ApiResponse,
  type RawRequestParams,
} from "mwn";
import { diffLines } from "diff";

/** 单次差异文本的最大字符数（超出后截断，避免超长 diff 进入提示词或占用过多内存）。 */
export const MAX_DIFF_CHARS = 120000;

/**
 * 判断错误是否为匿名 IP 软封禁导致的（通常因 Session/登录态丢失引起）
 */
export function isSoftBlockError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as {
    code?: string;
    blockinfo?: {
      systemblocktype?: string;
      blockanononly?: boolean;
    };
  };
  return (
    err.code === "blocked" &&
    err.blockinfo?.systemblocktype === "wgSoftBlockRanges" &&
    err.blockinfo?.blockanononly === true
  );
}

/**
 * 创建 MediaWiki API 客户端实例
 *
 * 遵守 Wikimedia User-Agent 策略（须标明机器人名称、版本号与联系方式）。
 * 自动拦截因 Session 丢失导致的匿名 IP 软封禁 (wgSoftBlockRanges)，并重新登录后重试。
 */
export function createWiki(apiUrl: string, username: string, password: string) {
  const bot = new Mwn({
    apiUrl,
    username,
    password,
    userAgent: "AmanojakuBot/0.1 (contact via bot talk page)",
  });

  const originalRequest = bot.request.bind(bot);

  // 包装 request 方法，在遇到 Session 掉线导致 IP 软封禁时自动重新登录并重试
  bot.request = async function (
    params: ApiParams,
    customRequestOptions?: RawRequestParams & { _softBlockRetried?: boolean },
  ): Promise<ApiResponse> {
    try {
      return await originalRequest(params, customRequestOptions);
    } catch (error: unknown) {
      const isLoginAction =
        params &&
        typeof params === "object" &&
        (params.action === "login" ||
          (params as Record<string, unknown>).type === "login");

      const isRetry = customRequestOptions?._softBlockRetried;

      if (
        isSoftBlockError(error) &&
        !isLoginAction &&
        !isRetry &&
        bot.options.username &&
        bot.options.password
      ) {
        await bot.login();
        if (
          params &&
          typeof params === "object" &&
          "token" in params &&
          bot.csrfToken
        ) {
          (params as Record<string, unknown>).token = bot.csrfToken;
        }
        return await originalRequest(params, {
          ...customRequestOptions,
          _softBlockRetried: true,
        } as RawRequestParams);
      }
      throw error;
    }
  };

  return bot;
}

/**
 * 读取指定维基页面的最新 wikitext 原始内容
 */
export async function pageText(
  bot: Mwn,
  title: string,
  { redirects = true, converttitles = true } = {},
) {
  const page = await bot.read(title, {
    redirects,
    converttitles,
  });
  return page?.revisions?.[0]?.content ?? "";
}

/**
 * 获取指定修订版本的元数据及其前后差异内容
 *
 * 核心安全与鉴权逻辑：
 * 1. 真实用户识别：严格依赖 MediaWiki API 返回的权威 `userid`（正整数），绝不信任 wikitext 中的签名文本（`~~~~` 可被仿冒）。
 * 2. 匿名与封禁过滤：若 `userid` 非正整数（IP 用户、被版本删除的隐藏用户等），直接返回 null 予以忽略。
 * 3. 差异基准获取：自动查询 `parentid` 获取修改前文本（before）与修改后文本（after），用于后续的留言提取或 diffLine 分析。
 */
export async function revision(bot: Mwn, revid: number) {
  const data = await bot.request({
    action: "query",
    prop: "revisions",
    revids: revid,
    rvprop: "ids|user|userid|timestamp|content",
    rvslots: "main",
    formatversion: 2,
  });
  const rev = data.query?.pages?.[0]?.revisions?.[0];
  if (!rev || !Number.isInteger(rev.userid) || rev.userid <= 0) return null;
  const parent = rev.parentid
    ? await bot.request({
        action: "query",
        prop: "revisions",
        revids: rev.parentid,
        rvprop: "ids|content",
        rvslots: "main",
        formatversion: 2,
      })
    : null;
  return {
    actorId: rev.userid as number,
    actor: rev.user as string,
    timestamp: rev.timestamp as string | undefined,
    before: rev.parentid
      ? (parent?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content as
          string | undefined)
      : "",
    after: rev.slots?.main?.content as string | undefined,
  };
}

/**
 * 单个修订版本的元数据、完整内容及其相对基准版本（默认父版本）的差异。
 */
export type RevisionDiff = {
  pageid?: number;
  /** 修订所属页面标题（页面被移动时以当前标题为准） */
  title: string;
  /** 页面命名空间编号（API 未返回时为 undefined） */
  namespace?: number;
  /** 目标修订版本号 */
  revid: number;
  /** 对比基准版本号（新建页面为 0） */
  parentid: number;
  user?: string;
  timestamp?: string;
  comment: string;
  minor: boolean;
  /** 目标修订版本的完整 Wikitext（调用方按需截断，避免直接把超长正文塞进提示词） */
  content: string;
  /** 对比基准版本的元数据；无父版本时为 null */
  base: {
    revid?: number;
    user?: string;
    timestamp?: string;
    comment?: string;
  } | null;
  /** 是否为新建页面（无父版本可对比） */
  isNewPage: boolean;
  /** `+` / `-` 前缀的差异文本（超过 MAX_DIFF_CHARS 时截断） */
  diffText: string;
  /** 新增 / 删除的连续文本块数量 */
  changesCount: number;
  /** 差异文本是否因过长被截断 */
  truncated: boolean;
};

/**
 * 读取指定修订版本相对基准版本（默认父版本）的差异，以及该修订的完整内容。
 *
 * 用途：任务三（3-1 动态扫描 / 3-2 请求分析）需要把「本次编辑差异」与「完整条目」
 * 一并送审，这里的差异与内容都只是待分析的数据，不授予任何编辑权限。
 *
 * 返回 null 表示修订不存在或已被删除/隐藏（无法读取内容）。
 */
export async function revisionDiff(
  bot: Mwn,
  revid: number,
  options: { fromRevid?: number } = {},
): Promise<RevisionDiff | null> {
  const { fromRevid } = options;

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
  if (!targetPage || targetPage.missing || !targetRev) return null;

  const targetContent =
    targetRev.slots?.main?.content ??
    targetRev.slots?.main?.["*"] ??
    targetRev.content ??
    targetRev["*"] ??
    "";

  // 对比基准：显式指定的 fromRevid 优先，否则使用父版本。
  const baseRevId = fromRevid ?? targetRev.parentid;

  let baseContent = "";
  let baseRevInfo: RevisionDiff["base"] = null;

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

  // 差异文本按 `+ ` / `- ` 行前缀渲染，未变更的行不进入提示词。
  let changesCount = 0;
  let diffText = "";
  for (const part of diffLines(baseContent, targetContent)) {
    if (part.added) {
      changesCount++;
      diffText += `+ ${part.value.trimEnd()}\n`;
    } else if (part.removed) {
      changesCount++;
      diffText += `- ${part.value.trimEnd()}\n`;
    }
  }

  const truncated = diffText.length > MAX_DIFF_CHARS;
  if (truncated) {
    diffText = diffText.slice(0, MAX_DIFF_CHARS) + "\n...[差异过长已截断]";
  }

  return {
    pageid: targetPage.pageid,
    title: targetPage.title as string,
    namespace:
      typeof targetPage.ns === "number" ? (targetPage.ns as number) : undefined,
    revid: targetRev.revid as number,
    parentid: (baseRevId ?? 0) as number,
    user: targetRev.user as string | undefined,
    timestamp: targetRev.timestamp as string | undefined,
    comment: (targetRev.comment ?? "") as string,
    minor: !!targetRev.minor,
    content: targetContent,
    base: baseRevInfo,
    isNewPage: !baseRevId || baseRevId === 0,
    diffText: diffText.trim(),
    changesCount,
    truncated,
  };
}
