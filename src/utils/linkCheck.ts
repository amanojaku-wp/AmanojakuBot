import { EnvHttpProxyAgent, request } from "undici";
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";

/**
 * 参考文献 URL 可达性检查（确定性检查，不依赖 LLM）
 *
 * 背景：任务三的两个入口（3-1 定期扫描、3-2 模板请求）都完全依赖大模型判断「疑似 AI 线索」，
 * 而模型容易受文风影响、也看不到链接本身是否真的可用。这里补一条纯程序化检查：
 * 从条目的参考文献 / 外部链接（以及其它出现在正文里的 URL）中提取链接并实际探测一次，
 * 把「访问超时 / 拒绝连接 / 403 / 404 等」这类客观事实作为独立线索交给人工复核。
 *
 * 说明与边界：
 * - 本检查只产出「客观事实」（某个 URL 这次探测失败），不判断编者是否使用了 AI；
 *   链接失效也可能只是因为站点反爬、临时故障或来源本身抄录有误，因此只作为低强度线索。
 * - 结果写入本地 `citation_links` 表并在复用窗口内直接复用，
 *   避免同一条目（以及被多个条目引用的同一 URL）每轮扫描都重新发起网络请求（「以免重复跑测试」）。
 * - 只使用本次探测到的状态码 / 错误类型，不读取、不保存响应正文。
 * - 已存档的引用（`archive-url` / `url-status=dead`）不检查原链接；
 *   `archive-url` 指向存档站（web.archive.org、archive.today、archive.is 等）时连存档链接也不检查，
 *   见 ARCHIVE_HOSTS 与 isArchiveHost。
 * - 探测一律**优先 IPv4**：服务器能访问 IPv6，但当前 IPv6 地址解析不可用；仅在 IPv4 解析不到地址
 *   （该来源可能只有 AAAA 记录）时才退回系统默认解析，且只在拿到确定结论时采用（见 probeLink）。
 * - **本机 DNS 解析失败单列为「环境侧未检查」**（isDnsResolutionFailure）：既不当作链接失效线索，
 *   也不会写成「拒绝连接」——那很可能是机器人所在网络的问题，不是编者的问题；
 *   这类结果在本地缓存里只复用很短时间（LINK_CHECK_DNS_REUSE_MS），DNS 环境恢复后会尽快重查。
 */

/** 单个 URL 探测的默认超时时间（毫秒）。 */
export const LINK_CHECK_TIMEOUT_MS = 15_000;

/**
 * 同一 URL 检查结果的复用窗口（默认 7 天）。
 * 窗口内不重复探测，避免重复消耗网络请求与拖慢扫描。
 */
export const LINK_CHECK_REUSE_MS = 7 * 24 * 3600 * 1000;

/** 单个条目单次检查的 URL 数量上限（按正文出现顺序取前 N 个）。 */
export const MAX_LINKS_PER_ARTICLE = 100;

/** URL 并发探测数上限（避免把一次扫描变成对目标站点的小规模爬取）。 */
export const LINK_CHECK_CONCURRENCY = 4;

/**
 * 解析类失败（本机 DNS 无法解析）结果的缓存复用时长（1 小时）。
 *
 * 远短于普通结果的 7 天：这类失败反映的是运行环境（如本机 IPv6 地址解析不可用），
 * 与目标链接本身无关，DNS 环境一旦恢复就应当尽快重新检查，不应在 7 天窗口内一直沿用
 * 「未检查成」的结论。
 */
export const LINK_CHECK_DNS_REUSE_MS = 3600 * 1000;

/**
 * 探测时使用的 User-Agent。
 *
 * 刻意带上机器人标识与联系方式（遵守 Wikimedia User-Agent 策略），
 * 不使用浏览器伪装：被目标站点识别为机器人而返回 403 时，我们希望如实记录并交由人工判断，
 * 而不是靠伪装去「提高通过率」。
 */
const LINK_CHECK_USER_AGENT =
  "AmanojakuBot/0.1 (reference link check; contact via zh.wikipedia bot talk page)";

/**
 * URL 探测结果状态。
 *
 * - ok：2xx / 3xx，可正常访问
 * - dead：403 / 404 / 410 等「来源本身不可用或拒绝访问」的确定性失败
 * - network_error：超时、拒绝连接、DNS 失败、TLS 错误等网络层失败
 *   （其中 DNS 解析失败属机器人侧环境问题，由 isDnsResolutionFailure 单独识别，不计为链接失效）
 * - server_error：5xx（目标站点故障，不作为线索）
 * - rate_limited：429（我方请求过快，不作为线索）
 * - client_error：其余 4xx（如 400/401/405，不作为线索）
 */
export type LinkCheckStatus =
  | "ok"
  | "dead"
  | "network_error"
  | "server_error"
  | "rate_limited"
  | "client_error";

/** 单个 URL 的检查结果（对应 `citation_links` 表一行）。 */
export type LinkCheckResult = {
  /** 规范化后的 URL（已去除片段） */
  url: string;
  status: LinkCheckStatus;
  /** HTTP 状态码；网络层失败时为 undefined */
  httpStatus?: number;
  /** 网络层错误的分类标识（timeout / refused / dns / tls …） */
  error?: string;
  /** 检查时间（ISO 8601） */
  checkedAt: string;
  /** 结果是否来自本地缓存（true 表示本次未重新发起探测） */
  cached: boolean;
};

/**
 * 判断一次探测失败是否属于「本机 DNS 解析异常」。
 *
 * 服务器当前 IPv6 地址解析不可用、解析器超时等环境下，**所有**域名（包括完全正常的链接）
 * 都可能解析失败（ENOTFOUND / EAI_AGAIN）。这类失败与链接本身无关：
 *
 * - 不得描述为「拒绝连接」——那是把机器人所在网络的解析 / 路由问题写成目标站点拒绝访问；
 * - 不得作为「参考文献 URL 无法访问」的线索依据——那很可能是机器人侧问题，不是编者的问题。
 */
export function isDnsResolutionFailure(result: LinkCheckResult): boolean {
  return (
    result.status === "network_error" &&
    (result.error === "dns" || result.error === "dns_temp")
  );
}

/** 判定为「疑似异常来源」的状态：确定性失效或网络层不可达（不含本机 DNS 解析失败）。 */
export function isSuspectCitationLink(result: LinkCheckResult): boolean {
  // 本机 DNS 解析失败属环境侧问题，不计为链接失效（见 isDnsResolutionFailure）
  if (isDnsResolutionFailure(result)) return false;
  return result.status === "dead" || result.status === "network_error";
}

/** 把失败原因渲染为简短的中文说明（供线索证据与日志使用）。 */
export function describeLinkFailure(result: LinkCheckResult): string {
  if (result.status === "network_error") {
    const label =
      NETWORK_ERROR_LABELS[result.error ?? ""] ??
      `访问失败（${result.error ?? "未知错误"}）`;
    return label;
  }
  if (result.httpStatus !== undefined) {
    const label = HTTP_STATUS_LABELS[result.httpStatus];
    return `HTTP ${result.httpStatus}${label ? ` ${label}` : ""}`;
  }
  return "无法访问";
}

/**
 * 把检查结果归类为交给大模型的稳定错误标识（`deadUrls[].httpError`）。
 *
 * - timeout：访问超时（含连接超时、读取超时）
 * - reject：拒绝连接 / 拒绝访问（ECONNREFUSED、HTTP 403）
 * - dns：本机域名解析失败（环境侧问题，不会出现在 deadUrls 里，见 isDnsResolutionFailure）
 * - other：其余失败（TLS 错误、连接重置、404 / 410 等）
 */
export function classifyLinkError(
  result: LinkCheckResult,
): "timeout" | "reject" | "other" | "dns" {
  if (result.status === "network_error") {
    // 解析类失败单独归类：它反映的是本机 DNS 环境，不得与「拒绝连接」混为一谈
    if (isDnsResolutionFailure(result)) return "dns";
    if (result.error === "timeout") return "timeout";
    if (result.error === "refused") return "reject";
    return "other";
  }
  if (result.httpStatus === 403) return "reject";
  return "other";
}

/** 常见 HTTP 状态码的中文说明。 */
const HTTP_STATUS_LABELS: Record<number, string> = {
  400: "请求无效",
  401: "需要认证",
  403: "拒绝访问",
  404: "页面不存在",
  405: "方法不允许",
  410: "页面已删除",
  429: "请求过于频繁",
};

/** 网络层错误分类的中文说明。 */
const NETWORK_ERROR_LABELS: Record<string, string> = {
  timeout: "访问超时",
  refused: "拒绝连接",
  reset: "连接被重置",
  unreachable: "网络不可达",
  dns: "本机 DNS 无法解析该域名（机器人侧问题）",
  dns_temp: "本机 DNS 解析暂时失败（机器人侧问题）",
  tls: "TLS 证书错误",
  too_many_redirects: "重定向次数过多",
  other: "网络访问失败",
};

/**
 * 提取到的一条参考文献链接。
 *
 * `referenceName` 为该链接所属来源的可读标识：优先取 `<ref name="…">` 的 name，
 * 其次取同一引用模板的 title 参数（便于人工在大段正文里定位）。
 */
export type ExtractedReference = {
  url: string;
  referenceName?: string;
};

/** 文本区间（用于按位置判断 URL 是否落在被跳过的参数值内）。 */
type Span = { start: number; end: number };

/**
 * 引用模板中的「原链接」参数（存档时这些参数失效属正常情况，需跳过）。
 *
 * 注意前瞻：`url` 分支不会误匹配 `chapter-url`，因为要求 `|` 之后紧跟参数名。
 */
const ORIGINAL_URL_PARAMS =
  /\|\s*(?:url|chapter-?_?url|contribution-?_?url|section-?_?url|article-?_?url|lay-?_?url|map-?_?url|entry-?_?url)\s*=\s*([^\s|}]+)/gi;

/**
 * 引用模板中的「存档链接」参数（`archive-url` / `archiveurl`，以及部分模板的 `archive-url2`）。
 */
const ARCHIVE_URL_PARAMS = /\|\s*archive-?_?url\d?\s*=\s*([^\s|}]+)/gi;

/**
 * 常见网页存档站的主机名（条目标题即为其根域，子域一并匹配）。
 *
 * 这些站点对来自数据中心 / 自动化的访问经常直接返回 403、429 或超时：
 * 如果照常探测，同一批规范引用会在每轮扫描里被反复报成「URL 无法访问」的误报噪声，
 * 而存档链接失效与否本来就不需要机器人判断（人工核对时自然会打开一次）。
 * 因此 `archive-url` 参数中指向这些站点的链接不参与可达性检查。
 */
export const ARCHIVE_HOSTS: readonly string[] = [
  // Internet Archive（含 web.archive.org / wayback）
  "archive.org",
  // archive.today 及其镜像域名
  "archive.today",
  "archive.is",
  "archive.ph",
  "archive.li",
  "archive.vn",
  "archive.md",
  "archive.fo",
  "archive.bt",
  // 其它常见存档站
  "ghostarchive.org",
  "webcitation.org",
  "megalodon.jp",
  "archive.wikiwix.com",
  "timetravel.mementoweb.org",
];

/** 主机名是否属于已知的网页存档站（含其子域）。 */
export function isArchiveHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!host) return false;
  return ARCHIVE_HOSTS.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/**
 * HTML 注释与「示例 / 代码」区块：这些位置里的 URL 不是参考文献，提取前先抹掉。
 *
 * 抹掉时刻意用等长空白替换（而不是删除），这样后续按字符位置定位
 * （URL 是否在某个模板 / ref 内、是否属于被跳过的 url 参数）仍然成立。
 */
const IGNORED_BLOCK_PATTERNS: RegExp[] = [
  /<!--[\s\S]*?-->/g,
  /<(nowiki|code|pre|syntaxhighlight|source|math|score)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
  /<(nowiki|code|pre|syntaxhighlight|source|math|score)\b[^>]*\/\s*>/gi,
];

/** 用等长空白替换匹配内容（保持字符位置不变）。 */
function blankOut(
  text: string,
  patterns: RegExp[] = IGNORED_BLOCK_PATTERNS,
): string {
  let result = text;
  for (const pattern of patterns)
    result = result.replace(pattern, (match) => " ".repeat(match.length));
  return result;
}

/** 找出所有 `{{ … }}` 模板区间（含嵌套的内层模板；外层先于内层返回）。 */
function findTemplateSpans(text: string): Span[] {
  const spans: Span[] = [];
  const stack: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "{" && text[i + 1] === "{") {
      stack.push(i);
      i++;
      continue;
    }
    if (text[i] === "}" && text[i + 1] === "}") {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: i + 2 });
      i++;
    }
  }
  return spans;
}

/** 找出所有 `<ref …>…</ref>` 内容区间及其 name 属性。 */
function findRefSpans(text: string): { span: Span; name?: string }[] {
  const refs: { span: Span; name?: string }[] = [];
  for (const match of text.matchAll(/<ref\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const tagEnd = (match.index ?? 0) + match[0].length;
    const selfClosing = /\/\s*$/.test(attrs);
    let end = tagEnd;
    if (!selfClosing) {
      const close = text.indexOf("</ref>", tagEnd);
      end = close === -1 ? text.length : close;
    }
    const nameMatch = attrs.match(
      /name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>|]+))/i,
    );
    const name = (
      nameMatch?.[1] ??
      nameMatch?.[2] ??
      nameMatch?.[3] ??
      ""
    ).trim();
    refs.push({ span: { start: tagEnd, end }, name: name || undefined });
  }
  return refs;
}

/**
 * 收集「原链接已失效也属正常」的参数值区间。
 *
 * 依据中文维基引用模板约定：模板已给出 `archive-url`（存档副本）或 `url-status` 标记为
 * dead / usurped / unfit / permanent 时，该模板的 `url` 原链接不可访问是预期行为，
 * 不得视为问题——否则会把大量「原文已下线但有存档」的规范引用误报为线索。
 * archive-url 本身仍然正常参与检查（存档站也打不开才是真问题）。
 */
function findArchivedUrlSpans(text: string, templates: Span[]): Span[] {
  const deadStatuses = new Set([
    "dead",
    "usurped",
    "unfit",
    "permanent",
    "deviated",
  ]);
  const ranges: Span[] = [];
  for (const template of templates) {
    const body = text.slice(template.start, template.end);
    const hasArchive = /\|\s*archive-?_?url\s*=\s*\S/i.test(body);
    const status = (
      body.match(/\|\s*url-?_?status\s*=\s*([^|}\n]*)/i)?.[1] ?? ""
    )
      .trim()
      .toLowerCase();
    if (!hasArchive && !deadStatuses.has(status)) continue;
    // 只跳过原链接参数（url / chapter-url / contribution-url …），不动 archive-url
    for (const match of body.matchAll(ORIGINAL_URL_PARAMS)) {
      const value = match[1];
      const start =
        template.start + (match.index ?? 0) + match[0].length - value.length;
      ranges.push({ start, end: start + value.length });
    }
  }
  return ranges;
}

/**
 * 收集 `|archive-url=` 参数值的字符区间。
 *
 * 与 findArchivedUrlSpans 相反：这里关注的是「存档链接本身」，
 * 用于跳过指向已知存档站（见 isArchiveHost）的探测请求。
 */
function findArchiveUrlSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(ARCHIVE_URL_PARAMS)) {
    const value = match[1];
    const start = (match.index ?? 0) + match[0].length - value.length;
    spans.push({ start, end: start + value.length });
  }
  return spans;
}

/** 判断位置是否落在任一区间内。 */
function inSpans(position: number, spans: Span[]): boolean {
  return spans.some((span) => position >= span.start && position < span.end);
}

/** 取位置所属的最小（最内层）区间。 */
function innermostSpan(position: number, spans: Span[]): Span | undefined {
  let found: Span | undefined;
  for (const span of spans) {
    if (position < span.start || position >= span.end) continue;
    if (!found || span.end - span.start < found.end - found.start) found = span;
  }
  return found;
}

/** 取位置所属的最小（最内层）`<ref>` 区间。 */
function innermostRefSpan(
  position: number,
  refs: { span: Span; name?: string }[],
): { span: Span; name?: string } | undefined {
  let found: { span: Span; name?: string } | undefined;
  for (const ref of refs) {
    if (position < ref.span.start || position >= ref.span.end) continue;
    if (
      !found ||
      ref.span.end - ref.span.start < found.span.end - found.span.start
    )
      found = ref;
  }
  return found;
}

/** 从模板区间中读取 title 参数（引用模板的标题，作为来源标识）。 */
function templateTitle(
  text: string,
  span: Span | undefined,
): string | undefined {
  if (!span) return undefined;
  const match = text
    .slice(span.start, span.end)
    .match(/\|\s*title\s*=\s*([^|}\n]+)/i);
  const title = match?.[1]?.trim();
  return title ? title.slice(0, 120) : undefined;
}

/**
 * 从条目 Wikitext 中提取「参考文献 / 外部链接」中的 URL（含来源标识）。
 *
 * 提取范围（超集，宁多勿漏）：
 * - `<ref>` 引用块内的 URL（含命名引用的定义）；
 * - 引用模板的 `url=` / `archive-url=` / `chapter-url=` 等参数；
 * - 正文中的裸 URL 与 `[http://… 标题]` 形式的外部链接。
 *
 * 会先抹掉 HTML 注释与 nowiki / code / pre / syntaxhighlight / math 等「示例或代码」区块，
 * 避免把文档示例里的链接当成参考文献；**模板已提供 archive-url 或 url-status=dead 时，
 * 其原链接（url 参数）不计入**（见 findArchivedUrlSpans）；
 * 此外 **archive-url 参数中指向已知存档站（web.archive.org、archive.today、archive.is 等）的链接
 * 也不计入**（见 ARCHIVE_HOSTS）：存档站对自动访问常返回 403 / 超时，探测结果不能作为线索。
 * 结果按规范化形式去重并保持出现顺序。
 *
 * @param skipHosts 需要跳过的主机名（如机器人所在维基自身，避免把内部链接当外部来源）
 */
export function extractReferenceLinks(
  wikitext: string,
  options: { skipHosts?: string[] } = {},
): ExtractedReference[] {
  if (!wikitext) return [];
  const skip = new Set(
    (options.skipHosts ?? [])
      .map((h) =>
        h
          .trim()
          .toLowerCase()
          .replace(/^www\./, ""),
      )
      .filter(Boolean),
  );

  const scrubbed = blankOut(wikitext);
  const templates = findTemplateSpans(scrubbed);
  const archivedSpans = findArchivedUrlSpans(scrubbed, templates);
  const archiveUrlSpans = findArchiveUrlSpans(scrubbed);
  const refSpans = findRefSpans(scrubbed);

  const found: ExtractedReference[] = [];
  const seen = new Set<string>();
  for (const match of scrubbed.matchAll(/https?:\/\/[^\s<>"'[\]{}|]+/gi)) {
    const position = match.index ?? 0;
    // 已由 archive-url 覆盖的原链接：失效属正常，跳过
    if (inSpans(position, archivedSpans)) continue;

    const raw = trimUrlTail(decodeHtmlEntities(match[0]));
    if (!raw) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    // 只保留形如 host.tld 的主机名，过滤掉占位符（如 http://example、http://localhost）
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.includes(".")) continue;
    // archive-url 指向已知存档站：存档站常拦截自动访问，其探测结果不作为线索
    if (inSpans(position, archiveUrlSpans) && isArchiveHost(hostname)) continue;
    if (skip.has(hostname.replace(/^www\./, ""))) continue;
    if (raw.length > 2000) continue;

    // 规范化：统一协议与主机大小写、去掉片段（片段不影响 HTTP 状态码）
    parsed.hash = "";
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = hostname;
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const ref = innermostRefSpan(position, refSpans);
    const referenceName =
      ref?.name ?? templateTitle(scrubbed, innermostSpan(position, templates));
    found.push(
      referenceName ? { url: normalized, referenceName } : { url: normalized },
    );
  }
  return found;
}

/**
 * 提取条目 Wikitext 中参考文献 / 外部链接的 URL（仅 URL，不含来源标识）。
 */
export function extractReferenceUrls(
  wikitext: string,
  options: { skipHosts?: string[] } = {},
): string[] {
  return extractReferenceLinks(wikitext, options).map((ref) => ref.url);
}

/**
 * 从差异文本（`+ `/`- ` 行前缀）中提取**新增**行里的参考文献链接。
 *
 * 用于统计「本次编辑新增的引用中失效比例」：AI 生成的引用往往集中出现且指向不存在的来源，
 * 而条目里既有的老链接失效与本次编辑无关。
 */
export function extractAddedReferenceLinks(
  diffText: string,
  options: { skipHosts?: string[] } = {},
): ExtractedReference[] {
  if (!diffText) return [];
  const added = diffText
    .split("\n")
    .filter((line) => line.startsWith("+ "))
    .map((line) => line.slice(2))
    .join("\n");
  return extractReferenceLinks(added, options);
}

/** 去掉 URL 尾部的标点与不成对的右括号（维基文本里 URL 常紧邻标点或包裹在括号中）。 */
function trimUrlTail(value: string): string {
  let url = value.trim();
  for (;;) {
    const before = url;
    url = url.replace(/[.,;:!?'"，。、；：！？”’）】》]+$/u, "");
    url = url.replace(/[<>）)\]]+$/, (tail) => {
      const open = (url.match(/[(（[]/g) ?? []).length;
      const close = (url.match(/[)）\]]/g) ?? []).length;
      return close > open ? tail.slice(0, tail.length - 1) : tail;
    });
    if (url === before) break;
  }
  return url;
}

/** 还原 Wikitext / HTML 中常见的实体（主要处理查询参数里的 `&amp;`）。 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/** 把 HTTP 状态码归类为检查状态。 */
function classifyHttpStatus(status: number): LinkCheckStatus {
  if (status >= 200 && status < 400) return "ok";
  if (status === 403 || status === 404 || status === 410) return "dead";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

/** 把 undici / Node 抛出的网络错误归类为稳定的分类标识。 */
function classifyNetworkError(err: unknown): string {
  const e = err as { code?: string; name?: string } | undefined;
  const code = e?.code ?? "";
  const name = e?.name ?? "";
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ETIMEDOUT"
  )
    return "timeout";
  switch (code) {
    case "ECONNREFUSED":
      return "refused";
    case "ECONNRESET":
      return "reset";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "unreachable";
    case "ENOTFOUND":
      return "dns";
    case "EAI_AGAIN":
      return "dns_temp";
    case "UND_ERR_TOO_MANY_REDIRECTS":
      return "too_many_redirects";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_HAS_EXPIRED":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return "tls";
    default:
      return code || "other";
  }
}

/** 跟随重定向的最大跳数（超过则视为链接异常）。 */
export const LINK_CHECK_MAX_REDIRECTS = 5;

/** 探测请求头（遵守 Wikimedia User-Agent 策略，同时声明可接受的内容类型）。 */
const LINK_CHECK_HEADERS: Record<string, string> = {
  "user-agent": LINK_CHECK_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/** 需要跟随重定向的状态码。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 链接探测专用的 dispatcher：强制使用 IPv4。
 *
 * 服务器能访问 IPv6，但当前 IPv6 地址解析不可用：默认的 getaddrinfo 既可能先返回 AAAA
 * （连不上 / 立刻被拒，最后被误报成「拒绝连接」），也可能因为 AAAA 查询失败而整体解析不成功。
 * 这里复用与全局 dispatcher 相同的 EnvHttpProxyAgent（保留 Toolforge 所需的 HTTP 代理行为），
 * 只把 connect 的地址族限定为 IPv4；无代理（no_proxy / 未配置代理）时直接生效。
 */
let ipv4Dispatcher: EnvHttpProxyAgent | undefined;

function getIpv4Dispatcher(): EnvHttpProxyAgent {
  ipv4Dispatcher ??= new EnvHttpProxyAgent({ connect: { family: 4 } });
  return ipv4Dispatcher;
}

/**
 * 发起一次 GET 探测并手动跟随重定向（undici 的 request 默认不跟随重定向）。
 *
 * 使用 GET（部分站点对 HEAD 直接返回 403/405，会造成误报），拿到响应头后立刻释放响应体，
 * 不下载正文；全程受同一个 AbortSignal 超时约束。任何异常都转为 `network_error` 结果，不向上抛出。
 *
 * @param preferIpv4 是否强制 IPv4 连接（见 getIpv4Dispatcher）；false 时使用进程全局 dispatcher
 */
async function probeOnce(
  url: string,
  timeoutMs: number,
  preferIpv4: boolean,
): Promise<LinkCheckResult> {
  const checkedAt = new Date().toISOString();
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  const visited = new Set<string>([url]);

  try {
    for (let hop = 0; hop <= LINK_CHECK_MAX_REDIRECTS; hop++) {
      const res = await request(current, {
        method: "GET",
        headers: LINK_CHECK_HEADERS,
        signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        ...(preferIpv4 ? { dispatcher: getIpv4Dispatcher() } : {}),
      });
      const httpStatus = res.statusCode;
      const location = res.headers?.location;
      // 只需要状态码：立即销毁响应流，避免下载整页或大文件
      res.body.once(
        "error",
        (err: NodeJS.ErrnoException & { code?: string }) => {
          if (err.code !== "UND_ERR_ABORTED") {
            //log.debug(
            //  { err, url: current },
            //  "response body emitted error while discarding",
            //);
          }
        },
      );

      res.body.destroy();

      if (REDIRECT_STATUSES.has(httpStatus) && typeof location === "string") {
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          break; // Location 无法解析：按当前状态码处理
        }
        if (visited.has(next) || hop === LINK_CHECK_MAX_REDIRECTS)
          return {
            url,
            status: "network_error",
            error: "too_many_redirects",
            checkedAt,
            cached: false,
          };
        visited.add(next);
        current = next;
        continue;
      }

      return {
        url,
        status: classifyHttpStatus(httpStatus),
        httpStatus,
        checkedAt,
        cached: false,
      };
    }
    // 循环正常结束（未返回）：理论上不会到达这里
    return {
      url,
      status: "network_error",
      error: "other",
      checkedAt,
      cached: false,
    };
  } catch (err) {
    return {
      url,
      status: "network_error",
      error: classifyNetworkError(err),
      checkedAt,
      cached: false,
    };
  }
}

/**
 * 探测单个 URL 的可达性（优先 IPv4）。
 *
 * 两步走：
 * 1. 先用只解析 IPv4 的连接探测（服务器 IPv6 地址解析当前不可用，见 getIpv4Dispatcher）；
 *    只要不是「本机解析失败」就直接采用该结果。
 * 2. 若 IPv4 解析不到地址（该来源可能只有 AAAA 记录），退回系统默认解析再试一次；
 *    但**只在默认解析给出确定结论时才采用**：拿到 HTTP 状态码、或 TLS 证书错误 / 重定向次数过多
 *    这类与「能否连通」无关的确定性失败。否则说明默认解析又走到了不可用的 IPv6 路径上，
 *    仍按「本机解析失败」上报——那依旧是机器人环境的问题，不能记成「拒绝连接」让编者背锅。
 *
 * 代价：只有 IPv4 解析失败时才会发第二次请求，最坏情况单个 URL 耗时翻倍。
 */
export async function probeLink(
  url: string,
  timeoutMs = LINK_CHECK_TIMEOUT_MS,
): Promise<LinkCheckResult> {
  const ipv4 = await probeOnce(url, timeoutMs, true);
  if (!isDnsResolutionFailure(ipv4)) return ipv4;

  const fallback = await probeOnce(url, timeoutMs, false);
  const definitive =
    fallback.status !== "network_error" ||
    fallback.error === "tls" ||
    fallback.error === "too_many_redirects";
  return definitive ? fallback : ipv4;
}

/**
 * 读取复用窗口内已保存的检查结果。
 *
 * 解析类失败（本机 DNS 异常）另用更短的窗口（dnsReuseMs）：
 * 这类结果只反映当时的网络环境，环境恢复后应当尽快重新探测。
 */
export function readCachedLinkCheck(
  db: DatabaseSync,
  url: string,
  reuseMs = LINK_CHECK_REUSE_MS,
  now = Date.now(),
  dnsReuseMs = LINK_CHECK_DNS_REUSE_MS,
): LinkCheckResult | undefined {
  try {
    const row = db
      .prepare(
        "SELECT url,status,http_status,error,checked_at FROM citation_links WHERE url=?",
      )
      .get(url) as
      | {
          url: string;
          status: string;
          http_status: number | null;
          error: string | null;
          checked_at: string;
        }
      | undefined;
    if (!row) return undefined;
    const checkedAt = Date.parse(row.checked_at);
    if (!Number.isFinite(checkedAt)) return undefined;
    const result: LinkCheckResult = {
      url: row.url,
      status: row.status as LinkCheckStatus,
      httpStatus: row.http_status ?? undefined,
      error: row.error ?? undefined,
      checkedAt: row.checked_at,
      cached: true,
    };
    const limit = isDnsResolutionFailure(result) ? dnsReuseMs : reuseMs;
    if (now - checkedAt >= limit) return undefined;
    return result;
  } catch {
    // 表不存在（旧库未迁移）时视为无缓存，不影响业务
    return undefined;
  }
}

/** 保存 / 更新单个 URL 的检查结果（本地去重，供复用窗口与人工核查使用）。 */
export function saveLinkCheck(db: DatabaseSync, result: LinkCheckResult): void {
  try {
    db.prepare(
      `INSERT INTO citation_links(url,status,http_status,error,checked_at) VALUES(?,?,?,?,?)
       ON CONFLICT(url) DO UPDATE SET
         status=excluded.status,
         http_status=excluded.http_status,
         error=excluded.error,
         checked_at=excluded.checked_at`,
    ).run(
      result.url,
      result.status,
      result.httpStatus ?? null,
      result.error ?? null,
      result.checkedAt,
    );
  } catch {
    // 本地缓存写入失败不影响本次检查结论
  }
}

/** 以固定并发上限执行异步映射（保持结果顺序）。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * 批量检查 URL 可达性：命中复用窗口的直接复用本地结果，其余按并发上限探测并写回本地表。
 *
 * 返回结果与入参顺序一致，便于调用方按正文顺序展示。
 */
export async function checkLinks(
  db: DatabaseSync,
  urls: string[],
  log: Logger,
  options: {
    timeoutMs?: number;
    reuseMs?: number;
    concurrency?: number;
    now?: Date;
  } = {},
): Promise<LinkCheckResult[]> {
  const timeoutMs = options.timeoutMs ?? LINK_CHECK_TIMEOUT_MS;
  const reuseMs = options.reuseMs ?? LINK_CHECK_REUSE_MS;
  const now = options.now ?? new Date();
  const stored = new Map<string, LinkCheckResult>();
  const pending: string[] = [];

  for (const url of urls) {
    const cached = readCachedLinkCheck(db, url, reuseMs, now.getTime());
    if (cached) stored.set(url, cached);
    else pending.push(url);
  }

  if (pending.length > 0) {
    const probed = await mapWithConcurrency(
      pending,
      options.concurrency ?? LINK_CHECK_CONCURRENCY,
      async (url) => {
        const result = await probeLink(url, timeoutMs);
        saveLinkCheck(db, result);
        return result;
      },
    );
    for (const result of probed) stored.set(result.url, result);
    log.debug(
      { probed: pending.length, reused: urls.length - pending.length },
      "citation links checked",
    );
  }

  return urls
    .map((url) => stored.get(url))
    .filter((result): result is LinkCheckResult => !!result);
}
