import { pageText, revisionDiff } from "../utils/wiki.js";
import {
  canonicalTitle,
  generateUniqueSectionTitle,
  parseSections,
  safeReportText,
  safeWikitext,
} from "../utils/wikitext.js";
import { createTokenUsage } from "../utils/llm.js";
import {
  collectIndexedParams,
  createRequestLockRegistry,
  createTemplateRequestHandler,
  replyToRequest,
  REQUEST_LOCK_TIMEOUT_MS,
  unwrapPageParam,
  type IncomingRequest,
  type RequestLockRegistry,
  type RequestSectionRef,
} from "../utils/requestWorkflow.js";
import {
  fetchArticleSnapshot,
  rejectArticleRequest,
  withResultPageLock,
} from "../utils/articleReview.js";
import {
  analyzeWithReferenceLinks,
  formatUtcMinute,
  loadAiRules,
  MAX_ARTICLE_CHARS,
  renderDiffLinks,
  safeTitle,
  toDiffInput,
  type AiClueResult,
  type AiDiffInput,
  type AiDiffRef,
} from "./aiEditMonitor.js";
import type { HandlerContext } from "../handle.js";

/**
 * 任务三（3-2）疑似 AI 分析（模板请求驱动，工作流类似 afc）
 *
 * 监听 tasks.aiEdit.talkPage 上使用 tasks.aiEdit.template 的请求章节，
 * 支持 article1、article2……article20 参数（条目名，可为正式条目或 tasks.aiEdit.draftNamespace 允许的草稿）
 * 以及 diff1、diff2……diff20 参数（修订版本号或 [[Special:Diff/…]] 差异链接），
 * 按任务（日期 + 提交人用户名）汇总到同一结果页。
 *
 * 送检规则（与 3-1 一致）：
 * - 先按「规范化条目名」把 article 与 diff 参数合并：同一条目只送检一次，其全部差异合并为同一次请求；
 * - **只送编辑差异，不送条目全文**（避免烧 token）；仅当本次没有任何差异可送时才附完整条目，
 *   否则请求没有可判断的内容；
 * - 报告页用 {{La}} 整理条目相关链接（条目、编辑、讨论、历史等），并按送检差异逐条列出 Diff。
 *
 * 线索来源有两类：
 * - 先执行程序化确定性检查（runReferenceLinkCheck，不依赖 LLM）：提取参考文献 / 外部链接的 URL 探测可达性，
 *   并把异常 URL（deadUrls）与新增引用失效统计（stats）作为确定性事实一并送检；
 * - 模型据此输出文风 / 格式 / 内容层面的疑似线索，程序再合并一条「URL 无法访问」的线索
 *   （单个 low、多个 medium），保证不完全依赖模型输出。
 *
 * 跳过规则（逐项跳过，不影响其它有效对象；只有全部无效时才回复 not done）：
 * - article / diff 参数无法识别，或对应页面不存在、不可读取、不在条目与 draftNamespace 命名空间内；
 * - diff 的编辑时间早于 MIN_AI_EDIT_YEAR（2023）——早于生成式 AI 广泛使用的编辑不可能是 AI 编辑。
 *
 * 章节定位、模板解析、互斥锁与「就地回报进度」等共性流程复用 utils/requestWorkflow；
 * 线索判定的 Schema、系统提示词、送检输入与规则加载复用 aiEditMonitor.ts 中的 3-1/3-2 共用契约，
 * 保证两条路径的中立性与证据要求完全一致。
 */

/** 3-2 请求互斥锁超时时间（15 分钟，与其它请求类任务一致）。 */
export const AI_LOCK_TIMEOUT_MS = REQUEST_LOCK_TIMEOUT_MS;

/** 单次请求最多接受的差异参数数量（diff1…diff20）。 */
export const MAX_DIFF_PARAMS = 20;

/**
 * 生成式 AI 辅助编辑的时间下限（年）。
 *
 * ChatGPT 于 2022 年 11 月底发布、2023 年起被广泛使用；早于该年的编辑不可能由生成式 AI 生成，
 * 因此 3-2 请求中编辑时间早于该年的差异直接跳过：不送模型、也不做链接检查，不计入线索。
 */
export const MIN_AI_EDIT_YEAR = 2023;

/**
 * 该修订时间是否早于生成式 AI 广泛使用的年份。
 *
 * 时间戳缺失或无法解析时返回 false（照常分析），避免因 API 未返回时间而漏检。
 */
export function isBeforeAiEra(timestamp: string | undefined): boolean {
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return false;
  return new Date(time).getUTCFullYear() < MIN_AI_EDIT_YEAR;
}

/** 3-2 请求锁注册表（键为 `talkPage#sectionTitle` 与 `revid:xxx`）。 */
const aiEditLocks: RequestLockRegistry = createRequestLockRegistry();

/** 快照校验失败时在「已跳过」清单中展示的原因（逐项跳过，不影响其它送检对象）。 */
const ARTICLE_SNAPSHOT_SKIP_REASONS: Record<string, string> = {
  "page-missing": "页面不存在",
  namespace: "所在页面不在条目或草稿命名空间",
  empty: "页面内容为空",
  "no-revid": "无法读取修订版本号",
};

/** 请求中解析出的差异引用：目标修订号 + 可选对比基准修订号。 */
export type DiffRef = { revid: number; fromRevid?: number };

/**
 * 解析模板中的 diff 参数。
 *
 * 支持：裸修订号（`12345`）、`[[Special:Diff/12345]]`、`[[Special:差异/12345]]`，
 * 以及双版本形式 `[[Special:Diff/12345/67890]]`（以 67890 为目标版本、12345 为基准版本）。
 * 无法识别时返回 null（由调用方回报给提交人）。
 */
export function parseDiffParam(value: string | undefined): DiffRef | null {
  if (!value) return null;
  const raw = unwrapPageParam(value).trim();
  if (!raw) return null;

  const linkMatch = raw.match(
    /(?:(?:Special|特别|特別|特殊)\s*:\s*)?(?:Diff|diff|差异|差異)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/,
  );
  if (linkMatch) {
    const first = Number(linkMatch[1]);
    const second = linkMatch[2] ? Number(linkMatch[2]) : undefined;
    return second ? { revid: second, fromRevid: first } : { revid: first };
  }

  if (/^\d+$/.test(raw)) return { revid: Number(raw) };
  return null;
}

/** 3-2 结果页中的一个条目（一个条目只出现一次，其全部送检差异合并展示）。 */
type AiCheckResultItem = {
  title: string;
  /** 附带完整条目正文时对应的修订号（否则为差异所属修订） */
  revid?: number;
  diffs: AiDiffRef[];
  result: AiClueResult;
};

/** 3-2 送检前按规范化条目名合并的分析对象。 */
type AiCheckTarget = {
  title: string;
  canonical: string;
  /** 完整条目正文是否来自 article 参数快照（否则取差异所属修订的正文） */
  fromArticle: boolean;
  content?: string;
  revid?: number;
  diffs: AiDiffInput[];
};

/**
 * 渲染 3-2 结果页中的一次请求章节（程序完成文字拼接）。
 *
 * 正文一律经 safeReportText：链接检查证据与模型输出都可能带明文 URL，
 * 而明文 http / https 会被滥用过滤器当作外链拦下机器人写报告。
 */
function renderAiCheckSection(
  sectionTitle: string,
  results: AiCheckResultItem[],
  skipped: string[],
  marker: string,
): string {
  const lines: string[] = [
    `== ${sectionTitle} ==`,
    "'''注意：以下内容仅为疑似生成式 AI 辅助编辑线索的初步分析，不代表确认或否认该用户滥用 AI。'''",
  ];

  for (const item of results) {
    lines.push(`=== ${safeTitle(item.title)} ===`);
    // {{La}} 负责整理条目相关链接（条目、编辑、讨论、历史等），此处只按送检差异列出具体 Diff
    lines.push(`* {{La|${safeWikitext(item.title)}}}`);
    if (item.diffs.length > 0) {
      lines.push(`* Diff: ${renderDiffLinks(item.diffs)}`);
    }
    lines.push(`* 结论：${safeReportText(item.result.summary)}`);
    lines.push("");

    if (item.result.issues.length === 0) {
      lines.push(":（未发现达到记录门槛的疑似 AI 线索）");
      lines.push("");
      continue;
    }

    for (const issue of item.result.issues) {
      const loc = issue.location
        ? `<small>（${safeReportText(issue.location)}）</small>`
        : "";
      // 同一条目送检多条差异时标注线索归属，便于人工对照具体编辑
      const diffTag =
        issue.diff && item.diffs.length > 1
          ? `<small>（差异 [[Special:Diff/${issue.diff}|${issue.diff}]]）</small>`
          : "";
      lines.push(`; 线索强度：${issue.strength}${loc}${diffTag}`);
      lines.push(`: {{tq|${safeReportText(issue.evidence)}}}`);
      lines.push(`: ${safeReportText(issue.analysis)}`);
      lines.push(
        `: '''其他可能解释：'''<i>${safeReportText(issue.alternative)}</i>`,
      );
      lines.push(`: '''建议：'''<u>${safeReportText(issue.check)}</u>`);
    }
    lines.push("");
  }

  if (skipped.length > 0) {
    lines.push(
      `: '''未能读取或已跳过的送检对象：'''${safeReportText(
        [...new Set(skipped)].join("；"),
      )}`,
    );
    lines.push("");
  }

  lines.push("~~~~" + marker);
  return lines.join("\n");
}

/**
 * 将一个 3-2 请求标记为 not done 并回复原因（复用通用请求工作流）。
 */
async function replyAiNotDone(
  ctx: HandlerContext,
  params: {
    revid: number;
    actorId: number;
    targetSection: RequestSectionRef;
    comment: string;
    replyText: string;
    summary: string;
  },
): Promise<void> {
  const ai = ctx.cfg.tasks.aiEdit;

  await rejectArticleRequest(
    ctx,
    {
      label: "aiEdit",
      talkPage: ai.talkPage!,
      templateName: ai.template!,
      targetSection: params.targetSection,
      comment: params.comment,
      revid: params.revid,
      actorId: params.actorId,
    },
    {
      replyText: params.replyText,
      summary: params.summary,
      event: { revid: params.revid, actorId: params.actorId },
    },
  );
}

/**
 * 执行一次 3-2 疑似 AI 线索分析请求。
 */
async function processAiCheckRequest(
  ctx: HandlerContext,
  request: IncomingRequest,
): Promise<void> {
  const { bot, cfg, log } = ctx;
  const ai = cfg.tasks.aiEdit;
  const talkPage = ai.talkPage!;
  const templateName = ai.template!;
  const { revid, actor, actorId, comment, targetSection, reqTemplate } =
    request;

  // 1. 收集 article / article1..article20（条目名，与任务二、任务四一致）与
  //    diff / diff1..diff20（修订版本号或差异链接）参数。
  const article0 = unwrapPageParam(reqTemplate.params.article);
  const articles = collectIndexedParams(reqTemplate.params, "article", 20);
  if (article0) {
    articles.push(article0);
  }

  const diff0 = reqTemplate.params.diff;
  const diffParamValues = [
    ...(diff0 ? [diff0] : []),
    ...collectIndexedParams(reqTemplate.params, "diff", MAX_DIFF_PARAMS),
  ];
  const diffRefs: DiffRef[] = [];
  /**
   * 被跳过的送检对象及原因（无法解析、修订不可读取、时间早于生成式 AI 时代、
   * 命名空间不受支持、页面不存在等）。逐项跳过不影响其它有效对象，
   * 但全部无效时会在回复与结果页中如实说明。
   */
  const skipped: string[] = [];
  for (const raw of diffParamValues) {
    const parsed = parseDiffParam(raw);
    if (!parsed) {
      skipped.push(`${raw}（无法识别为修订版本号或差异链接）`);
      continue;
    }
    if (
      !diffRefs.some(
        (d) => d.revid === parsed.revid && d.fromRevid === parsed.fromRevid,
      )
    ) {
      diffRefs.push(parsed);
    }
  }

  if (articles.length === 0 && diffRefs.length === 0) {
    await replyAiNotDone(ctx, {
      revid,
      actorId,
      targetSection,
      comment,
      replyText:
        "未指定待分析条目或差异。请使用 article1、article2……article20 提供条目名，或使用 diff1、diff2……diff20 提供修订版本号。~~~~",
      summary: "疑似 AI 线索请求处理：未指定条目或差异",
    });
    return;
  }

  // 2. 按「规范化条目名」把条目与差异合并：同一条目只分析一次，其全部差异合并为一次送检。
  //    条目命名空间为 ns 0 及 tasks.aiEdit.draftNamespace 允许的草稿命名空间。
  const allowedNamespaces = [0, ...ai.draftNamespaces];
  const targets = new Map<string, AiCheckTarget>();

  for (const requested of articles) {
    try {
      const outcome = await fetchArticleSnapshot(ctx, {
        article: requested,
        allowedNamespaces,
      });
      if (outcome.status !== "ok") {
        // 单个条目无效只跳过该条目，不影响同一请求中的其它条目 / 差异
        skipped.push(
          `${requested}（${ARTICLE_SNAPSHOT_SKIP_REASONS[outcome.status]}）`,
        );
        continue;
      }

      const snapshot = outcome.snapshot;
      const key = canonicalTitle(snapshot.title);
      const existingDiffs = targets.get(key)?.diffs ?? [];
      targets.set(key, {
        title: snapshot.title,
        canonical: key,
        fromArticle: true,
        content: snapshot.content,
        revid: snapshot.revid,
        diffs: existingDiffs,
      });
    } catch (err) {
      log.warn({ err, requested }, "aiEdit failed to fetch article content");
      skipped.push(`${requested}（读取失败）`);
    }
  }

  for (const ref of diffRefs) {
    try {
      const diff = await revisionDiff(bot, ref.revid, {
        fromRevid: ref.fromRevid,
      });
      if (!diff) {
        skipped.push(`Special:Diff/${ref.revid}（修订不存在或不可读取）`);
        continue;
      }
      // 早于生成式 AI 广泛使用的年份（2023）的编辑不可能是 AI 编辑：
      // 直接跳过，不送模型也不做链接检查。
      if (isBeforeAiEra(diff.timestamp)) {
        log.info(
          { revid: ref.revid, timestamp: diff.timestamp },
          "aiEdit 3-2 skip diff before AI era",
        );
        skipped.push(
          `Special:Diff/${ref.revid}（编辑时间 ${formatUtcMinute(
            diff.timestamp!,
          )} 早于 ${MIN_AI_EDIT_YEAR} 年，不可能为生成式 AI 编辑）`,
        );
        continue;
      }
      if (
        typeof diff.namespace === "number" &&
        !allowedNamespaces.includes(diff.namespace)
      ) {
        log.info(
          { revid: ref.revid, ns: diff.namespace },
          "aiEdit 3-2 diff in disallowed namespace",
        );
        skipped.push(
          `Special:Diff/${ref.revid}（所在页面不在条目或草稿命名空间）`,
        );
        continue;
      }

      const key = canonicalTitle(diff.title);
      const target: AiCheckTarget = targets.get(key) ?? {
        title: diff.title,
        canonical: key,
        fromArticle: false,
        diffs: [],
      };
      if (!target.diffs.some((d) => d.revid === diff.revid)) {
        target.diffs.push(toDiffInput(diff));
      }
      // 未由 article 参数提供完整条目时，以差异所属修订的正文作为「完整条目」
      if (
        !target.fromArticle &&
        diff.content &&
        (!target.revid || diff.revid >= target.revid)
      ) {
        target.content = diff.content;
        target.revid = diff.revid;
      }
      targets.set(key, target);
    } catch (err) {
      log.warn({ err, revid: ref.revid }, "aiEdit failed to read diff");
      skipped.push(`Special:Diff/${ref.revid}（读取失败）`);
    }
  }

  const resolved = [...targets.values()];
  if (resolved.length === 0) {
    // 只有「提供的全部 article 与 diff 都无效」时才 not done；单个对象无效只跳过它。
    const reasons = [...new Set(skipped)];
    const reasonText =
      reasons.length > 0
        ? `${reasons.slice(0, 5).join("；")}${
            reasons.length > 5 ? `；等共 ${reasons.length} 项` : ""
          }。`
        : "";
    await replyAiNotDone(ctx, {
      revid,
      actorId,
      targetSection,
      comment,
      replyText: `指定的条目或差异均无法分析，已全部跳过。${reasonText}请确认后重试。~~~~`,
      summary: "疑似 AI 线索请求处理：条目或差异全部无效",
    });
    return;
  }

  // 3. 先做程序化链接检查，再把结果（deadUrls + stats）与差异一并送 LLM
  //    （一个条目一轮只请求一次，携带该条目本次全部差异），最后合并程序生成的链接线索。
  const ruleContent = await loadAiRules(ctx);
  const usage = createTokenUsage();
  const results: AiCheckResultItem[] = [];

  for (const target of resolved) {
    // 只送编辑差异（与 3-1 一致）：条目全文不送模型，避免烧 token。
    // 唯一例外是本次没有任何差异可送（请求只给了 article 参数）——那时若不附正文，
    // 整个请求就没有可判断的内容，只能如实回报「没有可分析的内容或差异」。
    let content = target.diffs.length === 0 ? target.content : undefined;
    const revidForRequest = target.revid;
    if (content && content.length > MAX_ARTICLE_CHARS) {
      log.info(
        { title: target.title, length: content.length },
        "aiEdit 3-2 oversized article, sending diff only",
      );
      content = undefined;
    }

    // 既无完整条目也没有可送检差异时无法分析（如仅供条目名但正文过长），如实回报。
    if (!content && target.diffs.length === 0) {
      log.info(
        { title: target.title },
        "aiEdit 3-2 skip target without analyzable content or diff",
      );
      skipped.push(`${target.title}（没有可分析的内容或差异）`);
      continue;
    }

    try {
      const outcome = await analyzeWithReferenceLinks(ctx, {
        phase: "3-2",
        title: target.title,
        revid: revidForRequest,
        content,
        wikitext: target.content,
        diffs: target.diffs,
        ruleContent,
        usageTracker: usage,
      });

      results.push({
        title: target.title,
        revid: revidForRequest,
        diffs: target.diffs.map((d) => ({ revid: d.revid, user: d.user })),
        result: outcome.result,
      });
    } catch (err) {
      log.error(
        { err, article: target.title },
        "aiEdit 3-2 article analysis failed",
      );
    }
  }

  if (results.length === 0) {
    await replyAiNotDone(ctx, {
      revid,
      actorId,
      targetSection,
      comment,
      replyText: "疑似 AI 线索分析失败，请稍后重试。~~~~",
      summary: "疑似 AI 线索请求处理：分析失败",
    });
    return;
  }

  // 4. 按任务（日期 + 提交人用户名）汇总到一个结果页。
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10).replace(/-/g, "");
  const resultPage = `${talkPage}/${dateKey}-${actor}`;
  let sectionTitle = "";

  // 「读取现有结果页 → 生成唯一章节标题 → 写回」整体串行化：
  // 同一提交人的多笔请求汇总到同一结果页，并发写入会互相覆盖。
  await withResultPageLock(ctx, resultPage, async () => {
    let existingContent = await pageText(bot, resultPage, {
      redirects: false,
    });

    if ((existingContent || "").trim() === "") {
      existingContent = "{{Talkarchive}}";
    }

    sectionTitle = generateUniqueSectionTitle(
      parseSections(existingContent).map((s) => s.title),
      formatUtcMinute(now),
    );
    const marker = `<!-- ai-request:${revid} -->`;
    const sectionBody = renderAiCheckSection(
      sectionTitle,
      results,
      skipped,
      marker,
    );

    if (!cfg.writeEnabled) {
      log.info(
        {
          revid,
          actor,
          resultPage,
          sectionTitle,
          results,
          usage,
        },
        "[dry-run] aiEdit 3-2 analysis completed",
      );
      return;
    }

    if (!existingContent.includes(marker)) {
      const text = existingContent.trimEnd()
        ? `${existingContent.trimEnd()}\n\n${sectionBody}\n`
        : `${sectionBody}\n`;
      await bot.save(
        resultPage,
        text,
        `疑似 AI 线索初步分析：${results.map((r) => r.title).join("、")}`,
      );
    }
  });

  // 5. 更新请求模板并回复提交人。
  const reply = `\n:{{ping|${actor}}}疑似 AI 线索初步分析已完成，参见[[${resultPage}#${sectionTitle}|结果页]]。~~~~`;

  try {
    await replyToRequest(ctx, {
      talkPage,
      templateName,
      targetSection,
      comment,
      templateUpdates: {
        status: "done",
        resultpage: resultPage,
        section: sectionTitle,
      },
      reply,
      summary: `疑似 AI 线索分析完成：${results.map((r) => r.title).join("、")}`,
      event: {
        revid,
        actorId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    });
  } catch (err) {
    log.error(
      { err, talkPage },
      "failed to update aiEdit talk page request section",
    );
  }

  log.info(
    { revid, actor, resultPage, sectionTitle, usage },
    "aiEdit 3-2 request completed",
  );
}

/**
 * 任务三（3-2）疑似 AI 分析请求处理器。
 *
 * 监听 tasks.aiEdit.talkPage 上使用 tasks.aiEdit.template 的请求章节，
 * 支持 article1、article2……article20（条目名）与 diff1、diff2……diff20（修订版本或差异链接）参数，
 * 按任务（日期 + 提交人用户名）汇总结果页。
 * 页面展示可疑之处，作为发起 AI 调查的初步分析线索，不代表确认或否认此人滥用 AI。
 *
 * 公共入口流程（幂等检查 → 修订校验 → 留言提取 → 章节定位 → 模板解析 → 身份校验 →
 * 控制页熔断 → 请求互斥锁 → 业务处理）由 createTemplateRequestHandler 统一生成。
 */
export const aiEditHandler = createTemplateRequestHandler({
  label: "aiEdit",
  isEnabled: (cfg) => cfg.tasks.aiEdit.enabled,
  talkPage: (cfg) => cfg.tasks.aiEdit.talkPage,
  templateName: (cfg) => cfg.tasks.aiEdit.template,
  missingTemplateReply: "\n:请使用标准请求模板提交疑似 AI 线索分析请求。~~~~",
  missingTemplateSummary: "回复疑似 AI 线索请求：请使用标准模板",
  lock: aiEditLocks,
  process: processAiCheckRequest,
});
