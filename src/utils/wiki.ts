import {
  Mwn,
  type ApiParams,
  type ApiResponse,
  type RawRequestParams,
} from "mwn";

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
