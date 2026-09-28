import { pageText } from "../utils/wiki.js";
import {
  generateUniqueSectionTitle,
  parseSections,
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
  type ArticleSnapshot,
} from "../utils/articleReview.js";
import {
  analyzeWikitextClues,
  formatUtcMinute,
  loadAiRules,
  MAX_ARTICLE_CHARS,
  safeTitle,
  type AiClueResult,
} from "./aiEditMonitor.js";
import type { HandlerContext } from "../handle.js";

/**
 * 任务三（3-2）疑似 AI 分析（模板请求驱动，工作流类似 afc）
 *
 * 监听 tasks.aiEdit.talkPage 上使用 tasks.aiEdit.template 的请求章节，
 * 支持 article1、article2……article20 参数（可为正式条目或 tasks.aiEdit.draftNamespace 允许的草稿），
 * 按任务（日期 + 提交人用户名）汇总到同一结果页。
 *
 * 章节定位、模板解析、互斥锁与「就地回报进度」等共性流程复用 utils/requestWorkflow；
 * 线索判定的 Schema、系统提示词与规则加载复用 aiEditMonitor.ts 中的 3-1/3-2 共用契约，
 * 保证两条路径的中立性与证据要求完全一致。
 */

/** 3-2 请求互斥锁超时时间（15 分钟，与其它请求类任务一致）。 */
export const AI_LOCK_TIMEOUT_MS = REQUEST_LOCK_TIMEOUT_MS;

/** 3-2 请求锁注册表（键为 `talkPage#sectionTitle` 与 `revid:xxx`）。 */
const aiEditLocks: RequestLockRegistry = createRequestLockRegistry();

/** 渲染 3-2 结果页中的一次请求章节（程序完成文字拼接）。 */
function renderAiCheckSection(
  sectionTitle: string,
  actor: string,
  sourceRevid: number,
  results: { title: string; revid: number; result: AiClueResult }[],
  marker: string,
): string {
  const lines: string[] = [
    `== ${sectionTitle} ==`,
    "'''注意：以下内容仅为疑似生成式 AI 辅助编辑线索的初步分析，不代表确认或否认该用户滥用 AI。'''",
  ];

  for (const item of results) {
    lines.push(`=== ${safeTitle(item.title)} ===`);
    lines.push(`* {{La|${safeWikitext(item.title)}}}`);
    // 无线索时不展示线索强度，避免读者把「未发现线索」与高分并列误读为「很可能用了 AI」
    if (item.result.issues.length > 0) {
      lines.push(`* 线索强度：${item.result.confidence}`);
    }
    lines.push(`* 结论：${safeWikitext(item.result.summary)}`);
    lines.push("");

    if (item.result.issues.length === 0) {
      lines.push(":（未发现达到记录门槛的疑似 AI 线索）");
      lines.push("");
      continue;
    }

    for (const issue of item.result.issues) {
      const loc = issue.location
        ? `<small>（${safeWikitext(issue.location)}）</small>`
        : "";
      lines.push(`; 线索强度：${issue.strength}${loc}`);
      lines.push(`: {{tq|${safeWikitext(issue.evidence)}}}`);
      lines.push(`: ${safeWikitext(issue.analysis)}`);
      lines.push(
        `: '''其他可能解释：'''<i>${safeWikitext(issue.alternative)}</i>`,
      );
      lines.push(`: '''建议：'''<u>${safeWikitext(issue.check)}</u>`);
    }
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

  // 1. 收集 article / article1..article20 参数（与任务二、任务四一致，支持无编号的 article）。
  const article0 = unwrapPageParam(reqTemplate.params.article);
  const articles = collectIndexedParams(reqTemplate.params, "article", 20);
  if (article0) {
    articles.push(article0);
  }
  if (articles.length === 0) {
    await replyAiNotDone(ctx, {
      revid,
      actorId,
      targetSection,
      comment,
      replyText:
        "未指定待分析条目。请使用 article1、article2……article20 参数提供条目名。~~~~",
      summary: "疑似 AI 线索请求处理：未指定条目",
    });
    return;
  }

  // 2. 逐条解析并读取条目固定版本（条目命名空间 ns 0 及 tasks.aiEdit.draftNamespace 允许的草稿命名空间）。
  const resolved: ArticleSnapshot[] = [];
  for (const requested of articles) {
    try {
      const outcome = await fetchArticleSnapshot(ctx, {
        article: requested,
        allowedNamespaces: [0, ...ai.draftNamespaces],
      });
      if (outcome.status !== "ok") continue;

      const snapshot = outcome.snapshot;
      if (snapshot.content.length > MAX_ARTICLE_CHARS) {
        log.info(
          { title: snapshot.title, length: snapshot.content.length },
          "aiEdit skip oversized article",
        );
        continue;
      }
      resolved.push(snapshot);
    } catch (err) {
      log.warn({ err, requested }, "aiEdit failed to fetch article content");
    }
  }

  if (resolved.length === 0) {
    await replyAiNotDone(ctx, {
      revid,
      actorId,
      targetSection,
      comment,
      replyText:
        "指定的条目不存在、不在受支持的名字空间（条目或草稿）或内容为空，无法分析。~~~~",
      summary: "疑似 AI 线索请求处理：条目无效",
    });
    return;
  }

  // 3. 按规则逐条调用 LLM，输出结构化线索。
  const ruleContent = await loadAiRules(ctx);
  const usage = createTokenUsage();
  const results: { title: string; revid: number; result: AiClueResult }[] = [];

  for (const article of resolved) {
    try {
      const result = await analyzeWikitextClues(ctx, {
        phase: "3-2",
        title: article.title,
        revid: article.revid,
        content: article.content,
        ruleContent,
        usageTracker: usage,
      });
      results.push({ title: article.title, revid: article.revid, result });
    } catch (err) {
      log.error(
        { err, article: article.title },
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
  const existingContent = await pageText(bot, resultPage, {
    redirects: false,
  });
  const sectionTitle = generateUniqueSectionTitle(
    parseSections(existingContent).map((s) => s.title),
    formatUtcMinute(now),
  );
  const marker = `<!-- ai-request:${revid} -->`;
  const sectionBody = renderAiCheckSection(
    sectionTitle,
    actor,
    revid,
    results,
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
 * 支持 article1、article2……article20 参数，按任务（日期 + 提交人用户名）汇总结果页。
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
