import { diffLines } from "diff";

const ZH_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * 格式化时间戳为维基签名格式
 *
 * 支持预设：
 * - "zhwiki" / "zh": "2026年9月14日 (一) 01:23 (UTC)"
 * - "publictestwiki" / "enwiki" / "en": "14:14, 7 June 2026 (UTC)"
 * 以及包含相应占位符的自定义格式。
 */
export function formatWikiTimestamp(
  dateInput: Date | string | number,
  format = "zhwiki",
): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const dayOfWeek = date.getUTCDay();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  const normalized = format.toLowerCase().trim();

  if (
    normalized === "zhwiki" ||
    normalized === "zh" ||
    normalized === "zhwp" ||
    normalized.includes("年")
  ) {
    // 中文维基百科标准格式：2026年9月14日 (一) 01:23 (UTC)
    return `${year}年${month}月${day}日 (${ZH_WEEKDAYS[dayOfWeek]}) ${hours}:${minutes} (UTC)`;
  }

  if (
    normalized === "publictestwiki" ||
    normalized === "enwiki" ||
    normalized === "en" ||
    normalized === "testwiki" ||
    normalized === "default" ||
    normalized.includes("june")
  ) {
    // publictestwiki / enwiki 标准格式：14:14, 7 June 2026 (UTC)
    return `${hours}:${minutes}, ${day} ${EN_MONTHS[month - 1]} ${year} (UTC)`;
  }

  // 自定义模板占位符替换
  return format
    .replace(/YYYY/g, String(year))
    .replace(/MMMM/g, EN_MONTHS[month - 1])
    .replace(/MMM/g, EN_MONTHS[month - 1].slice(0, 3))
    .replace(/MM/g, String(month).padStart(2, "0"))
    .replace(/M/g, String(month))
    .replace(/DD/g, String(day).padStart(2, "0"))
    .replace(/D/g, String(day))
    .replace(/\(dd\)/g, `(${ZH_WEEKDAYS[dayOfWeek]})`)
    .replace(/dd/g, ZH_WEEKDAYS[dayOfWeek])
    .replace(/ddd/g, EN_WEEKDAYS[dayOfWeek])
    .replace(/HH/g, hours)
    .replace(/H/g, String(date.getUTCHours()))
    .replace(/mm/g, minutes)
    .replace(/m/g, String(date.getUTCMinutes()))
    .replace(/ss/g, seconds)
    .replace(/s/g, String(date.getUTCSeconds()))
    .replace(/\(UTC\)/g, "(UTC)");
}

/**
 * 检查文本中是否包含与指定修订时间匹配的时间戳
 *
 * 考虑维基保存过程中的秒级进位与轻微时钟差异，支持当前分钟及前后 1 分钟容差。
 */
export function containsMatchingTimestamp(
  text: string,
  revTimestamp?: string | Date,
  format = "zhwiki",
): boolean {
  if (/(?:~~~~~?)/.test(text)) return true;
  if (!revTimestamp) {
    return /(?:\[\[User(?: talk)?:)/i.test(text);
  }

  const date =
    revTimestamp instanceof Date ? revTimestamp : new Date(revTimestamp);
  if (Number.isNaN(date.getTime())) {
    return /(?:\[\[User(?: talk)?:)/i.test(text);
  }

  const timePoints = [
    date,
    new Date(date.getTime() - 60000),
    new Date(date.getTime() + 60000),
  ];

  for (const t of timePoints) {
    const formatted = formatWikiTimestamp(t, format);
    if (formatted && text.includes(formatted)) return true;
  }

  for (const t of timePoints) {
    if (text.includes(formatWikiTimestamp(t, "zhwiki"))) return true;
    if (text.includes(formatWikiTimestamp(t, "publictestwiki"))) return true;
  }

  return false;
}

/**
 * 将维基时间戳文本或日期转换为 12 位紧凑数字格式（YYYYMMDDHHmm，如 "202601231123"）
 */
export function compactWikiTimestamp(
  timestampText?: string,
  defaultDate?: Date | string | number,
): string {
  if (timestampText) {
    const trimmed = timestampText.trim();

    // 1. 中文维基格式：2026年9月14日 (一) 01:23 (UTC)
    const zhMatch = trimmed.match(
      /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日[^\d]*(\d{1,2}):(\d{2})/,
    );
    if (zhMatch) {
      const y = zhMatch[1];
      const m = zhMatch[2].padStart(2, "0");
      const d = zhMatch[3].padStart(2, "0");
      const hh = zhMatch[4].padStart(2, "0");
      const mm = zhMatch[5].padStart(2, "0");
      return `${y}${m}${d}${hh}${mm}`;
    }

    // 2. 英文维基/publictestwiki格式：14:14, 7 June 2026 (UTC)
    const enMatch = trimmed.match(
      /(\d{1,2}):(\d{2}),\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/,
    );
    if (enMatch) {
      const hh = enMatch[1].padStart(2, "0");
      const mm = enMatch[2].padStart(2, "0");
      const d = enMatch[3].padStart(2, "0");
      const monthStr = enMatch[4];
      const y = enMatch[5];
      const mIdx = EN_MONTHS.findIndex(
        (mon) => mon.toLowerCase() === monthStr.toLowerCase(),
      );
      const m = String(mIdx !== -1 ? mIdx + 1 : 1).padStart(2, "0");
      return `${y}${m}${d}${hh}${mm}`;
    }

    // 3. ISO/标准日期格式：2026-09-14 01:23 或 2026-09-14T01:23:00Z
    const isoMatch = trimmed.match(
      /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/,
    );
    if (isoMatch) {
      return `${isoMatch[1]}${isoMatch[2]}${isoMatch[3]}${isoMatch[4]}${isoMatch[5]}`;
    }

    // 4. 尝试通过 Date 解析
    const parsedDate = new Date(trimmed);
    if (!Number.isNaN(parsedDate.getTime())) {
      const y = parsedDate.getUTCFullYear();
      const m = String(parsedDate.getUTCMonth() + 1).padStart(2, "0");
      const d = String(parsedDate.getUTCDate()).padStart(2, "0");
      const hh = String(parsedDate.getUTCHours()).padStart(2, "0");
      const mm = String(parsedDate.getUTCMinutes()).padStart(2, "0");
      return `${y}${m}${d}${hh}${mm}`;
    }
  }

  // 5. fallback 到 defaultDate
  if (defaultDate !== undefined) {
    const d = defaultDate instanceof Date ? defaultDate : new Date(defaultDate);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      return `${y}${m}${day}${hh}${mm}`;
    }
  }

  return "000000000000";
}

/**
 * 生成讨论留言的唯一消息 ID（格式："r-版本号-202601231123"）
 */
export function generateMessageId(
  revid?: number | string,
  timestampText?: string,
  defaultDate?: Date | string | number,
): string {
  const version =
    revid !== undefined && revid !== null && revid !== "" ? revid : 0;
  const compactTime = compactWikiTimestamp(timestampText, defaultDate);
  return `r-${version}-${compactTime}`;
}

/**
 * 结构化讨论留言数据模型
 */
export type StructuredComment = {
  /** 消息唯一 ID（格式：r-版本号-202601231123） */
  id: string;
  /** 发言用户名（如 "Alice"、"192.0.2.1" 或未知用户） */
  author: string;
  /** 发言时间戳文本（如 "2026年9月14日 (一) 01:23 (UTC)"） */
  timestamp?: string;
  /** 留言正文（已去除签名、时间戳、行首缩进冒号与机器人标记后的纯正文） */
  text: string;
  /** 缩进层级（0 为顶格，1 为单个冒号或星号等） */
  indentLevel: number;
  /** 原始文本片段 */
  rawText?: string;
};

/**
 * 维基用户链接提取正则（支持 User:, User talk:, 用户:, 用戶:, 使用者:, U:, UT:, Special:Contributions 等）
 */
export const USER_LINK_REGEX =
  /\[\[\s*(?:(?:User|User[ _]talk|U|UT|用户|用戶|使用者|用户讨论|用戶討論|使用者討論|用户对话|用戶對話)\s*:\s*([^|[\]#]+)|(?:Special|特别|特別|特殊)\s*:\s*(?:Contributions|Contribs|用户贡献|用戶貢獻|使用者貢獻|使用者贡献)\s*\/([^|[\]#]+))(?:\s*\|\s*[^[\]]*)?\]\]/i;

/**
 * 维基时间戳正则（支持中文维基、英文/publictestwiki、ISO等常见格式）
 */
export const WIKI_TIMESTAMP_REGEX =
  /(?:\d{4}年\d{1,2}月\d{1,2}日\s*(?:\([^\n)]+\))?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:\([A-Z]+\))?|\d{1,2}:\d{2}(?::\d{2})?,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}\s*(?:\([A-Z]+\))?|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?\s*(?:\([A-Z]+\))?)/;

/**
 * 未签名模板正则（如 {{unsigned|User|Time}}、{{未签名|User|Time}}）
 */
export const UNSIGNED_TEMPLATE_REGEX =
  /\{\{\s*(?:unsigned|unsigned-ip|unsignedIP|unsignedip|未签名|未簽名|Unsigned|Unsigned-IP)\s*\|\s*(?:1=)?([^|{}]+?)(?:\s*\|\s*(?:2=)?([^|{}]+?))?\s*\}\}/i;

/**
 * 解析单条留言文本为结构化对象（提取留言者、时间戳、缩进层级并去除签名噪声）
 */
export function parseStructuredComment(
  rawComment: string,
  options?: {
    defaultAuthor?: string;
    defaultTimestamp?: string;
    timestampFormat?: string;
    revid?: number | string;
  },
): StructuredComment {
  const rawText = rawComment;
  let text = rawComment;

  // 1. 提取缩进层级
  const indentLevel = getCommentIndentLevel(text);

  // 2. 移除机器人 source marker
  text = text.replace(/<!--\s*amanojaku-bot:[^>]*?-->/gi, "");

  let author: string | undefined = undefined;
  let timestamp: string | undefined = undefined;

  // 3. 检查未签名模板 {{unsigned|User|Time}} 或 {{未签名|User|Time}}
  const unsignedMatch = text.match(UNSIGNED_TEMPLATE_REGEX);
  if (unsignedMatch) {
    author = unsignedMatch[1].trim();
    if (unsignedMatch[2]) {
      timestamp = unsignedMatch[2].trim();
    }
    text = text.replace(unsignedMatch[0], "");
  }

  // 4. 检查标准维基签名（末尾的用户链接与时间戳）
  const timeMatches = [
    ...text.matchAll(new RegExp(WIKI_TIMESTAMP_REGEX.source, "gi")),
  ];

  if (timeMatches.length > 0) {
    const lastTimeMatch = timeMatches[timeMatches.length - 1];
    const timeIdx = lastTimeMatch.index!;
    const afterTime = text.slice(timeIdx + lastTimeMatch[0].length).trim();

    // 仅当时间戳位于文本末尾附近（允许尾随括号、空白或标点）时判定为签名时间戳
    if (afterTime.length < 20 && !afterTime.includes("\n")) {
      timestamp = lastTimeMatch[0].trim();
      const beforeTime = text.slice(0, timeIdx);

      // 从时间戳倒着往前查找碰到的第一个用户链接作为实际签名（支持正文提及他人，仅以末尾实际签名为准）
      const userMatches = [
        ...beforeTime.matchAll(new RegExp(USER_LINK_REGEX.source, "gi")),
      ];

      if (userMatches.length > 0) {
        const lastUserMatch = userMatches[userMatches.length - 1];
        const rawUser = (lastUserMatch[1] || lastUserMatch[2])
          .replace(/_/g, " ")
          .trim();
        if (!author) {
          author = rawUser;
        }

        // 向前查找同属该用户的连续签名链接（如 [[User:X]] ([[User talk:X]])）
        const normalizedAuthor = normalizeWikiUsername(rawUser).toLowerCase();
        let firstSigMatch = lastUserMatch;

        for (let i = userMatches.length - 2; i >= 0; i--) {
          const prevMatch = userMatches[i];
          const prevUser = normalizeWikiUsername(
            (prevMatch[1] || prevMatch[2]).replace(/_/g, " ").trim(),
          ).toLowerCase();

          // 若前一个链接同属该用户且两者之间无换行且距离较短（常见签名组合），则视为同一签名块
          if (
            prevUser === normalizedAuthor &&
            !beforeTime
              .slice(prevMatch.index!, firstSigMatch.index!)
              .includes("\n") &&
            firstSigMatch.index! - (prevMatch.index! + prevMatch[0].length) <
              100
          ) {
            firstSigMatch = prevMatch;
          } else {
            break;
          }
        }

        // 截取签名起始位置前的文本，并去除前导破折号、样式前缀标签或空白
        const sigStartIndex = firstSigMatch.index!;
        const beforeSig = beforeTime.slice(0, sigStartIndex);
        const sigPrefixMatch = beforeSig.match(
          /(?:<[a-zA-Z][^>]*>|<!--[\s\S]*?-->|[:\s\-—–－~（(])+\s*$/,
        );
        const cutIdx = sigPrefixMatch ? sigPrefixMatch.index! : sigStartIndex;
        text = beforeTime.slice(0, cutIdx);
      } else {
        // 无用户链接前缀，仅移除时间戳及其前面的破折号/空白
        const trailingDashMatch = beforeTime.match(/[:\s\-—–－]+$/);
        const cutIdx = trailingDashMatch ? trailingDashMatch.index! : timeIdx;
        text = beforeTime.slice(0, cutIdx);
      }
    }
  } else {
    // 检查末尾波浪线签名（~~~ 或 ~~~~ 或 ~~~~~）
    const tildeMatch = text.match(/(?:[:\s\-—–－]+)?~{3,5}\s*$/);
    if (tildeMatch && tildeMatch.index !== undefined) {
      text = text.slice(0, tildeMatch.index);
    }
  }

  // 5. 移除每行开头的缩进冒号 (:) 及星号 (*) / 井号 (#)，但保留多行内容标签（如 syntaxhighlight/pre/math）内部代码缩进
  const rawLines = text.split("\n");
  const cleanedLines: string[] = [];
  let currentTag: string | null = null;

  for (const line of rawLines) {
    const isInsideAtStart = currentTag !== null;
    let processedLine = line;

    if (!isInsideAtStart) {
      processedLine = line.replace(/^[:*#]+ */, "");
    } else if (
      /^[:*#]+ *(?=<\/\s*(?:math|chem|ce|pre|syntaxhighlight|source|score|nowiki|timeline|graph|maplink|mapframe|hiero)\b)/i.test(
        line,
      )
    ) {
      processedLine = line.replace(/^[:*#]+ */, "");
    }

    const { openTagAtEnd } = getLineTagInfo(processedLine, currentTag);
    currentTag = openTagAtEnd;
    cleanedLines.push(processedLine);
  }

  // 去除末尾空行或残存符号
  while (
    cleanedLines.length > 0 &&
    (cleanedLines[cleanedLines.length - 1].trim() === "" ||
      /^[:\s\-—–－]+$/.test(cleanedLines[cleanedLines.length - 1]))
  ) {
    cleanedLines.pop();
  }

  if (cleanedLines.length > 0) {
    cleanedLines[cleanedLines.length - 1] = cleanedLines[
      cleanedLines.length - 1
    ]
      .replace(/[:\s\-—–－]+$/, "")
      .trimEnd();
  }

  const cleanBody = cleanedLines.join("\n").trim();
  const authorFinal = author || options?.defaultAuthor || "未知用户";
  const timestampFinal = timestamp || options?.defaultTimestamp;
  const id = generateMessageId(
    options?.revid,
    timestampFinal,
    options?.defaultTimestamp,
  );

  return {
    id,
    author: authorFinal,
    timestamp: timestampFinal,
    text: cleanBody,
    indentLevel,
    rawText,
  };
}

/**
 * 判断单行文本是否包含位于行末的带时间戳维基签名（或未签名模板、~~~~），作为单条留言的结束分割线
 *
 * 判定规则：同一行内有用户页/讨论页/贡献页链接及时间戳，且时间戳位于该行末尾；或行末为 ~~~~ / {{unsigned|...}}。
 */
export function hasEndSignature(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // 1. 未展开的波浪线签名（如 ~~~~、~~~~~、--~~~~）位于行末
  if (/(?:[:\s\-—–－]+)?~{3,5}(?:\s*<!--.*?-->)*\s*$/i.test(trimmed)) {
    return true;
  }

  // 2. 未签名模板（如 {{unsigned|...}}、{{未签名|...}}）位于行末
  if (
    /\{\{\s*(?:unsigned|unsigned-ip|unsignedIP|unsignedip|未签名|未簽名|Unsigned|Unsigned-IP)\s*\|[^}]+?\}\}(?:\s*<!--.*?-->)*\s*$/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  // 3. 检查同一行内是否包含用户页/讨论页/贡献页链接
  if (!USER_LINK_REGEX.test(trimmed)) {
    return false;
  }

  // 4. 检查同一行内是否存在时间戳，且时间戳位于该行末尾
  const timeMatches = [
    ...trimmed.matchAll(new RegExp(WIKI_TIMESTAMP_REGEX.source, "gi")),
  ];
  if (timeMatches.length === 0) {
    return false;
  }

  const lastTimeMatch = timeMatches[timeMatches.length - 1];
  const timeEndIndex = lastTimeMatch.index! + lastTimeMatch[0].length;
  const afterTime = trimmed.slice(timeEndIndex);

  // 过滤掉 HTML 注释后检查时间戳后面是否只有空白或尾随括号/标点
  const afterTimeWithoutComments = afterTime.replace(/<!--.*?-->/g, "").trim();
  return (
    afterTimeWithoutComments.length === 0 ||
    /^[\s()（）\]］.,，。—–-]+$/.test(afterTimeWithoutComments)
  );
}

/**
 * 判断单行文本是否包含签名或时间戳标记（向后兼容接口）
 */
export const hasSignatureOrTimestamp = hasEndSignature;

/**
 * 将维基讨论章节（或整段讨论上下文）按带时间戳签名拆分为结构化留言列表
 *
 * 核心逻辑：以带时间戳签名（同一行内有用户页/讨论页/贡献页及时间戳，且时间戳位于该行末尾）为分割线，不能以缩进为分割线。
 */
export function parseDiscussionThread(
  wikitext: string,
  options?: {
    defaultAuthor?: string;
    defaultTimestamp?: string;
    timestampFormat?: string;
    revid?: number | string;
  },
): StructuredComment[] {
  if (!wikitext || !wikitext.trim()) return [];

  const lines = wikitext.split("\n");
  const commentChunks: string[] = [];
  let currentLines: string[] = [];
  let currentTag: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 跳过纯二级或更高级别标题行（== 讨论标题 ==）
    if (
      /^==+\s*([^=].*?)\s*==+/.test(line.trim()) &&
      currentLines.length === 0
    ) {
      continue;
    }

    // 处理多行代码/数学公式标签
    const { isInsideTagAtStart, openTagAtEnd } = getLineTagInfo(
      line,
      currentTag,
    );
    currentTag = openTagAtEnd;

    if (isInsideTagAtStart || currentTag !== null) {
      currentLines.push(line);
      continue;
    }

    // 检查 Outdent 重置模板
    if (/^\{\{\s*(?:outdent|od)\b/i.test(line.trim())) {
      if (
        currentLines.length > 0 &&
        currentLines.some((l) => l.trim().length > 0)
      ) {
        commentChunks.push(currentLines.join("\n"));
        currentLines = [];
      }
      continue;
    }

    currentLines.push(line);

    // 仅以带时间戳签名（同一行内有用户/讨论/贡献页及时间戳，且时间戳位于该行末尾；或包含未签名模板/~~~~）为分割线
    if (hasEndSignature(line)) {
      commentChunks.push(currentLines.join("\n"));
      currentLines = [];
    }
  }

  if (
    currentLines.length > 0 &&
    currentLines.some((l) => l.trim().length > 0)
  ) {
    commentChunks.push(currentLines.join("\n"));
  }

  const structuredList: StructuredComment[] = [];
  for (const chunk of commentChunks) {
    const parsed = parseStructuredComment(chunk, options);
    if (parsed.text.length > 0) {
      structuredList.push(parsed);
    }
  }

  return structuredList;
}

/**
 * 结构化讨论留言（供 LLM 消费与外部输出，不包含 rawText 以防幻觉）
 */
export type CleanStructuredComment = {
  id: string;
  author: string;
  timestamp?: string;
  text: string;
  indentLevel: number;
};

/**
 * 结构化讨论章节/话题节点（支持多级标题嵌套，如一/二/三/四等标题分层）
 */
export type StructuredDiscussionSection = {
  /** 标题层级（例如 1 为一级标题，2 为二级标题，3 为三级标题，4 为四级标题等；0 为页面开头的导言/无标题区） */
  level: number;
  /** 章节标题文本 */
  title: string;
  /** 该章节下的留言列表及嵌套子章节 */
  messages: Array<CleanStructuredComment | StructuredDiscussionSection>;
};

const SECTION_HEADING_REGEX =
  /^(={1,6})\s*([^=].*?)\s*\1(?:\s*<!--[\s\S]*?-->)*\s*$/;

/**
 * 检查文本是否包含讨论留言特征（包含用户/用户讨论/用户贡献链接，且包含时间戳）
 */
export function hasDiscussionComments(wikitext: string): boolean {
  if (!wikitext) return false;
  return (
    (USER_LINK_REGEX.test(wikitext) ||
      UNSIGNED_TEMPLATE_REGEX.test(wikitext)) &&
    (WIKI_TIMESTAMP_REGEX.test(wikitext) ||
      UNSIGNED_TEMPLATE_REGEX.test(wikitext))
  );
}

/**
 * 解析页面全部讨论内容，按照一/二/三/四等各级标题进行树状分层，
 * 并提取每个章节下的结构化留言列表（发言人、时间戳、留言正文、缩进层级等，不含 rawText）。
 */
export function parseStructuredDiscussionPage(
  wikitext: string,
  options?: {
    defaultAuthor?: string;
    defaultTimestamp?: string;
    timestampFormat?: string;
    revid?: number | string;
  },
): StructuredDiscussionSection[] {
  if (!wikitext || !wikitext.trim()) return [];

  const lines = wikitext.split("\n");
  const rawSections: { level: number; title: string; lines: string[] }[] = [];
  let currentSection = {
    level: 0,
    title: "",
    lines: [] as string[],
  };
  let currentTag: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { isInsideTagAtStart, openTagAtEnd } = getLineTagInfo(
      line,
      currentTag,
    );
    currentTag = openTagAtEnd;

    if (!isInsideTagAtStart && currentTag === null) {
      const headingMatch = line.match(SECTION_HEADING_REGEX);
      if (headingMatch) {
        const headingLevel = headingMatch[1].length;
        const headingTitle = headingMatch[2]
          .replace(/<!--[\s\S]*?-->/g, "")
          .trim();
        if (headingTitle.length > 0) {
          if (
            currentSection.level > 0 ||
            currentSection.lines.some((l) => l.trim().length > 0)
          ) {
            rawSections.push(currentSection);
          }
          currentSection = {
            level: headingLevel,
            title: headingTitle,
            lines: [],
          };
          continue;
        }
      }
    }

    currentSection.lines.push(line);
  }

  if (
    currentSection.level > 0 ||
    currentSection.lines.some((l) => l.trim().length > 0)
  ) {
    rawSections.push(currentSection);
  }

  const rootSections: StructuredDiscussionSection[] = [];
  const stack: StructuredDiscussionSection[] = [];

  for (const raw of rawSections) {
    const sectionText = raw.lines.join("\n");
    const rawComments = parseDiscussionThread(sectionText, options);

    // 剔除 rawText，仅保留 id, author, timestamp, text, indentLevel
    const comments: CleanStructuredComment[] = rawComments.map((c) => ({
      id: c.id,
      author: c.author,
      timestamp: c.timestamp,
      text: c.text,
      indentLevel: c.indentLevel,
    }));

    // 页面导言区（无标题区，level 0）
    if (raw.level === 0) {
      if (comments.length > 0) {
        const leadSection: StructuredDiscussionSection = {
          level: 0,
          title: "",
          messages: comments,
        };
        rootSections.push(leadSection);
      }
      continue;
    }

    const sectionNode: StructuredDiscussionSection = {
      level: raw.level,
      title: raw.title,
      messages: [...comments],
    };

    // 弹出栈中层级大于或等于当前 sectionNode 层级的节点
    while (
      stack.length > 0 &&
      stack[stack.length - 1].level >= sectionNode.level
    ) {
      stack.pop();
    }

    if (stack.length === 0) {
      rootSections.push(sectionNode);
    } else {
      stack[stack.length - 1].messages.push(sectionNode);
    }

    stack.push(sectionNode);
  }

  return rootSections;
}

/**
 * 维基页面二级标题章节结构
 */
export type SectionInfo = {
  title: string;
  header: string;
  content: string;
  index: number;
  startIndex: number;
  endIndex: number;
};

/**
 * 解析页面 wikitext 的二级标题章节
 */
export function parseSections(wikitext: string): SectionInfo[] {
  const sectionHeaderRegex = /^==\s*([^=].*?)\s*==\s*$/gm;
  const sections: SectionInfo[] = [];
  const matches = [...wikitext.matchAll(sectionHeaderRegex)];

  if (matches.length === 0) {
    return [
      {
        title: "",
        header: "",
        content: wikitext,
        index: 0,
        startIndex: 0,
        endIndex: wikitext.length,
      },
    ];
  }

  const firstMatch = matches[0];
  if (firstMatch.index! > 0) {
    sections.push({
      title: "",
      header: "",
      content: wikitext.slice(0, firstMatch.index),
      index: 0,
      startIndex: 0,
      endIndex: firstMatch.index!,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const startIndex = match.index!;
    const nextMatch = matches[i + 1];
    const endIndex = nextMatch ? nextMatch.index! : wikitext.length;
    const header = match[0];
    const title = match[1].trim();
    const content = wikitext.slice(startIndex, endIndex);

    sections.push({
      title,
      header,
      content,
      index: sections.length,
      startIndex,
      endIndex,
    });
  }

  return sections;
}

/**
 * 从页面章节列表中精准定位目标章节（避免当页面存在多个同名二级标题时误匹配到首个章节）
 */
export function findMatchingSection(
  sections: SectionInfo[],
  target: { title?: string; index?: number; content?: string },
  comment?: string,
  templateName?: string,
): SectionInfo | undefined {
  const normTitle = target.title?.trim().toLowerCase() ?? "";

  // 1. 如果指定了 comment，优先查找内容包含该 comment 的章节
  if (comment) {
    const trimmedComment = comment.trim();
    if (trimmedComment) {
      // 优先在同名章节中查找包含 comment 的章节
      if (normTitle) {
        const inTitleMatch = sections.find(
          (s) =>
            s.title.trim().toLowerCase() === normTitle &&
            s.content.includes(trimmedComment),
        );
        if (inTitleMatch) return inTitleMatch;
      }

      // 在所有章节中查找包含 comment 的章节
      const anyMatch = sections.find((s) => s.content.includes(trimmedComment));
      if (anyMatch) return anyMatch;

      // 如果 comment 包含多行，尝试匹配第一行
      const firstLine = trimmedComment.split("\n")[0]?.trim();
      if (firstLine && firstLine.length > 5) {
        if (normTitle) {
          const lineMatchInTitle = sections.find(
            (s) =>
              s.title.trim().toLowerCase() === normTitle &&
              s.content.includes(firstLine),
          );
          if (lineMatchInTitle) return lineMatchInTitle;
        }
        const lineMatchAny = sections.find((s) =>
          s.content.includes(firstLine),
        );
        if (lineMatchAny) return lineMatchAny;
      }
    }
  }

  // 2. 如果指定了 templateName，查找同名章节中未处理的模板（status 不为 done/not done）
  if (templateName && normTitle) {
    const titleMatches = sections.filter(
      (s) => s.title.trim().toLowerCase() === normTitle,
    );
    if (titleMatches.length > 0) {
      const unprocessed = titleMatches.find((s) => {
        const tpls = parseWikiTemplates(s.content, templateName);
        if (tpls.length === 0) return false;
        const status = (tpls[0].params.status ?? "").trim().toLowerCase();
        return status !== "done" && status !== "not done";
      });
      if (unprocessed) return unprocessed;
    }
  }

  // 3. 检查特定 index 处的章节标题是否匹配
  if (
    typeof target.index === "number" &&
    target.index >= 0 &&
    target.index < sections.length
  ) {
    const secAtIndex = sections[target.index];
    if (!normTitle || secAtIndex.title.trim().toLowerCase() === normTitle) {
      return secAtIndex;
    }
  }

  // 4. 在同名章节中进行选择
  if (normTitle) {
    const titleMatches = sections.filter(
      (s) => s.title.trim().toLowerCase() === normTitle,
    );
    if (titleMatches.length === 1) {
      return titleMatches[0];
    }
    if (titleMatches.length > 1) {
      if (typeof target.index === "number") {
        let closest = titleMatches[0];
        let minDiff = Math.abs(closest.index - target.index);
        for (const s of titleMatches) {
          const diff = Math.abs(s.index - target.index);
          if (diff < minDiff) {
            minDiff = diff;
            closest = s;
          }
        }
        return closest;
      }
      return titleMatches[titleMatches.length - 1];
    }
  }

  return undefined;
}

/**
 * 留言提取结果详情
 */
export type CommentExtractionResult = {
  /** 提取到的新留言纯文本 */
  comment: string;
  /** 新留言所在的二级标题名称（不含 ==），若在导言区或无标题则为空字符串 */
  sectionTitle: string;
  /** 新留言所在二级标题的完整头部（如 "== 讨论标题 =="） */
  sectionHeader: string;
  /** 该二级标题下的完整讨论内容（供 LLM 结合上下文理解多人会话） */
  sectionFullText: string;
  /** 所在章节索引序号 */
  sectionIndex: number;
};

/**
 * 讨论页留言提取器
 *
 * 核心维基语义与业务规则：
 * 1. 支持在讨论页中间插话、追加或新建章节，不假定新留言只在页面末尾。
 * 2. 精准识别新留言：通过 diffLines 提取新增内容，并校验是否包含与修订时间匹配的时间戳（或标准维基签名语法），
 *    有效排除单纯修改历史错别字、讨论页归档、移动章节等非新留言行为。
 * 3. 提取所在二级标题上下文，用于后续多用户会话理解与就地精准回复。
 * 4. 篇幅安全截断：单次追加长度限制在 4000 字符内，防止超长文本或恶意刷屏。
 * 5. 排除模板与注释：纯模板插入（{{...}}）或隐藏注释（<!--...-->）变更不视作人工对话。
 */
export function extractCommentDetails(
  before: string,
  after: string,
  revTimestamp?: string | Date,
  format = "zhwiki",
): CommentExtractionResult | null {
  let addedText: string;

  if (after.startsWith(before) && after.length > before.length) {
    addedText = after.slice(before.length).trim();
  } else {
    const normBefore =
      before.length > 0 && !before.endsWith("\n") ? `${before}\n` : before;
    const normAfter =
      after.length > 0 && !after.endsWith("\n") ? `${after}\n` : after;
    const diffs = diffLines(normBefore, normAfter);
    const addedParts = diffs.filter((p) => p.added);
    if (addedParts.length === 0) return null;
    addedText = addedParts
      .map((p) => p.value)
      .join("\n")
      .trim();
  }

  if (!addedText || addedText.length > 4000) return null;

  // 纯模板或纯隐藏注释排除
  if (/^\{\{|^<!--/.test(addedText) && !/(?:~~~~|\[\[User)/i.test(addedText)) {
    return null;
  }

  // 校验时间戳或签名语法：
  // 若提供了 revTimestamp，则强制要求时间戳与修订时间一致（或含有未展开签名 ~~~~）；
  // 未提供 revTimestamp 时（如单测或未获取到元数据），回退为检查是否包含标准维基签名语法。
  if (revTimestamp) {
    if (!containsMatchingTimestamp(addedText, revTimestamp, format)) {
      return null;
    }
  } else if (!/(?:~~~~|\[\[User(?: talk)?:)/i.test(addedText)) {
    return null;
  }

  // 解析并定位所属二级标题章节
  const sections = parseSections(after);
  let targetSection = sections.find((s) => s.content.includes(addedText));
  if (!targetSection && sections.length > 0) {
    const firstLine = addedText.split("\n")[0].trim();
    targetSection = sections.find((s) => s.content.includes(firstLine));
  }
  if (!targetSection && sections.length > 0) {
    targetSection = sections[sections.length - 1];
  }

  return {
    comment: addedText,
    sectionTitle: targetSection?.title ?? "",
    sectionHeader: targetSection?.header ?? "",
    sectionFullText: targetSection?.content.trim() ?? after.trim(),
    sectionIndex: targetSection?.index ?? 0,
  };
}

/**
 * 保守型讨论留言提取器（向后兼容接口）
 */
export function addedComment(
  before: string,
  after: string,
  revTimestamp?: string | Date,
  format?: string,
): string | null {
  return (
    extractCommentDetails(before, after, revTimestamp, format)?.comment ?? null
  );
}

/**
 * 识别留言文本开头的维基缩进等级（以冒号 `:` 数量计量）
 */
export function getCommentIndentLevel(comment: string): number {
  const trimmed = comment.trimStart();
  const firstLine = trimmed.split("\n")[0] ?? "";
  const match = firstLine.match(/^:+/);
  return match ? match[0].length : 0;
}

const MULTILINE_CONTENT_TAG_REGEX =
  /<\s*(\/)?\s*(math|chem|ce|pre|syntaxhighlight|source|score|nowiki|timeline|graph|maplink|mapframe|hiero)\b([^>]*?)(\/)?\s*>/gi;

/**
 * 分析单行文本中多行内容标签（如 math, pre, syntaxhighlight 等）的开启与闭合状态
 */
function getLineTagInfo(
  line: string,
  currentOpenTag: string | null,
): { isInsideTagAtStart: boolean; openTagAtEnd: string | null } {
  const isInsideTagAtStart = currentOpenTag !== null;
  let activeTag = currentOpenTag;

  MULTILINE_CONTENT_TAG_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MULTILINE_CONTENT_TAG_REGEX.exec(line)) !== null) {
    const isClosing = Boolean(match[1]);
    const tagName = match[2].toLowerCase();
    const isSelfClosing = Boolean(match[4]) || match[3].trimEnd().endsWith("/");

    if (activeTag === null) {
      if (!isClosing && !isSelfClosing) {
        activeTag = tagName;
      }
    } else {
      if (isClosing && tagName === activeTag) {
        activeTag = null;
      }
    }
  }

  return { isInsideTagAtStart, openTagAtEnd: activeTag };
}

/**
 * 格式化机器人讨论页回复：
 * 1. 清理 AI 生成的签名（波浪线 ~~~/~~~~ 及前导破折号、冒号；若指定了 botUsername，则仅清理带有机器人自身用户名的显式签名，保留提及其他用户的链接）
 * 2. 清理 AI 自己生成的缩进（每行开头的冒号 `:`）
 * 3. 按照现有逻辑加缩进：上一条留言缩进等级 +1；若新等级超过 8，则使用 {{Outdent|8}} 将缩进重置为 0
 * 4. 对于 <math><pre><syntaxhighlight><source><score> 等多行内容标签，其内部各行开头不添加冒号
 */
export function formatDiscussionReply(
  reply: string,
  currentIndentLevel: number,
  marker: string,
  botUsername?: string,
): string {
  // 1. 清理 AI 生成的签名及残留破折号、波浪线、时间戳等
  let cleanReply = reply
    // 移除 ~~~ 到 ~~~~~ 及其前面可能附带的破折号、冒号、空格
    .replace(/(?:[:\s\-—–]+)?~{3,5}/g, "");

  // 移除显式维基用户名与时间戳签名及其前导符号（仅在未指定 botUsername 时清理所有，或者在指定 botUsername 时仅清理机器人自身的签名）
  const userNsPattern =
    "(?:User|User[ _]talk|U|UT|用户|用戶|使用者|用户讨论|用戶討論|使用者討論|Special|特别|特別)";
  const timePattern =
    "(?:\\d{4}年\\d{1,2}月\\d{1,2}日\\s*(?:\\([^\\n)]+\\))?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:\\([A-Z]+\\))?|\\d{1,2}:\\d{2}(?::\\d{2})?,\\s*\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4}\\s*(?:\\([A-Z]+\\))?|\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(?::\\d{2})?\\s*(?:\\([A-Z]+\\))?)";

  if (botUsername) {
    const escapedBot = botUsername
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll(" ", "[ _]");
    const botSigRegex = new RegExp(
      `(?:[:\\s\\-—–－]+)?\\[\\[${userNsPattern}:${escapedBot}(?:\\|[^\\]]*)?\\]\\][^\n]*?${timePattern}`,
      "gi",
    );
    cleanReply = cleanReply.replace(botSigRegex, "");
  } else {
    const anySigRegex = new RegExp(
      `(?:[:\\s\\-—–]+)?\\[\\[${userNsPattern}:[^\\]]+?\\]\\][^\\n]*?${timePattern}`,
      "gi",
    );
    cleanReply = cleanReply.replace(anySigRegex, "");
  }

  // 移除末尾残留的冒号、破折号、连字符及空白
  cleanReply = cleanReply.replace(/[:\s\-—–]+$/, "").trim();

  // 2. 清理 AI 自己生成的缩进（每行开头的 :），跳过多行内容标签内部代码
  const rawLines = cleanReply.split("\n");
  const cleanedLines: string[] = [];
  let currentTag: string | null = null;

  for (const line of rawLines) {
    const isInsideAtStart = currentTag !== null;
    let processedLine = line;

    if (!isInsideAtStart) {
      processedLine = line.replace(/^:+ */, "");
    } else if (
      /^:+ *(?=<\/\s*(?:math|chem|ce|pre|syntaxhighlight|source|score|nowiki|timeline|graph|maplink|mapframe|hiero)\b)/i.test(
        line,
      )
    ) {
      processedLine = line.replace(/^:+ */, "");
    }

    const { openTagAtEnd } = getLineTagInfo(processedLine, currentTag);
    currentTag = openTagAtEnd;
    cleanedLines.push(processedLine);
  }

  // 去除末尾空行或仅含冒号/破折号的无效末行
  while (
    cleanedLines.length > 0 &&
    (cleanedLines[cleanedLines.length - 1].trim() === "" ||
      /^[:\s\-—–]+$/.test(cleanedLines[cleanedLines.length - 1]))
  ) {
    cleanedLines.pop();
  }

  if (cleanedLines.length > 0) {
    cleanedLines[cleanedLines.length - 1] = cleanedLines[
      cleanedLines.length - 1
    ]
      .replace(/[:\s\-—–]+$/, "")
      .trimEnd();
  }

  const suffix = marker ? ` ~~~~ ${marker}` : " ~~~~";
  const nextLevel = currentIndentLevel + 1;

  // 3. 缩进等级超过 8 则使用 Outdent 重置为 0
  if (nextLevel > 8) {
    const body = cleanedLines.join("\n");
    return `{{Outdent|${currentIndentLevel}}}\n${body}${suffix}`;
  }

  // 3 & 4. 添加冒号缩进，多行内容标签内部各行保持原样不加冒号
  const indents = ":".repeat(nextLevel);
  const indentedLines: string[] = [];
  currentTag = null;

  for (const line of cleanedLines) {
    const { isInsideTagAtStart, openTagAtEnd } = getLineTagInfo(
      line,
      currentTag,
    );
    currentTag = openTagAtEnd;

    if (isInsideTagAtStart) {
      indentedLines.push(line);
    } else {
      indentedLines.push(`${indents}${line}`);
    }
  }

  const body = indentedLines.join("\n");
  return `${body}${suffix}`;
}

/**
 * 将机器人回复安全插入到讨论页中：
 * 1. 优先定位目标留言（targetComment），紧跟在其下一行插入回复。
 * 2. 若未提供 targetComment 或定位失败，则插入到指定二级标题章节的末尾。
 * 3. 若未找到指定章节或章节为空，则回退为追加至页面末尾。
 */
export function insertReplyIntoContent(
  content: string,
  replyWikitext: string,
  sectionTitle?: string,
  targetComment?: string,
): string {
  if (targetComment) {
    const trimmedTarget = targetComment.trim();
    let pos = content.indexOf(targetComment);
    let matchLen = targetComment.length;
    if (pos === -1 && trimmedTarget) {
      pos = content.indexOf(trimmedTarget);
      matchLen = trimmedTarget.length;
    }
    if (pos === -1 && trimmedTarget) {
      const firstLine = trimmedTarget.split("\n")[0].trim();
      if (firstLine.length > 5) {
        pos = content.indexOf(firstLine);
        matchLen = firstLine.length;
      }
    }
    if (pos !== -1) {
      const before = content.slice(0, pos + matchLen);
      const after = content.slice(pos + matchLen);
      if (after.startsWith("\r\n")) {
        return `${before}\r\n${replyWikitext}${after}`;
      }
      if (after.startsWith("\n")) {
        return `${before}\n${replyWikitext}${after}`;
      }
      return `${before}\n${replyWikitext}\n${after.trimStart()}`;
    }
  }

  if (!sectionTitle) {
    return `${content.trimEnd()}\n\n${replyWikitext}\n`;
  }
  const sections = parseSections(content);
  const target = sections.find(
    (s) => s.title.toLowerCase() === sectionTitle.toLowerCase(),
  );
  if (!target || !target.header) {
    return `${content.trimEnd()}\n\n${replyWikitext}\n`;
  }

  const beforeTarget = content.slice(0, target.startIndex);
  const sectionBody = target.content.trimEnd();
  const afterTarget = content.slice(target.endIndex);

  const updatedSection = `${sectionBody}\n${replyWikitext}\n`;
  if (afterTarget.length > 0) {
    return `${beforeTarget}${updatedSection}\n${afterTarget.trimStart()}`;
  }
  return `${beforeTarget}${updatedSection}`;
}

/**
 * 讨论页相关事件快速前置过滤器
 *
 * 过滤逻辑：
 * 1. 站点校验：若配置了 wikiId，仅匹配对应维基站点的变更事件。
 * 2. 命名空间与页面：仅监听命名空间 3（User talk:，用户讨论命名空间）且标题精确匹配机器人讨论页的普通编辑（type === "edit"）。
 * 3. 机器人与自循环防御：排除带有 `bot: true` 标记的编辑以及机器人自身的编辑操作，杜绝多机器人互扯死循环。
 * 4. 修订完整性：确保事件携带有效的 `revision.new` 修订号。
 */
export function isRelevant(
  e: {
    wiki?: string;
    type?: string;
    title?: string;
    namespace?: number;
    bot?: boolean;
    user?: string;
    revision?: { new?: number };
  },
  talkPage: string,
  bot: string,
  wikiId?: string,
  allowBotEdits?: boolean,
) {
  return (
    (!wikiId || e.wiki === wikiId) &&
    e.type === "edit" &&
    e.namespace === 3 &&
    e.title?.replaceAll("_", " ") === talkPage &&
    !(e.bot && !allowBotEdits) &&
    e.user !== bot &&
    !!e.revision?.new
  );
}

/**
 * 计算给定时间对应的 6 小时 UTC 聚合窗口起始时间（00:00、06:00、12:00、18:00 UTC）
 */
export function windowStart(at = new Date()) {
  const date = new Date(at);
  date.setUTCHours(Math.floor(date.getUTCHours() / 6) * 6, 0, 0, 0);
  return date.toISOString();
}

/**
 * 条目规范化标题（将“草稿:条目名”与主命名空间“条目名”归一化为同名实体，避免草稿与正文重复计数）
 */
export function canonicalTitle(title: string) {
  return title
    .replace(/^(?:Draft|草稿):/i, "")
    .replaceAll("_", " ")
    .trim();
}

/**
 * 对展示到维基页面的用户输入文本进行转义，防止破坏 Wikitext 语法、注入虚假签名或 HTML
 */
export function safeWikitext(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("~", "&#126;");
}

/**
 * 标准化用户名（首字母大写，下划线转空格，去除前后空白）
 */
export function normalizeWikiUsername(name: string): string {
  const trimmed = name.replaceAll("_", " ").trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * 标准化模板名称（去除前导冒号与命名空间前缀大小写差异，下划线转空格）
 */
export function normalizeTemplateName(name: string): string {
  let normalized = name.replace(/^:+/, "").replaceAll("_", " ").trim();
  if (normalized.toLowerCase().startsWith("template:")) {
    normalized = normalized.slice(9).trim();
  }
  return normalized;
}

/**
 * 解析后的维基模板结构
 */
export type ParsedWikiTemplate = {
  raw: string;
  templateName: string;
  params: Record<string, string>;
  startIndex: number;
  endIndex: number;
};

/**
 * 解析 Wikitext 中指定名称的维基模板
 *
 * 安全特性：
 * 1. 考虑嵌套模板 {{...}} 与内链 [[...]]，正确提取顶层参数。
 * 2. 忽略大小写与下划线差异匹配模板名称。
 * 3. 支持命名参数 (| key = value) 与位置参数 (| 1 = value)。
 */
export function parseWikiTemplates(
  wikitext: string,
  targetTemplateName?: string,
): ParsedWikiTemplate[] {
  const templates: ParsedWikiTemplate[] = [];
  const normalizedTarget = targetTemplateName
    ? normalizeTemplateName(targetTemplateName).toLowerCase()
    : null;

  let i = 0;
  while (i < wikitext.length - 1) {
    if (wikitext[i] === "{" && wikitext[i + 1] === "{") {
      const startIndex = i;
      let depth = 0;
      let inLink = 0;
      let j = i;

      while (j < wikitext.length) {
        if (wikitext[j] === "[" && wikitext[j + 1] === "[") {
          inLink++;
          j += 2;
          continue;
        }
        if (wikitext[j] === "]" && wikitext[j + 1] === "]") {
          if (inLink > 0) inLink--;
          j += 2;
          continue;
        }
        if (inLink === 0) {
          if (wikitext[j] === "{" && wikitext[j + 1] === "{") {
            depth++;
            j += 2;
            continue;
          }
          if (wikitext[j] === "}" && wikitext[j + 1] === "}") {
            depth--;
            j += 2;
            if (depth === 0) {
              const endIndex = j;
              const raw = wikitext.slice(startIndex, endIndex);
              const inner = raw.slice(2, -2).trim();

              // 解析模板名称与参数
              const parts: string[] = [];
              let currentPart = "";
              let innerDepth = 0;
              let innerLink = 0;

              for (let k = 0; k < inner.length; k++) {
                if (inner[k] === "[" && inner[k + 1] === "[") {
                  innerLink++;
                  currentPart += "[[";
                  k++;
                  continue;
                }
                if (inner[k] === "]" && inner[k + 1] === "]") {
                  if (innerLink > 0) innerLink--;
                  currentPart += "]]";
                  k++;
                  continue;
                }
                if (innerLink === 0) {
                  if (inner[k] === "{" && inner[k + 1] === "{") {
                    innerDepth++;
                    currentPart += "{{";
                    k++;
                    continue;
                  }
                  if (inner[k] === "}" && inner[k + 1] === "}") {
                    if (innerDepth > 0) innerDepth--;
                    currentPart += "}}";
                    k++;
                    continue;
                  }
                  if (innerDepth === 0 && inner[k] === "|") {
                    parts.push(currentPart);
                    currentPart = "";
                    continue;
                  }
                }
                currentPart += inner[k];
              }
              parts.push(currentPart);

              const templateName = parts[0]?.trim() ?? "";
              const params: Record<string, string> = {};
              let positionalIndex = 1;

              for (let p = 1; p < parts.length; p++) {
                const part = parts[p];
                const eqIdx = part.indexOf("=");
                if (eqIdx !== -1) {
                  const key = part.slice(0, eqIdx).trim();
                  const val = part.slice(eqIdx + 1).trim();
                  params[key] = val;
                } else {
                  params[String(positionalIndex)] = part.trim();
                  positionalIndex++;
                }
              }

              const normalizedName =
                normalizeTemplateName(templateName).toLowerCase();
              if (
                !normalizedTarget ||
                normalizedName === normalizedTarget ||
                normalizedName === `template:${normalizedTarget}` ||
                `template:${normalizedName}` === normalizedTarget
              ) {
                templates.push({
                  raw,
                  templateName,
                  params,
                  startIndex,
                  endIndex,
                });
              }

              i = endIndex;
              break;
            }
            continue;
          }
        }
        j++;
      }
      if (depth !== 0) {
        i += 2;
      }
    } else {
      i++;
    }
  }

  return templates;
}

/**
 * 在 Wikitext 中更新指定模板的参数并返回更新后的全文
 */
export function updateWikiTemplate(
  wikitext: string,
  targetTemplateName: string,
  updates: Record<string, string | undefined>,
): string {
  const templates = parseWikiTemplates(wikitext, targetTemplateName);
  if (templates.length === 0) return wikitext;

  // 针对找到的第一个模板实例进行参数更新
  const target = templates[0];
  let templateContent = target.raw;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;

    // 匹配既存的 | key = ... 参数
    const paramRegex = new RegExp(
      `(\\|\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=)([^|}\\n]*)`,
      "i",
    );

    if (paramRegex.test(templateContent)) {
      templateContent = templateContent.replace(
        paramRegex,
        `$1 ${value.trim()}`,
      );
    } else {
      // 若参数不存在，则在模板结尾 }} 前追加
      const closeIdx = templateContent.lastIndexOf("}}");
      if (closeIdx !== -1) {
        const isMultiline = templateContent.includes("\n");
        const insertion = isMultiline
          ? `| ${key} = ${value.trim()}\n`
          : ` | ${key} = ${value.trim()} `;
        templateContent = `${templateContent.slice(0, closeIdx)}${insertion}${templateContent.slice(closeIdx)}`;
      }
    }
  }

  return `${wikitext.slice(0, target.startIndex)}${templateContent}${wikitext.slice(target.endIndex)}`;
}

/**
 * 从 Wikitext 文本中提取所有签名用户名称
 */
export function extractSignatures(text: string): string[] {
  const users: string[] = [];
  const regex =
    /\[\[(?:User|User[ _]talk|U|UT|用户|用戶|使用者|用户讨论|用戶討論|使用者討論|Special:Contributions|特殊:Contributions|Special:用户贡献|Special:用戶貢獻|Special:使用者貢獻|特殊:用户贡献|特殊:用戶貢獻|特殊:使用者貢獻|Special:Contribs|特殊:Contribs):([^|\]#/]+)/gi;

  for (const match of text.matchAll(regex)) {
    const rawUser = match[1]?.trim();
    if (rawUser) {
      users.push(normalizeWikiUsername(rawUser));
    }
  }

  return [...new Set(users)];
}

/**
 * 校验签名用户列表中是否包含指定的修订作者
 */
export function isSignatureMatchingActor(
  signedUsers: string[],
  actorUsername: string,
): boolean {
  if (!signedUsers.length || !actorUsername) return false;
  const target = normalizeWikiUsername(actorUsername).toLowerCase();
  return signedUsers.some(
    (u) => normalizeWikiUsername(u).toLowerCase() === target,
  );
}

/**
 * 生成不重复的结果页章节标题
 */
export function generateUniqueSectionTitle(
  existingSectionTitles: string[],
  baseTitle: string,
): string {
  const existingSet = new Set(
    existingSectionTitles.map((t) => t.trim().toLowerCase()),
  );
  if (!existingSet.has(baseTitle.trim().toLowerCase())) {
    return baseTitle;
  }

  let counter = 2;
  while (existingSet.has(`${baseTitle} (${counter})`.toLowerCase())) {
    counter++;
  }
  return `${baseTitle} (${counter})`;
}
