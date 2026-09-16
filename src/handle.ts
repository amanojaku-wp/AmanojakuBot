import type Database from "better-sqlite3";
import type { Mwn } from "mwn";
import type { Logger } from "pino";
import type { AppConfig } from "./config/index.js";
import { revision } from "./utils/wiki.js";
import {
  extractCommentDetails,
  insertReplyIntoContent,
  isRelevant,
} from "./utils/wikitext.js";
import { prepareChatReply } from "./tasks/chat.js";
import { isReviewRequest, prepareReview } from "./tasks/review.js";
import { analyzeCandidate } from "./tasks/aiEdit.js";

/**
 * 维基变更事件数据结构
 */
export type ChangeEvent = {
  wiki?: string;
  type?: string;
  title?: string;
  namespace?: number;
  bot?: boolean;
  user?: string;
  revision?: { new?: number };
  length?: { old?: number; new?: number };
};

/**
 * 路由处理器依赖上下文
 */
export type HandlerContext = {
  db: Database.Database;
  bot: Mwn;
  cfg: AppConfig;
  log: Logger;
  canWrite: () => Promise<boolean>;
  seenStatement?: Database.Statement;
  saveStatement?: Database.Statement;
};

/**
 * 变更事件主路由分发器
 *
 * 核心路由决策：
 * 1. 任务三（AI 编辑初筛）：拦截主条目与草稿命名空间的非机器人近期编辑并送审。
 * 2. 讨论页变更过滤：严格匹配机器人讨论页的普通编辑，排除自身与机器人账号。
 * 3. 任务二（条目评审）vs 任务一（自由对话）意图识别与分发。
 * 4. 幂等回复与维基写入安全保障。
 */
export async function handle(
  e: ChangeEvent,
  ctx: HandlerContext,
): Promise<void> {
  const { db, bot, cfg, log, canWrite } = ctx;

  const seen =
    ctx.seenStatement ?? db.prepare("SELECT state FROM events WHERE revid=?");
  const save =
    ctx.saveStatement ??
    db.prepare(
      "INSERT INTO events(revid,state,actor_id,reply_revid,updated_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(revid) DO UPDATE SET state=excluded.state,reply_revid=excluded.reply_revid,updated_at=excluded.updated_at",
    );

  // 1. 任务三：监听主条目与草稿命名空间的近期编辑，送审候选池
  if (
    cfg.tasks.aiEdit.enabled &&
    (!cfg.wiki.wikiId || e.wiki === cfg.wiki.wikiId) &&
    e.revision?.new &&
    e.title &&
    e.namespace !== undefined &&
    e.user &&
    e.user !== cfg.wiki.username
  ) {
    await analyzeCandidate(
      db,
      bot,
      {
        revid: e.revision.new,
        title: e.title,
        namespace: e.namespace,
        user: e.user,
        bot: e.bot,
        type: e.type ?? "",
        oldLength: e.length?.old,
        newLength: e.length?.new,
      },
      {
        draftNamespace: cfg.wiki.draftNamespace,
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        minConfidence: cfg.tasks.aiEdit.minConfidence,
        maxAnalysesPerWindow: cfg.tasks.aiEdit.maxAnalysesPerWindow,
        reportPagePrefix: cfg.tasks.aiEdit.reportPagePrefix!,
        usersPage: cfg.tasks.aiEdit.usersPage!,
        writeEnabled: cfg.writeEnabled,
      },
    );
  }

  // 2. 任务一与任务二：讨论页事件前置检查与去重
  if (!isRelevant(e, cfg.wiki.talkPage, cfg.wiki.username, cfg.wiki.wikiId))
    return;
  const revid = e.revision!.new!;
  if ((seen.get(revid) as { state: string } | undefined)?.state === "done")
    return;

  // 从 MediaWiki API 获取权威元数据（包括权威 actorId、时间戳与修改前后差异）
  const rev = await revision(bot, revid);
  if (
    !rev ||
    rev.actor !== e.user ||
    rev.before === undefined ||
    rev.after === undefined
  )
    return;

  // 提取留言详情与章节上下文（支持页面中间插话、时间戳校验及二级标题归属）
  const extraction = extractCommentDetails(
    rev.before,
    rev.after,
    rev.timestamp,
    cfg.wiki.timestampFormat,
  );
  if (!extraction) return;
  const message = extraction.comment;

  // 链上控制开关阻断检查
  if (!(await canWrite())) {
    log.info({ revid }, "disabled by control page");
    return;
  }

  // 3. 任务二 vs 任务一 路由决策
  const review = cfg.tasks.review.enabled && isReviewRequest(message);
  let reply: string;
  if (review) {
    reply = await prepareReview(db, bot, rev.actorId, revid, message, {
      dailyLimit: cfg.tasks.review.dailyLimit,
      draftNamespace: cfg.wiki.draftNamespace,
      ownerUserId: cfg.wiki.ownerUserId,
      apiUrl: cfg.wiki.apiUrl,
      provider: cfg.llm.provider,
      model: cfg.llm.model,
      writeEnabled: cfg.writeEnabled,
    });
  } else {
    reply = await prepareChatReply(
      db,
      bot,
      rev.actorId,
      rev.actor,
      message,
      extraction,
      {
        personaPage: cfg.wiki.personaPage,
        provider: cfg.llm.provider,
        model: cfg.llm.model,
      },
    );
  }

  if (!reply || reply.length > 12000)
    throw new Error("Empty or overlong reply");

  // 4. 幂等回复与真实维基写入
  const marker = `<!-- amanojaku-bot:source=${revid} -->`;
  if (!cfg.writeEnabled) {
    log.info({ revid, actorId: rev.actorId, reply }, "dry run");
    return;
  }

  if (!(await canWrite())) return;

  // 双重校验：若页面已存在该 source revid 标记，说明先前请求已成功写入但本地位点未提交，直接标记 done
  const currentTalk = await bot.read(cfg.wiki.talkPage);
  const currentTalkContent = currentTalk?.revisions?.[0]?.content ?? "";
  if (currentTalkContent.includes(marker)) {
    save.run(revid, "done", rev.actorId, null);
    return;
  }

  save.run(revid, "pending", rev.actorId, null);
  const replyWikitext = `:${reply.replaceAll("~~~~", "")} —~~~~ ${marker}`;
  const result = await bot.edit(cfg.wiki.talkPage, ({ content }) => {
    if (content.includes(marker))
      throw new Error("Reply marker already present");
    return {
      text: insertReplyIntoContent(
        content,
        replyWikitext,
        extraction.sectionTitle,
      ),
      summary: `${review ? "回复评审请求" : "回复留言"}`,
    };
  });

  // 事务记录完成状态与短期对话记忆
  db.transaction(() => {
    save.run(revid, "done", rev.actorId, result.newrevid ?? null);
    if (!review) {
      db.prepare(
        "INSERT INTO messages(actor_id,source_revid,role,content,created_at) VALUES(?,?,?, ?,datetime('now'))",
      ).run(rev.actorId, revid, "user", message);
      db.prepare(
        "INSERT INTO messages(actor_id,source_revid,role,content,created_at) VALUES(?,?,?, ?,datetime('now'))",
      ).run(rev.actorId, revid, "assistant", reply);
    }
  })();
  log.info({ revid }, "replied");
}
