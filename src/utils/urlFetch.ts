import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { EnvHttpProxyAgent, request } from "undici";
import type { Logger } from "pino";

/**
 * 按任意 URL 抓取页面正文（供聊天任务使用）。
 *
 * 安全边界（这是本模块存在的唯一理由，改动前务必先读）：
 * 1. **只发 GET**，不发送任何凭据；手动跟随重定向，且**每一跳都重新校验**，避免
 *    「公网地址 → 302 跳内网」的绕过。
 * 2. **SSRF 防护**：拒绝本机 / 内网地址。既拒绝字面量 IP（127.0.0.0/8、10.0.0.0/8、
 *    172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、0.0.0.0/8、100.64.0.0/10、
 *    组播 / 保留段等 IPv4 段，以及 ::1、::、fc00::/7、fe80::/10、ff00::/8、IPv4 映射 /
 *    NAT64 / 6to4 / Teredo 等 IPv6 形式），也拒绝**解析到这些地址的域名**
 *    （解析出多个地址时，只要有一个命中就整体拒绝）。
 * 3. 拒绝 `localhost` 与 `*.localhost`、`*.local`、`*.internal`、`*.home.arpa` 等本地名称。
 * 4. 连接阶段用**钉住 DNS 结果**的 lookup（把本模块校验过的地址交给连接器），
 *    防止校验后再次解析（DNS rebinding）指向内网。
 * 5. **只取静态内容**：不执行 JavaScript / CSS，不使用无头浏览器；HTML 会先剥离
 *    `<script>`/`<style>` 等再转成纯文本，且限制下载体积与返回字符数。
 */

/** 单次抓取的总超时（毫秒），同时约束 DNS、连接、响应头与响应体。 */
export const URL_FETCH_TIMEOUT_MS = 20_000;

/** 跟随重定向的最大跳数。 */
export const URL_FETCH_MAX_REDIRECTS = 5;

/** 下载正文的字节上限（超出即截断并销毁连接）。 */
export const URL_FETCH_MAX_BYTES = 2_000_000;

/** 返回给模型的正文最大字符数（HTML 转纯文本后仍过长时截断）。 */
export const URL_FETCH_MAX_TEXT_CHARS = 60_000;

/** 抓取时使用的 User-Agent（遵守 Wikimedia User-Agent 策略，不伪装浏览器）。 */
const URL_FETCH_USER_AGENT =
  "AmanojakuBot/0.1 (url content fetch; contact via zh.wikipedia bot talk page)";

/** 请求头：优先索取静态文本，声明不执行任何脚本。 */
const URL_FETCH_HEADERS: Record<string, string> = {
  "user-agent": URL_FETCH_USER_AGENT,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/** 需要跟随重定向的状态码。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 始终拒绝的主机名（精确匹配）。 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);

/** 始终拒绝的主机名后缀（本地 / 内网专用名称与 mDNS 名称）。 */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
];

/** 抓取成功的结果。 */
export type UrlFetchSuccess = {
  ok: true;
  /** 原始请求 URL（规范化后）。 */
  requestedUrl: string;
  /** 跟随重定向后的最终 URL。 */
  finalUrl: string;
  status: number;
  contentType: string;
  /** HTML 页面的 `<title>`（若有）。 */
  title?: string;
  /** 去除脚本 / 样式后的纯文本正文。 */
  text: string;
  /** 正文是否因体积 / 长度上限被截断。 */
  truncated: boolean;
  /** 重定向链路（含起始 URL 与各跳目标）。 */
  redirects: string[];
};

/** 抓取失败的结果。 */
export type UrlFetchFailure = {
  ok: false;
  /** 原始请求 URL（能规范化时）。 */
  requestedUrl: string;
  /** 人类可读的失败原因（安全拒绝 / 网络错误 / HTTP 错误 / 非文本内容等）。 */
  error: string;
  /** 已取得 HTTP 响应时的状态码。 */
  status?: number;
  /** 已发生重定向时的最终 URL。 */
  finalUrl?: string;
};

export type UrlFetchResult = UrlFetchSuccess | UrlFetchFailure;

// ---------------------------------------------------------------------------
// SSRF：地址判定
// ---------------------------------------------------------------------------

/** 单个 IPv4 字符串是否属于本机 / 内网 / 保留 / 组播等应拒绝的网段。 */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8（"本网络"）
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8（环回）
  if (a === 169 && b === 254) return true; // 169.254.0.0/16（链路本地，含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24（文档）
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24（6to4 中继）
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10（CGNAT）
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15（基准测试）
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24（文档）
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24（文档）
  if (a >= 224) return true; // 224.0.0.0/4 组播 + 240.0.0.0/4 保留（含 255.255.255.255）
  return false;
}

/** 把 IPv6 字面量展开为 16 字节；无法解析时返回 null。 */
function ipv6ToBytes(input: string): number[] | null {
  let value = input.trim().replace(/^\[|\]$/g, "");
  if (value.includes("%")) value = value.split("%")[0]; // 去掉 zone id

  let embeddedV4: number[] | null = null;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (v4) {
    embeddedV4 = v4[1].split(".").map((p) => Number(p));
    if (
      embeddedV4.length !== 4 ||
      embeddedV4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
      return null;
    value = value.slice(0, value.length - v4[1].length);
    if (value.endsWith(":")) value = value.slice(0, -1);
  }

  const doubleColon = value.indexOf("::");
  let groups: string[];
  if (doubleColon === -1) {
    groups = value ? value.split(":") : [];
  } else {
    const left = value.slice(0, doubleColon);
    const right = value.slice(doubleColon + 2);
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing =
      8 - (leftGroups.length + rightGroups.length) - (embeddedV4 ? 2 : 0);
    if (missing < 0) return null;
    groups = [
      ...leftGroups,
      ...Array.from({ length: missing }, () => "0"),
      ...rightGroups,
    ];
  }

  const hextets: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    hextets.push(parseInt(g, 16));
  }
  if (embeddedV4) {
    hextets.push((embeddedV4[0] << 8) | embeddedV4[1]);
    hextets.push((embeddedV4[2] << 8) | embeddedV4[3]);
  }
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const h of hextets) bytes.push((h >> 8) & 0xff, h & 0xff);
  return bytes;
}

/** 已展开为字节的 IPv6 是否属于本机 / 内网 / 保留 / 组播等应拒绝的网段。 */
function isBlockedIpv6Bytes(b: number[]): boolean {
  // :: / ::
  if (b.every((x) => x === 0)) return true;
  // ::1 环回
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;
  // ::ffff:0:0/96 IPv4 映射（判断内嵌 IPv4）
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff)
    return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  // 64:ff9b::/96 NAT64（判断内嵌 IPv4）
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  )
    return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  // 2002::/16 6to4（内嵌 IPv4 位于第 3~6 字节）
  if (b[0] === 0x20 && b[1] === 0x02)
    return isBlockedIpv4(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`);
  // 2001:0000::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00)
    return true;
  // fc00::/7 唯一本地地址
  if ((b[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 链路本地
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // ff00::/8 组播
  if (b[0] === 0xff) return true;
  // 2001:db8::/32 文档
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8)
    return true;
  return false;
}

/** 任意 IP 字面量是否应被拒绝（非 IP 或无法解析也一律拒绝）。 */
export function isBlockedIp(ip: string): boolean {
  const value = ip.trim().replace(/^\[|\]$/g, "");
  const version = isIP(value);
  if (version === 4) return isBlockedIpv4(value);
  if (version === 6) {
    const bytes = ipv6ToBytes(value);
    return bytes ? isBlockedIpv6Bytes(bytes) : true;
  }
  return true;
}

/** 主机名是否属于始终拒绝的本地 / 内网名称。 */
export function isBlockedHostname(hostname: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!name) return true;
  if (BLOCKED_HOSTNAMES.has(name)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// 校验与抓取
// ---------------------------------------------------------------------------

type ValidatedUrl =
  { ok: true; url: URL; addresses: string[] } | { ok: false; error: string };

/**
 * 校验一个 URL 是否允许抓取，并返回解析出的**全部**地址（IPv4 优先排序）。
 *
 * 拒绝：非 http/https、含用户名 / 密码、主机名为本地名称、字面量 IP 属于内网、
 * 域名解析出内网地址、解析失败。
 */
export async function validateFetchUrl(rawUrl: string): Promise<ValidatedUrl> {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) return { ok: false, error: "URL 为空" };

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1]))
    return {
      ok: false,
      error: `不支持的协议：${schemeMatch[1]}（仅允许 http / https）`,
    };
  const candidate = schemeMatch ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: "URL 格式无效" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, error: `不支持的协议：${url.protocol}` };
  if (url.username || url.password)
    return { ok: false, error: "URL 不得包含用户名或密码" };
  if (!url.hostname) return { ok: false, error: "URL 缺少主机名" };

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isBlockedHostname(hostname))
    return { ok: false, error: `拒绝访问本地 / 内网主机：${hostname}` };

  if (isIP(hostname)) {
    if (isBlockedIp(hostname))
      return { ok: false, error: `拒绝访问本地 / 内网地址：${hostname}` };
    return { ok: true, url, addresses: [hostname] };
  }

  let addresses: string[];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((r) => r.address);
  } catch {
    return { ok: false, error: `无法解析主机名：${hostname}` };
  }
  if (addresses.length === 0)
    return { ok: false, error: `无法解析主机名：${hostname}` };

  for (const address of addresses) {
    if (isBlockedIp(address))
      return {
        ok: false,
        error: `域名 ${hostname} 解析到本地 / 内网地址（${address}），已拒绝访问`,
      };
  }

  // IPv4 优先：本机 IPv6 地址解析不可用，优先尝试 IPv4 可减少无谓等待。
  addresses.sort((a, b) => isIP(a) - isIP(b));
  return { ok: true, url, addresses };
}

/**
 * 用校验过的地址「钉住」DNS，避免校验后连接时再次解析（DNS rebinding）指向内网。
 * 仅在无代理直连时生效；配置了 HTTP 代理时由代理解析目标主机（本地校验仍会执行）。
 */
function pinnedLookup(addresses: string[]) {
  return (
    _hostname: string,
    options: number | { all?: boolean; family?: number | "IPv4" | "IPv6" },
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family: number,
    ) => void,
  ): void => {
    const opts = typeof options === "number" ? { family: options } : options;
    const rawFamily = opts?.family;
    const family =
      rawFamily === "IPv4" ? 4 : rawFamily === "IPv6" ? 6 : rawFamily;
    const entries = addresses.map((address) => ({
      address,
      family: isIP(address),
    }));
    const filtered = entries.filter(
      (e) => !family || family === 0 || e.family === family,
    );
    const chosen = filtered.length ? filtered : entries;
    if (opts?.all) callback(null, chosen, 0);
    else callback(null, chosen[0].address, chosen[0].family);
  };
}

type FetchedResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
};

/** 发起一次 GET（不自动跟随重定向），并把正文读入内存（受字节上限约束）。 */
async function requestOnce(
  url: URL,
  addresses: string[],
  timeoutMs: number,
): Promise<FetchedResponse> {
  const dispatcher = new EnvHttpProxyAgent({
    connect: { lookup: pinnedLookup(addresses), autoSelectFamily: true },
  });
  try {
    const res = await request(url, {
      method: "GET",
      headers: URL_FETCH_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      dispatcher,
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      if (total + buf.length > URL_FETCH_MAX_BYTES) {
        chunks.push(buf.subarray(0, URL_FETCH_MAX_BYTES - total));
        truncated = true;
        res.body.destroy();
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }

    return {
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks),
      truncated,
    };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

/** 按 `content-encoding` 解压响应体（失败时原样返回）。 */
function decompressBody(buffer: Buffer, encoding?: string): Buffer {
  const value = (encoding ?? "").trim().toLowerCase();
  try {
    if (value === "gzip" || value === "x-gzip") return gunzipSync(buffer);
    if (value === "deflate") return inflateSync(buffer);
    if (value === "br") return brotliDecompressSync(buffer);
  } catch {
    // 解压失败时按原始字节处理（后面按文本解码，最坏情况是乱码而非崩溃）
  }
  return buffer;
}

/** 从 `content-type` 中提取 charset。 */
function charsetFromContentType(contentType: string): string | undefined {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase();
}

/** 在 HTML 头部嗅探 `<meta charset>`（响应头未给出 charset 时使用）。 */
function sniffCharset(buffer: Buffer): string | undefined {
  const head = buffer.subarray(0, 2048).toString("latin1");
  const meta = /<meta[^>]+charset\s*=\s*["']?([^"'>\s;]+)/i.exec(head);
  return meta?.[1]?.toLowerCase();
}

/** 把字节按给定 / 推断的编码解码为字符串（不支持的编码回退 UTF-8）。 */
function decodeBody(buffer: Buffer, charset?: string): string {
  const candidates = [charset, "utf-8"].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(buffer);
    } catch {
      // 不支持的编码：尝试下一个
    }
  }
  return buffer.toString("utf8");
}

/** 解码常见 HTML 实体（含数字实体）。 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** 提取 HTML 的 `<title>` 文本。 */
function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] ? decodeHtmlEntities(match[1]).trim() : "";
  return title || undefined;
}

/**
 * 把 HTML 转为纯文本：先整体删除脚本 / 样式 / 内联框架等**不会被渲染为正文**的内容，
 * 再把块级元素转换为换行、剥掉剩余标签、解码实体。
 *
 * 这里只做文本提取，**不解析、不执行**任何 JavaScript / CSS。
 */
function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|template|iframe|object|embed|svg|canvas|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(
      /<(script|style|noscript|template|iframe|object|embed|svg|canvas|head|link|meta)\b[^>]*\/?>/gi,
      " ",
    );

  const text = withoutCode
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(
      /<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol|dl|dd|dt|figure|figcaption)\s*>/gi,
      "\n",
    )
    .replace(
      /<(p|div|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol|dl)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(text)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 判断 content-type 是否为可读的文本类型。 */
function isTextualContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  if (!value) return true; // 未声明时按文本处理
  if (value.startsWith("text/")) return true;
  return [
    "application/xhtml+xml",
    "application/xml",
    "application/json",
    "application/ld+json",
    "application/rss+xml",
    "application/atom+xml",
    "application/x-ndjson",
  ].some((type) => value.startsWith(type));
}

/** 取响应头中的单个字符串值。 */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 抓取任意 URL 的静态页面正文（SSRF 安全版）。
 *
 * - 只发 GET；手动跟随重定向且每一跳都重新做 SSRF 校验；
 * - 拒绝本地 / 内网地址与解析到它们的域名；
 * - 只接受文本类型（HTML 转纯文本，不执行 JS / CSS），限制下载体积与返回长度；
 * - 任何异常都转为 `{ ok: false, error }`，不向上抛出。
 */
export async function fetchUrlContent(
  rawUrl: string,
  options: { timeoutMs?: number; log?: Logger } = {},
): Promise<UrlFetchResult> {
  const timeoutMs = options.timeoutMs ?? URL_FETCH_TIMEOUT_MS;
  const redirects: string[] = [];
  let current = rawUrl;
  const visited = new Set<string>();

  try {
    for (let hop = 0; hop <= URL_FETCH_MAX_REDIRECTS; hop++) {
      const validated = await validateFetchUrl(current);
      if (!validated.ok)
        return { ok: false, requestedUrl: rawUrl, error: validated.error };

      const url = validated.url;
      const normalized = url.toString();
      if (visited.has(normalized))
        return {
          ok: false,
          requestedUrl: rawUrl,
          error: "检测到重定向循环，已停止",
          finalUrl: normalized,
        };
      visited.add(normalized);
      redirects.push(normalized);

      const res = await requestOnce(url, validated.addresses, timeoutMs);
      const location = headerValue(res.headers, "location");

      if (REDIRECT_STATUSES.has(res.status) && typeof location === "string") {
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return {
            ok: false,
            requestedUrl: rawUrl,
            error: `重定向目标无效：${location}`,
            status: res.status,
            finalUrl: normalized,
          };
        }
        current = next.toString();
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        return {
          ok: false,
          requestedUrl: rawUrl,
          error: `HTTP ${res.status}`,
          status: res.status,
          finalUrl: normalized,
        };
      }

      const contentType = headerValue(res.headers, "content-type") ?? "";
      if (!isTextualContentType(contentType)) {
        return {
          ok: false,
          requestedUrl: rawUrl,
          error: `非文本内容（content-type: ${contentType || "未知"}），未获取正文`,
          status: res.status,
          finalUrl: normalized,
        };
      }

      const decoded = decompressBody(
        res.body,
        headerValue(res.headers, "content-encoding"),
      );
      const charset =
        charsetFromContentType(contentType) ??
        sniffCharset(decoded) ??
        undefined;
      const raw = decodeBody(decoded, charset);

      const isHtml =
        /html|xml/i.test(contentType) ||
        (!contentType && /^\s*</.test(raw)) ||
        /<html[\s>]/i.test(raw.slice(0, 512));
      const title = isHtml ? extractTitle(raw) : undefined;
      const text = isHtml ? htmlToText(raw) : raw.trim();

      const truncated = res.truncated || text.length > URL_FETCH_MAX_TEXT_CHARS;
      return {
        ok: true,
        requestedUrl: rawUrl,
        finalUrl: normalized,
        status: res.status,
        contentType: contentType || "text/html",
        ...(title ? { title } : {}),
        text: text.slice(0, URL_FETCH_MAX_TEXT_CHARS),
        truncated,
        redirects,
      };
    }

    return {
      ok: false,
      requestedUrl: rawUrl,
      error: `重定向次数超过上限（${URL_FETCH_MAX_REDIRECTS} 次）`,
      finalUrl: current,
    };
  } catch (err) {
    const message =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, requestedUrl: rawUrl, error: message };
  }
}
