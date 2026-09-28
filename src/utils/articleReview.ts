import { generateObject } from "ai";
import { z } from "zod";
import type { Logger } from "pino";
import { pageText } from "./wiki.js";
import {
  generateUniqueSectionTitle,
  parseSections,
  safeWikitext,
  splitWikitextIntoChunks,
  type ReviewChunk,
} from "./wikitext.js";
import {
  executeWithFallback,
  type LlmModelSpec,
  type TokenUsage,
} from "./llm.js";
import { replyNotDone, type RequestSectionRef } from "./requestWorkflow.js";
import type { HandlerContext } from "../handle.js";

/**
 * 「条目审核」通用能力
 *
 * 任务二（条目校对）、任务四（AfC 发布前评审）以及任务三 3-2（疑似 AI 分析）
 * 在处理一次「审阅某个条目固定版本」请求时，流程高度一致：
 *
 * 1. 每日配额检查（可选）；
 * 2. 解析请求中的条目名 → 拉取固定版本快照（存在性 / 命名空间 / 空内容校验）；
 * 3. 读取规则页并拆分为「通用 / 全局扫描 / 局部扫描」；
 * 4. LLM 审核：全文全局检查 →（可选）局部 Chunk 高覆盖扫描 → 确定性去重 → 语义合并；
 * 5. 推断结果页名称、写入结果页唯一日期章节；
 * 6. 就地回报请求章节（更新模板参数 + 回复提交人）并落库。
 *
 * 本模块把上述能力收敛为一组可组合的步骤与一个通用「两阶段审核引擎」，
 * 各任务只保留自己的 Schema、提示词、文案与结果渲染，避免多条链路的行为漂移。
 *
 * 说明：局部 Chunk 扫描由 `chunkEnabled` 开关控制。任务二始终启用；
 * 任务四在规则页声明「局部扫描 未启用」时关闭；任务三 3-2 当前不拆章节细查
 * （按条目单次判定、多条目汇总到同一结果页），保留该开关以便后续按需启用。
 */

// ---------------------------------------------------------------------------
// 1. 规则页拆分
// ---------------------------------------------------------------------------

/** 排除在局部 Chunk 扫描之外的条目尾部章节（不进入高覆盖扫描）。 */
export const SKIP_SECTIONS = new Set([
  "参见",
  "參見",
  "另见",
  "另見",
  "参考文献",
  "參考文獻",
  "参考资料",
  "參考資料",
  "外部链接",
  "外部鏈接",
  "外部連結",
  "附注",
  "注释",
  "注釋",
  "附註",
]);

/** 规则页按二级标题拆分出的三部分。 */
export type ExtractedRule = {
  common: string;
  global: string;
  chunk: string;
  unknown: Array<{
    title: string;
    content: string;
  }>;
};

/**
 * 将规则页按二级标题拆分为「通用要求 / 全局扫描要求 / 局部扫描要求」三部分。
 *
 * 只匹配二级标题（`== 标题 ==`），三级及以下标题保留在所属二级章节内。
 * 第一个二级标题之前的内容视为导言，归入 common。
 */
export function extractRule(rule: string): ExtractedRule {
  const common: string[] = [];
  const global: string[] = [];
  const chunk: string[] = [];
  const unknown: Array<{
    title: string;
    content: string;
  }> = [];

  const headingRegex = /^==[ \t]*([^=\n]+?)[ \t]*==[ \t]*$/gm;
  const matches = [...rule.matchAll(headingRegex)];

  const introEnd = matches[0]?.index ?? rule.length;
  const intro = rule.slice(0, introEnd).trim();
  if (intro) {
    common.push(intro);
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const title = match[1].trim();

    const start = match.index! + match[0].length;
    const end = matches[i + 1]?.index ?? rule.length;
    const section = rule.slice(start, end).trim();

    if (!section) {
      continue;
    }

    if (title.includes("通用")) {
      common.push(section);
    } else if (title.includes("全局扫描")) {
      global.push(section);
    } else if (title.includes("局部扫描")) {
      chunk.push(section);
    } else {
      unknown.push({ title, content: section });
    }
  }

  return {
    common: common.join("\n\n").trim(),
    global: global.join("\n\n").trim(),
    chunk: chunk.join("\n\n").trim(),
    unknown,
  };
}

/**
 * 读取规则页内容，失败或未配置时回退到内置规则。
 */
export async function loadRuleText(
  ctx: HandlerContext,
  options: { rulePage?: string; fallback: string; label: string },
): Promise<string> {
  const { bot, log } = ctx;
  const { rulePage, fallback, label } = options;

  if (!rulePage) return fallback;

  try {
    return await pageText(bot, rulePage);
  } catch (err) {
    log.warn(
      { err, rulePage },
      `${label} failed to load rulePage, using default rules`,
    );
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 2. 问题去重与语义合并（与具体问题 Schema 解耦）
// ---------------------------------------------------------------------------

/** 各任务问题对象的公共字段（用于去重与合并提示词）。 */
export type BaseReviewIssue = {
  category: string;
  title?: string | null;
  location?: string | null;
  originalText?: string | null;
  description?: string | null;
  suggestion?: string | null;
};

/** 附带来源 Chunk 溯源信息的问题。 */
export type LocatedIssue<T> = T & {
  chunkId?: string;
  chunkIds?: string[];
};

/** 参与语义合并的候选问题（稳定 ID + 问题本体）。 */
export type CandidateIssue<T> = {
  id: string;
  issue: T;
};

/** 一组语义重复：保留 keep，合并 duplicates。 */
export type MergeGroup = {
  keep: string;
  duplicates: string[];
};

/** 语义合并的 LLM 结构化输出 Schema（各任务共用）。 */
export const mergeDecisionSchema = z.object({
  groups: z.array(
    z.object({
      keep: z.string().describe("保留的 candidate ID，例如 i003"),
      duplicates: z
        .array(z.string())
        .describe("与 keep 实质上属于同一问题、应被合并的 candidate ID"),
    }),
  ),
});

/** 推断草稿预期正式条目名时使用的 Schema。 */
export const intendedNameSchema = z.object({
  name: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

/** 为问题列表分配稳定候选 ID（i001、i002……）。 */
export function assignCandidateIds<T>(issues: T[]): CandidateIssue<T>[] {
  return issues.map((issue, index) => ({
    id: `i${String(index + 1).padStart(3, "0")}`,
    issue,
  }));
}

/** 合并两个问题的 Chunk 溯源信息。 */
function mergeChunkIds<T>(
  target: LocatedIssue<T>,
  source: LocatedIssue<T>,
): void {
  const chunkIds = new Set<string>();
  if (target.chunkId) chunkIds.add(target.chunkId);
  for (const id of target.chunkIds ?? []) chunkIds.add(id);
  if (source.chunkId) chunkIds.add(source.chunkId);
  for (const id of source.chunkIds ?? []) chunkIds.add(id);
  target.chunkIds = [...chunkIds];
}

/**
 * 确定性去重：按调用方提供的 identity 键合并完全同质的问题，并累积 Chunk 溯源。
 */
export function deterministicDedupe<T>(
  issues: LocatedIssue<T>[],
  identity: (issue: T) => string,
): LocatedIssue<T>[] {
  const result: LocatedIssue<T>[] = [];
  const byKey = new Map<string, LocatedIssue<T>>();

  for (const issue of issues) {
    const key = identity(issue);
    const existing = byKey.get(key);

    if (!existing) {
      const copy: LocatedIssue<T> = {
        ...issue,
        chunkIds: [
          ...new Set([
            ...(issue.chunkIds ?? []),
            ...(issue.chunkId ? [issue.chunkId] : []),
          ]),
        ],
      };
      byKey.set(key, copy);
      result.push(copy);
      continue;
    }

    const chunkIds = new Set<string>(existing.chunkIds ?? []);
    if (existing.chunkId) chunkIds.add(existing.chunkId);
    if (issue.chunkId) chunkIds.add(issue.chunkId);
    for (const chunkId of issue.chunkIds ?? []) chunkIds.add(chunkId);
    existing.chunkIds = [...chunkIds];
  }

  return result;
}

/** 将候选问题渲染为合并提示词中的一段。 */
function formatCandidateForMerge<T>(
  candidate: CandidateIssue<LocatedIssue<T>>,
  mergeFields: (issue: T) => Record<string, string | null | undefined>,
): string {
  const fields = mergeFields(candidate.issue);
  return [
    `[${candidate.id}]`,
    ...Object.entries(fields).map(([key, value]) => `${key}=${value ?? ""}`),
  ].join("\n");
}

/**
 * 校验 LLM 返回的合并分组：丢弃非法 ID、已消费 ID 与空分组。
 */
export function validateMergeGroups<T>(
  candidates: CandidateIssue<T>[],
  groups: MergeGroup[],
): MergeGroup[] {
  const validIds = new Set(candidates.map((candidate) => candidate.id));
  const consumed = new Set<string>();
  const result: MergeGroup[] = [];

  for (const group of groups) {
    if (!validIds.has(group.keep)) continue;
    if (consumed.has(group.keep)) continue;

    const duplicates = [
      ...new Set(
        group.duplicates.filter(
          (id) => id !== group.keep && validIds.has(id) && !consumed.has(id),
        ),
      ),
    ];

    if (duplicates.length === 0) continue;

    result.push({ keep: group.keep, duplicates });
    consumed.add(group.keep);
    for (const id of duplicates) consumed.add(id);
  }

  return result;
}

/** 应用合并分组：删除重复项并把其 Chunk 溯源并入保留项。 */
export function applyMergeGroups<T>(
  candidates: CandidateIssue<LocatedIssue<T>>[],
  groups: MergeGroup[],
): LocatedIssue<T>[] {
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const removed = new Set<string>();

  for (const group of groups) {
    const keep = byId.get(group.keep);
    if (!keep) continue;

    for (const duplicateId of group.duplicates) {
      const duplicate = byId.get(duplicateId);
      if (!duplicate || duplicateId === group.keep) continue;
      mergeChunkIds(keep.issue, duplicate.issue);
      removed.add(duplicateId);
    }
  }

  return candidates
    .filter((candidate) => !removed.has(candidate.id))
    .map((candidate) => candidate.issue);
}

/**
 * 确定性去重 + LLM 语义合并的统一入口。
 *
 * 语义合并失败或候选不足时，回退为确定性去重结果。
 */
export async function dedupeAndMergeIssues<T extends BaseReviewIssue>(options: {
  models: LlmModelSpec[];
  log: Logger;
  label: string;
  usageTracker: TokenUsage;
  /** 语义合并的系统提示词 */
  systemPrompt: string;
  /** 合并候选说明（“以下是……”），与 <candidates> 一起构成合并提示词 */
  intro: string;
  issues: LocatedIssue<T>[];
  identity: (issue: T) => string;
  mergeFields: (issue: T) => Record<string, string | null | undefined>;
}): Promise<LocatedIssue<T>[]> {
  const {
    models,
    log,
    label,
    usageTracker,
    systemPrompt,
    intro,
    issues,
    identity,
    mergeFields,
  } = options;

  log.info(
    { rawIssueCount: issues.length },
    `starting ${label} issue deduplication...`,
  );

  const deterministic = deterministicDedupe(issues, identity);
  const candidates = assignCandidateIds(deterministic);

  if (candidates.length < 2) {
    return deterministic;
  }

  const mergePrompt = `
${intro}

<candidates>
${candidates.map((candidate) => formatCandidateForMerge(candidate, mergeFields)).join("\n\n")}
</candidates>
`.trim();

  log.info(
    { candidateCount: candidates.length, promptChars: mergePrompt.length },
    `starting ${label} semantic issue deduplication...`,
  );

  try {
    const mergePassOutput = await executeWithFallback(
      models,
      async (modelInstance) => {
        const res = await generateObject({
          model: modelInstance,
          schema: mergeDecisionSchema,
          system: systemPrompt,
          prompt: mergePrompt,
        });
        return { result: res.object, usage: res.usage };
      },
      usageTracker,
    );

    const validGroups = validateMergeGroups(
      candidates,
      mergePassOutput.result.groups,
    );
    const merged = applyMergeGroups(candidates, validGroups);

    log.info(
      {
        beforeMerge: candidates.length,
        afterMerge: merged.length,
        duplicateGroupCount: validGroups.length,
        mergeUsage: mergePassOutput.usage,
      },
      `${label} semantic merge completed`,
    );

    return merged;
  } catch (err) {
    log.warn(
      { err },
      `${label} semantic merge failed, falling back to deterministic deduplicated issues`,
    );
    return deterministic;
  }
}

/**
 * 推断 User 命名空间草稿的预期正式条目名称。
 */
export async function inferIntendedArticleName(
  models: LlmModelSpec[],
  article: string,
  content: string,
  usageTracker?: TokenUsage,
  log?: Logger,
): Promise<string> {
  const sampleContent = content.slice(0, 3000);

  try {
    const { result } = await executeWithFallback(
      models,
      async (modelInstance) => {
        const res = await generateObject({
          model: modelInstance,
          schema: intendedNameSchema,
          system:
            "你是一个维基百科条目标题推断助手。根据用户草稿页面标题、导言区和正文内容，判断该草稿预期对应的正式维基百科条目名称（无需命名空间前缀）。如果无法确定，请将 confidence 设为 low，并将 name 设为空字符串。",
          prompt: `草稿页面：${article}\n正文片段：\n${sampleContent}`,
        });
        return { result: res.object, usage: res.usage };
      },
      usageTracker,
    );

    if (
      result.confidence !== "low" &&
      result.name &&
      result.name.trim().length > 0 &&
      !result.name.toLowerCase().startsWith("user:")
    ) {
      const cleanName = result.name.replaceAll("_", " ").trim();
      log?.info(
        { article, inferred: cleanName, confidence: result.confidence },
        "inferred intended article title for user draft",
      );
      return cleanName;
    }
  } catch (err) {
    log?.warn(
      { err, article },
      "failed to infer intended article title via LLM",
    );
  }

  // 保守 fallback：去除 User:用户名/ 前缀
  const fallback = article
    .replace(/^User:[^/]+\/?/i, "")
    .replaceAll("_", " ")
    .trim();
  log?.info(
    { article, fallback },
    "fallback to conservative title for user draft",
  );
  return fallback || article;
}

// ---------------------------------------------------------------------------
// 3. 条目固定版本快照
// ---------------------------------------------------------------------------

/** 待审阅条目的固定版本快照。 */
export type ArticleSnapshot = {
  /** 请求中原始提供的页面名 */
  requested: string;
  /** 解析重定向/繁简转换后的实际标题 */
  title: string;
  /** 固定版本修订号 */
  revid: number;
  namespace: number;
  content: string;
};

/** 条目快照获取结果。 */
export type ArticleSnapshotOutcome =
  | { status: "ok"; snapshot: ArticleSnapshot }
  | { status: "page-missing" }
  | { status: "namespace"; ns: number }
  | { status: "empty"; title: string; revid: number }
  | { status: "no-revid" };

/**
 * 拉取条目固定版本快照并做存在性 / 命名空间 / 空内容校验。
 *
 * 请求中出现的条目名、以及 API 返回的标题与正文都属于不可信数据，
 * 这里只做确定性校验，不据此授予任何编辑权限。
 */
export async function fetchArticleSnapshot(
  ctx: HandlerContext,
  options: { article: string; allowedNamespaces: number[] },
): Promise<ArticleSnapshotOutcome> {
  const { bot, log } = ctx;
  const { article, allowedNamespaces } = options;

  const pageData = await bot.request({
    action: "query",
    titles: article,
    prop: "revisions",
    rvprop: "ids|content",
    rvslots: "main",
    redirects: 1,
    converttitles: 1,
    formatversion: 2,
  });

  const page = pageData.query?.pages?.[0];

  if (!page || page.missing) {
    log.info({ article }, "target page does not exist");
    return { status: "page-missing" };
  }

  if (!allowedNamespaces.includes(page.ns)) {
    log.info(
      { article, ns: page.ns, allowedNamespaces },
      "page in disallowed namespace",
    );
    return { status: "namespace", ns: page.ns };
  }

  const title = page.title as string;
  const revid = page.revisions?.[0]?.revid as number | undefined;
  const content =
    (page.revisions?.[0]?.slots?.main?.content as string | undefined) ??
    (page.revisions?.[0]?.content as string | undefined) ??
    "";

  if (!revid) {
    log.error({ article, revid }, "failed to read revision id for target page");
    return { status: "no-revid" };
  }

  // 空白内容（含纯空白、纯注释或无实质文字）
  const strippedContent = content.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!content || strippedContent.length === 0) {
    log.info(
      { article: title, revid },
      "target page content is blank or contains no actual content",
    );
    return { status: "empty", title, revid };
  }

  return {
    status: "ok",
    snapshot: { requested: article, title, revid, namespace: page.ns, content },
  };
}

/** 快照获取失败时的确定性回报文案（各任务措辞差异由 actionLabel/summaryPrefix 提供）。 */
export type ArticleSnapshotFailure = {
  replyText: string;
  summary: string;
  article: string;
  articleRevid: number | null;
  error: string;
};

/**
 * 把快照校验失败结果转成统一的「not done」回报文案与落库字段。
 *
 * @param actionLabel 操作名词，用于文案「无法进行{X}」，如「校对」「发布前评审」
 * @param summaryPrefix 编辑摘要前缀，如「校对请求处理」「发布前评审请求处理」
 */
export function describeArticleSnapshotFailure(
  outcome:
    | { status: "page-missing" }
    | { status: "namespace"; ns: number }
    | { status: "empty"; title: string; revid: number },
  options: { article: string; actionLabel: string; summaryPrefix: string },
): ArticleSnapshotFailure {
  const { article, actionLabel, summaryPrefix } = options;

  switch (outcome.status) {
    case "page-missing":
      return {
        replyText: `页面“${safeWikitext(article)}”不存在，无法进行${actionLabel}。~~~~`,
        summary: `${summaryPrefix}：页面不存在 (${article})`,
        article,
        articleRevid: null,
        error: "page_missing",
      };

    case "namespace":
      return {
        replyText: `页面“${safeWikitext(article)}”位于无效命名空间，仅支持正式条目、草稿和用户草稿。~~~~`,
        summary: `${summaryPrefix}：不支持的名字空间 (${article})`,
        article,
        articleRevid: null,
        error: "disallowed_namespace",
      };

    case "empty":
      return {
        replyText: `页面“${safeWikitext(outcome.title)}”内容为空，无法进行${actionLabel}。~~~~`,
        summary: `${summaryPrefix}：页面内容为空 (${outcome.title})`,
        article: outcome.title,
        articleRevid: outcome.revid,
        error: "empty_content",
      };
  }
}

// ---------------------------------------------------------------------------
// 4. 两阶段审核引擎（全局检查 → 可选局部 Chunk 扫描 → 去重合并）
// ---------------------------------------------------------------------------

export type ArticleReviewEngineOptions<
  TIssue extends BaseReviewIssue,
  TResult,
> = {
  models: LlmModelSpec[];
  log: Logger;
  /** 日志前缀，如 review / afc */
  label: string;
  /** 跨阶段累计的 Token 统计 */
  usageTracker: TokenUsage;

  /** 待审阅的固定版本 */
  page: {
    title: string;
    revid: number;
    namespace: number;
    content: string;
  };

  /** 规则页拆分结果 */
  globalRuleContent: string;
  chunkRuleContent: string;

  /** Schema 与系统提示词 */
  resultSchema: z.ZodType<TResult>;
  chunkSchema: z.ZodType<{ issues: TIssue[] }>;
  globalSystemPrompt: string;
  chunkSystemPrompt: string;
  mergeSystemPrompt: string;
  /** 语义合并候选说明 */
  mergeIntro: string;

  /** 提示词中的标题文案（各任务措辞不同，需逐字保留） */
  ruleHeading: string;
  infoHeading: string;
  contentHeading: string;

  /** 结果映射：把各任务的 Schema 结构还原为通用流程所需的信息 */
  getIssues: (result: TResult) => TIssue[];
  getChunkIssues: (result: { issues: TIssue[] }) => TIssue[];
  isEncyclopedic: (result: TResult) => boolean;
  nonEncyclopedicReason: (result: TResult) => string | null;
  assemble: (globalResult: TResult, issues: LocatedIssue<TIssue>[]) => TResult;

  /** 去重与合并字段 */
  issueIdentity: (issue: TIssue) => string;
  mergeFields: (issue: TIssue) => Record<string, string | null | undefined>;

  /** 局部 Chunk 扫描开关（预留能力，见模块头注释） */
  chunkEnabled: boolean;
};

export type ArticleReviewOutcome<TResult> =
  | { kind: "not-encyclopedic"; result: TResult; model: string }
  | { kind: "reviewed"; result: TResult; model: string };

/**
 * 执行一次条目审阅的 LLM 阶段。
 *
 * 返回 `not-encyclopedic` 时表示页面明显不是百科条目（调用方负责拒绝回报与落库）；
 * 返回 `reviewed` 时即为可渲染/落库的最终结构化结果。
 * LLM 调用失败会直接抛出，由调用方统一记录错误。
 */
export async function runArticleReviewEngine<
  TIssue extends BaseReviewIssue,
  TResult,
>(
  options: ArticleReviewEngineOptions<TIssue, TResult>,
): Promise<ArticleReviewOutcome<TResult>> {
  const {
    models,
    log,
    label,
    usageTracker,
    page,
    globalRuleContent,
    chunkRuleContent,
    resultSchema,
    chunkSchema,
    globalSystemPrompt,
    chunkSystemPrompt,
    mergeSystemPrompt,
    mergeIntro,
    ruleHeading,
    infoHeading,
    contentHeading,
    getIssues,
    getChunkIssues,
    isEncyclopedic,
    nonEncyclopedicReason,
    assemble,
    issueIdentity,
    mergeFields,
    chunkEnabled,
  } = options;

  const { title, revid, namespace, content } = page;

  const buildPageInfo = (chunk?: ReviewChunk): string =>
    [
      infoHeading,
      `页面标题：${title}`,
      `名字空间：${namespace}`,
      `固定修订版本ID：${revid}`,
      ...(chunk ? [`当前检查单元：${chunk.title} (${chunk.chunkId})`] : []),
    ].join("\n");

  const buildGlobalPrompt = (): string =>
    `${ruleHeading}\n${globalRuleContent}\n\n${buildPageInfo()}\n\n${contentHeading}\n${content}`;

  const buildChunkPrompt = (chunk: ReviewChunk): string =>
    `${ruleHeading}\n${chunkRuleContent}\n\n${buildPageInfo(chunk)}\n\n${contentHeading}\n${chunk.content}`;

  // 第一阶段：全文全局检查
  log.info(
    { article: title, revid },
    `starting global full-text ${label} pass...`,
  );

  const globalPrompt = buildGlobalPrompt();
  const globalPassOutput = await executeWithFallback(
    models,
    async (modelInstance) => {
      const res = await generateObject({
        model: modelInstance,
        schema: resultSchema,
        system: globalSystemPrompt,
        prompt: globalPrompt,
      });
      return { result: res.object, usage: res.usage };
    },
    usageTracker,
  );

  log.debug(
    {
      systemChars: globalSystemPrompt.length,
      ruleChars: globalRuleContent.length,
      promptChars: globalPrompt.length,
      usage: globalPassOutput.usage,
    },
    `${label} global pass completed`,
  );

  const globalResult = globalPassOutput.result;
  const modelUsed = globalPassOutput.model;

  if (!isEncyclopedic(globalResult)) {
    log.info(
      {
        article: title,
        revid,
        reason: nonEncyclopedicReason(globalResult),
      },
      `page content is not an encyclopedic article/draft, rejecting ${label} request`,
    );
    return { kind: "not-encyclopedic", result: globalResult, model: modelUsed };
  }

  const rawIssues: LocatedIssue<TIssue>[] = getIssues(globalResult).map(
    (issue) => ({ ...issue, chunkId: "global", chunkIds: ["global"] }),
  );

  // 第二阶段：局部 Chunk 高覆盖扫描（可选）
  if (chunkEnabled) {
    const chunks = splitWikitextIntoChunks(content);
    log.info(
      { article: title, revid, chunkCount: chunks.length },
      `constructed ${label} chunks for scanning`,
    );

    for (const chunk of chunks) {
      try {
        if (SKIP_SECTIONS.has(chunk.title)) {
          log.debug({ article: title, chunk }, `${label} skipped section`);
          continue;
        }

        const chunkPrompt = buildChunkPrompt(chunk);
        const chunkPassOutput = await executeWithFallback(
          models,
          async (modelInstance) => {
            const res = await generateObject({
              model: modelInstance,
              schema: chunkSchema,
              system: chunkSystemPrompt,
              prompt: chunkPrompt,
            });
            return { result: res.object, usage: res.usage };
          },
          usageTracker,
        );

        const chunkIssues = getChunkIssues(chunkPassOutput.result);
        log.info(
          {
            chunkId: chunk.chunkId,
            title: chunk.title,
            issueCount: chunkIssues.length,
            chunkUsage: chunkPassOutput.usage,
            totalUsage: chunkPassOutput.totalUsage,
            promptChars: chunkPrompt.length,
          },
          `${label} chunk review completed`,
        );

        for (const issue of chunkIssues) {
          rawIssues.push({
            ...issue,
            chunkId: chunk.chunkId,
            chunkIds: [chunk.chunkId],
          });
        }
      } catch (err) {
        log.warn(
          { err, chunkId: chunk.chunkId, article: title },
          `${label} chunk review failed, continuing with other chunks`,
        );
      }
    }
  } else {
    log.info(
      { article: title, revid },
      `skipping ${label} chunk scan (not enabled)`,
    );
  }

  // 第三阶段：确定性去重 + 语义合并
  const finalIssues = await dedupeAndMergeIssues<TIssue>({
    models,
    log,
    label,
    usageTracker,
    systemPrompt: mergeSystemPrompt,
    intro: mergeIntro,
    issues: rawIssues,
    identity: issueIdentity,
    mergeFields,
  });

  log.debug(
    { article: title, issueCount: finalIssues.length },
    `${label} aggregation completed`,
  );

  return {
    kind: "reviewed",
    result: assemble(globalResult, finalIssues),
    model: modelUsed,
  };
}

// ---------------------------------------------------------------------------
// 5. 结果页写入与请求回报
// ---------------------------------------------------------------------------

/**
 * 计算结果页应使用的唯一日期章节标题（读取现有结果页后生成）。
 */
export async function planResultSectionTitle(
  ctx: HandlerContext,
  resultPageTitle: string,
  baseDateTitle: string,
): Promise<string> {
  const existingText = await pageText(ctx.bot, resultPageTitle, {
    redirects: false,
  });
  return generateUniqueSectionTitle(
    parseSections(existingText).map((section) => section.title),
    baseDateTitle,
  );
}

/**
 * 将审核结果写入结果页的新唯一日期章节（程序负责文字拼接）。
 */
export async function publishReviewResult(
  ctx: HandlerContext,
  options: {
    resultPageTitle: string;
    sectionTitle: string;
    fixedRevid: number;
    body: string;
    summary: string;
  },
): Promise<number | null> {
  const { bot } = ctx;
  const { resultPageTitle, sectionTitle, fixedRevid, body, summary } = options;

  const content = await pageText(bot, resultPageTitle);
  const sectionWikitext = `== ${sectionTitle} ==
条目版本：[[Special:Permalink/${fixedRevid}|${fixedRevid}]]

'''注意：以下内容由AI生成，可能存在不准确之处，仅供参考。请勿回复本留言。'''

${body}

~~~~`;

  const text =
    content && content.trim().length > 0
      ? `${content.trimEnd()}\n\n${sectionWikitext}\n`
      : `{{Talkarchive}}\n\n${sectionWikitext}\n`;

  const resEdit = await bot.save(resultPageTitle, text, summary);
  return resEdit.newrevid ?? null;
}

/** 一次条目审核请求的公共定位信息（各任务拒绝回报时复用）。 */
export type ArticleRequestBase = {
  /** 日志前缀，如 review / afc */
  label: string;
  talkPage: string;
  templateName: string;
  targetSection: RequestSectionRef;
  comment: string;
  revid: number;
  actorId: number;
};

/**
 * 将请求标记为 `status = not done` 并回复原因；仅在真正写入维基时回调落库。
 *
 * dry-run（writeEnabled=false）下不写维基，也不会触发 `onWritten`。
 */
export async function rejectArticleRequest(
  ctx: HandlerContext,
  base: ArticleRequestBase,
  action: {
    replyText: string;
    summary: string;
    dryRunMessage?: string;
    /**
     * 传入则在回报成功后把触发修订标记为已处理（幂等）。
     * 未传入时由调用方在 `onWritten` 中自行记录，以便携带任务专属的统计字段。
     */
    event?: { revid: number; actorId: number };
  },
  onWritten?: (replyRevid: number | null) => void,
): Promise<void> {
  const result = await replyNotDone(ctx, {
    talkPage: base.talkPage,
    templateName: base.templateName,
    targetSection: base.targetSection,
    comment: base.comment,
    replyText: action.replyText,
    summary: action.summary,
    dryRunMessage:
      action.dryRunMessage ?? `[dry-run] ${base.label} not-done reply`,
    event: action.event,
  });

  if (result) {
    onWritten?.(result.newrevid ?? null);
  }
}
