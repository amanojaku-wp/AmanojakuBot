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
 * 将机器人回复安全插入到讨论页指定二级标题章节的末尾
 * 若未找到指定章节或章节为空，则回退为追加至页面末尾
 */
export function insertReplyIntoContent(
  content: string,
  replyWikitext: string,
  sectionTitle?: string,
): string {
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
) {
  return (
    (!wikiId || e.wiki === wikiId) &&
    e.type === "edit" &&
    e.namespace === 3 &&
    e.title?.replaceAll("_", " ") === talkPage &&
    !e.bot &&
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
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[[", "［［")
    .replaceAll("]]", "］］")
    .replaceAll("~~~~", "");
}
