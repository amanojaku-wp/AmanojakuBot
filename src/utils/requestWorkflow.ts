import type { Logger } from "pino";
import type { ChangeEvent, HandlerContext, TaskHandler } from "../handle.js";
import type { AppConfig } from "../config/index.js";
import {
  EVENT_CLAIM_SQL,
  EVENT_SAVE_SQL,
  isEventDone,
  readEventState,
} from "./db.js";
import { pageText, revision } from "./wiki.js";
import { withWikiPageLock } from "./pageWriteLock.js";
import { runWork } from "./workDispatch.js";
import {
  extractCommentDetails,
  extractSignatures,
  findMatchingSection,
  isRelevant,
  isSignatureMatchingActor,
  parseSections,
  parseWikiTemplates,
  updateWikiTemplate,
  type CommentExtractionResult,
  type ParsedWikiTemplate,
  type SectionInfo,
} from "./wikitext.js";

/**
 * 讨论页「模板请求」工作流通用框架
 *
 * 任务二（条目校对）、任务四（AfC 发布前评审）与任务三 3-2（疑似 AI 分析）共享同一套交互模型：
 * 1. 在机器人讨论页的二级标题章节中通过固定模板接收请求；
 * 2. 由「触发修订的编辑者 + 签名用户」双重校验请求者身份；
 * 3. 同一章节/修订只允许一路并发处理（互斥锁 + 超时回收）；
 * 4. 处理结果就地写回请求章节（更新模板 status/结果参数并追加回复），并记录幂等状态。
 *
 * 本模块把上述共性逻辑收敛到一处，各任务只保留自己的业务判定与结果渲染，避免三条链路的行为漂移。
 *
 * 两阶段执行（B 档并发架构）：
 * 1. **认领阶段**：归属判定 → 幂等校验 → 修订与章节定位 → 模板解析 → 身份校验 → 控制页熔断，
 *    全程只读，并在最后把修订记作 `claimed`。此阶段必须保持轻量。
 * 2. **工作阶段**：幂等复核（recheckRequestStillPending）→ 请求互斥锁 → 业务处理。
 *    经 utils/workQueue 按「请求键」调度：同章节串行、异章节/异页面并行，
 *    因此一笔耗时评审不再阻塞后续请求的认领与执行。
 */

// ---------------------------------------------------------------------------
// 1. 请求互斥锁
// ---------------------------------------------------------------------------

/** 请求锁默认超时（15 分钟），防止未捕获异常导致永久死锁。 */
export const REQUEST_LOCK_TIMEOUT_MS = 15 * 60 * 1000;

/** 单条请求锁的信息记录。 */
export type RequestLockInfo = {
  key: string;
  acquiredAt: number;
  revid?: number;
  sectionTitle: string;
  /** 附加标识（如请求中的条目名），仅用于排查 */
  note?: string;
};

/**
 * 按「讨论页#章节标题」及「revid」双键索引的请求互斥锁注册表。
 */
export type RequestLockRegistry = {
  readonly timeoutMs: number;
  /** 指定章节或修订是否正在处理中（过期锁自动回收） */
  isLocked(talkPage: string, sectionTitle: string, revid?: number): boolean;
  /** 尝试获取排他锁，已被占用返回 false */
  acquire(
    talkPage: string,
    sectionTitle: string,
    revid?: number,
    note?: string,
  ): boolean;
  /** 释放锁 */
  release(talkPage: string, sectionTitle: string, revid?: number): void;
  /** 清空全部锁（主要用于单元测试隔离） */
  clear(): void;
};

function sectionLockKey(talkPage: string, sectionTitle: string): string {
  return `${talkPage.trim().toLowerCase()}#${sectionTitle.trim().toLowerCase()}`;
}

function revidLockKey(revid: number): string {
  return `revid:${revid}`;
}

/**
 * 请求级并发键：`<label>:<讨论页>#<章节标题>`。
 *
 * 供 utils/workQueue 的键控队列使用：同一请求（同一讨论页同一章节）严格串行，
 * 不同请求（不同页面或不同章节）可以并行。实时事件路径与兜底扫描路径共用同一键，
 * 因此两条路径天然互斥，不再依赖旧的「撞锁即跳过」语义。
 */
export function requestWorkKey(
  label: string,
  talkPage: string,
  sectionTitle: string,
): string {
  return `${label}:${sectionLockKey(talkPage, sectionTitle)}`;
}

/**
 * 认领一条变更事件：把修订状态写为 `claimed`，并保存原始事件载荷。
 *
 * 这是认领阶段唯一的写库动作。把重活交给并发队列后，事件位点的推进不再等待工作完成，
 * 因此必须靠这次落库保证「至少一次」语义：重启时由 handle.recoverUnfinishedEvents
 * 读回这些行并重新派发（工作阶段会回到当前页面复核，故重复派发幂等）。
 */
export function claimEvent(
  ctx: HandlerContext,
  event: ChangeEvent,
  revid: number,
  actorId?: number,
): void {
  try {
    const claim = ctx.claimStatement ?? ctx.db.prepare(EVENT_CLAIM_SQL);
    claim.run(revid, actorId ?? null, JSON.stringify(event));
  } catch (error) {
    // 认领落库失败不应阻断处理：退化为旧行为（仅损失崩溃恢复能力）
    ctx.log.warn(
      { err: error, revid },
      "failed to persist event claim; crash recovery may miss this event",
    );
  }
}

/**
 * 创建一个独立的请求锁注册表（每个任务一份，互不干扰）。
 */
export function createRequestLockRegistry(
  timeoutMs: number = REQUEST_LOCK_TIMEOUT_MS,
): RequestLockRegistry {
  /** 键为 `talkPage#sectionTitle` 及 `revid:xxx`，值为锁信息 */
  const active = new Map<string, RequestLockInfo>();

  const read = (key: string): boolean => {
    const lock = active.get(key);
    if (!lock) return false;
    if (Date.now() - lock.acquiredAt < timeoutMs) return true;
    active.delete(key); // 超时回收
    return false;
  };

  const isLocked = (
    talkPage: string,
    sectionTitle: string,
    revid?: number,
  ): boolean => {
    if (read(sectionLockKey(talkPage, sectionTitle))) return true;
    if (revid && revid > 0) return read(revidLockKey(revid));
    return false;
  };

  const acquire = (
    talkPage: string,
    sectionTitle: string,
    revid?: number,
    note?: string,
  ): boolean => {
    if (isLocked(talkPage, sectionTitle, revid)) return false;
    const key = sectionLockKey(talkPage, sectionTitle);
    const lock: RequestLockInfo = {
      key,
      acquiredAt: Date.now(),
      revid,
      sectionTitle,
      note,
    };
    active.set(key, lock);
    if (revid && revid > 0) active.set(revidLockKey(revid), lock);
    return true;
  };

  const release = (
    talkPage: string,
    sectionTitle: string,
    revid?: number,
  ): void => {
    active.delete(sectionLockKey(talkPage, sectionTitle));
    if (revid && revid > 0) active.delete(revidLockKey(revid));
  };

  // 注意：返回对象的方法均为独立函数（不依赖 this），可安全解构或在回调中传递
  return {
    timeoutMs,
    isLocked,
    acquire,
    release,
    clear: () => active.clear(),
  };
}

/**
 * 在持有请求锁的前提下执行处理逻辑；已被占用则跳过并返回 false。
 */
export async function runWithRequestLock(
  registry: RequestLockRegistry,
  target: {
    talkPage: string;
    sectionTitle: string;
    revid?: number;
    note?: string;
  },
  log: Logger,
  label: string,
  task: () => Promise<void>,
): Promise<boolean> {
  const { talkPage, sectionTitle, revid, note } = target;

  if (registry.isLocked(talkPage, sectionTitle, revid)) {
    log.info(
      { revid, section: sectionTitle },
      `${label} request is already being processed (locked), skipping duplicate invocation`,
    );
    return false;
  }
  if (!registry.acquire(talkPage, sectionTitle, revid, note)) {
    log.info(
      { revid, section: sectionTitle },
      `${label} failed to acquire lock (already locked), skipping duplicate invocation`,
    );
    return false;
  }

  try {
    await task();
  } finally {
    registry.release(talkPage, sectionTitle, revid);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 2. 章节定位
// ---------------------------------------------------------------------------

/**
 * 从留言提取结果定位「发生修改的二级标题章节」。
 *
 * 依次尝试：按标题+留言内容（或签名时间戳锚点）匹配 → 按标题+序号匹配 → 按留言内容匹配；
 * 若最终落在导言区/非二级标题章节（无 title/header），视为不相关。
 */
export function resolveTargetSection(
  sections: SectionInfo[],
  extraction: Pick<
    CommentExtractionResult,
    "sectionTitle" | "sectionIndex" | "comment" | "sectionFullText"
  >,
  templateName: string,
): SectionInfo | undefined {
  let target = findMatchingSection(
    sections,
    {
      title: extraction.sectionTitle,
      index: extraction.sectionIndex,
      content: extraction.sectionFullText,
    },
    extraction.comment,
    templateName,
  );
  if (!target && extraction.sectionTitle) {
    // 留言内容定位失败时，退回「同名章节 + 序号」定位（不再直接取首个同名章节）
    target = findMatchingSection(
      sections,
      { title: extraction.sectionTitle, index: extraction.sectionIndex },
      undefined,
      templateName,
    );
  }
  if (!target && sections.length > 0) {
    target = sections.find((s) => s.content.includes(extraction.comment));
  }
  return target?.title && target.header ? target : undefined;
}

// ---------------------------------------------------------------------------
// 3. 请求模板提取
// ---------------------------------------------------------------------------

/** 章节内请求模板的解析状态。 */
export type RequestTemplateState = {
  /** 章节内匹配到的模板数量（>1 视为非法请求） */
  count: number;
  /** 首次匹配到的请求模板 */
  template?: ParsedWikiTemplate;
  /** 归一化后的 status 参数（小写、去空白） */
  status: string;
  /** status 已终结（done / not done），无需再次处理 */
  handled: boolean;
};

/** 归一化模板 status 参数。 */
export function normalizeRequestStatus(params: Record<string, string>): string {
  return (params.status ?? "").trim().toLowerCase();
}

/** 判断 status 是否已终结（done / not done）。 */
export function isHandledStatus(status: string): boolean {
  return status === "done" || status === "not done";
}

/**
 * 积压扫描专用判定：只有 status 为空的模板才视为「尚未处理」的积压请求。
 *
 * 与事件流入口的 isHandledStatus（仅 done / not done 终结）不同，积压兜底扫描更保守：
 * 只要章节内模板已写入任何非空 status（含中间态），即视为该章节已被处理过，
 * 不再补处理，也不改写其模板与回复内容。
 */
export function isBacklogPendingStatus(status: string): boolean {
  return status.trim() === "";
}

/**
 * 取出模板参数中的页面名：去除 `[[ ]]` 包裹与 `|显示文本` 后缀。
 */
export function unwrapPageParam(value: string | undefined): string {
  if (!value) return "";
  let v = value.trim();
  if (v.startsWith("[[") && v.endsWith("]]")) v = v.slice(2, -2).trim();
  const pipe = v.indexOf("|");
  if (pipe !== -1) v = v.slice(0, pipe).trim();
  return v;
}

/**
 * 收集模板中的编号参数（如 `article1`…`article20`），去重并去除链括号。
 */
export function collectIndexedParams(
  params: Record<string, string>,
  prefix: string,
  max = 20,
): string[] {
  const out: string[] = [];
  for (let i = 1; i <= max; i++) {
    const value = unwrapPageParam(params[`${prefix}${i}`]);
    if (value) out.push(value);
  }
  return [...new Set(out)];
}

/** 解析指定章节内的请求模板与处理状态。 */
export function readRequestTemplate(
  section: SectionInfo,
  templateName: string,
): RequestTemplateState {
  const templates = parseWikiTemplates(section.content, templateName);
  const template = templates[0];
  const status = template ? normalizeRequestStatus(template.params) : "";
  return {
    count: templates.length,
    template,
    status,
    handled: isHandledStatus(status),
  };
}

// ---------------------------------------------------------------------------
// 4. 回报处理进度：就地更新模板参数并追加回复
// ---------------------------------------------------------------------------

export type RequestSectionRef = {
  title: string;
  index?: number;
  content?: string;
};

export type RequestReplyOptions = {
  /** 请求所在讨论页 */
  talkPage: string;
  /** 请求模板名 */
  templateName: string;
  /** 目标章节（用于在重新读取的最新页面中定位） */
  targetSection: RequestSectionRef;
  /** 触发本次处理的留言正文，用于章节二次定位 */
  comment: string;
  /** 需要写回模板的参数（如 status / resultpage / section / oldid）；省略表示不改模板 */
  templateUpdates?: Record<string, string | undefined>;
  /** 追加到章节末尾的回复文本（含前导换行；省略表示仅更新模板） */
  reply?: string;
  /** 编辑摘要 */
  summary: string;
  /** dry-run 日志文案 */
  dryRunMessage?: string;
  /** dry-run 日志附加上下文 */
  dryRunContext?: Record<string, unknown>;
  /** 幂等记录：把触发本次处理的修订标记为 done */
  event?: {
    revid: number;
    actorId: number;
    inputTokens?: number;
    outputTokens?: number;
    model?: string | null;
  };
};

/**
 * 就地更新请求章节：更新模板参数 + 追加回复文本，并按需记录幂等状态。
 *
 * - 写入前会重新读取最新页面内容并在其中重新定位章节，避免编辑冲突。
 * - dry-run（writeEnabled=false）时不写维基，仅记录日志并返回 null。
 */
export async function replyToRequest(
  ctx: HandlerContext,
  options: RequestReplyOptions,
): Promise<{ newrevid: number | null } | null> {
  const { bot, cfg, log } = ctx;
  const {
    talkPage,
    templateName,
    targetSection,
    comment,
    templateUpdates,
    reply,
    summary,
    event,
  } = options;

  if (!cfg.writeEnabled) {
    log.info(
      {
        revid: event?.revid,
        section: targetSection.title,
        ...options.dryRunContext,
      },
      options.dryRunMessage ?? "[dry-run] request section update skipped",
    );
    return null;
  }

  // 同一讨论页可能同时有多笔请求在各自章节回报（不同章节属于不同的并发键）。
  // 这里按页面串行化「读当前页面 → 就地改写章节」的整个编辑回调，避免丢更新与编辑冲突。
  const editResult = await withWikiPageLock(
    log,
    talkPage,
    "request reply",
    () =>
      bot.edit(talkPage, ({ content }) => {
        const currentSections = parseSections(content);
        const currentSec = findMatchingSection(
          currentSections,
          targetSection,
          comment,
          templateName,
        );
        if (!currentSec) throw new Error("Target section not found");
        const updatedTemplate = templateUpdates
          ? updateWikiTemplate(
              currentSec.content,
              templateName,
              templateUpdates,
            )
          : currentSec.content;
        const updatedSec = `${updatedTemplate.trimEnd()}${reply ?? ""}\n`;
        return {
          text: `${content.slice(0, currentSec.startIndex)}${updatedSec}${content.slice(currentSec.endIndex)}`,
          summary,
          bot: true,
        };
      }),
  );

  const newrevid = editResult.newrevid ?? null;
  if (event && event.revid > 0) {
    const save = ctx.saveStatement ?? ctx.db.prepare(EVENT_SAVE_SQL);
    save.run(
      event.revid,
      "done",
      event.actorId,
      newrevid,
      event.inputTokens ?? 0,
      event.outputTokens ?? 0,
      event.model ?? null,
    );
  }
  return { newrevid };
}

/**
 * 将请求标记为 `status = not done` 并追加上一句说明（各任务统一的拒绝/失败回报方式）。
 */
export async function replyNotDone(
  ctx: HandlerContext,
  options: {
    talkPage: string;
    templateName: string;
    targetSection: RequestSectionRef;
    comment: string;
    /** 说明文案（程序会自动补上 `:` 缩进与换行） */
    replyText: string;
    summary: string;
    /** dry-run 日志文案 */
    dryRunMessage?: string;
    event?: RequestReplyOptions["event"];
  },
): Promise<{ newrevid: number | null } | null> {
  return replyToRequest(ctx, {
    talkPage: options.talkPage,
    templateName: options.templateName,
    targetSection: options.targetSection,
    comment: options.comment,
    templateUpdates: { status: "not done" },
    reply: `\n:${options.replyText}`,
    summary: options.summary,
    dryRunMessage: options.dryRunMessage,
    event: options.event,
  });
}

// ---------------------------------------------------------------------------
// 5. 变更事件 → 请求定位（各任务 Handler 的公共前置流程）
// ---------------------------------------------------------------------------

/** 一条已就绪、可以进入业务处理的模板请求。 */
export type IncomingRequest = {
  /** 触发本次请求的修订版本 */
  revid: number;
  /** 触发修订的编辑者 */
  actor: string;
  actorId: number;
  /** 触发修订的新增留言正文（用于在最新页面中重新定位章节） */
  comment: string;
  /** 请求所在的二级标题章节 */
  targetSection: SectionInfo;
  /** 请求模板 */
  reqTemplate: ParsedWikiTemplate;
  /** 归一化后的 status */
  status: string;
};

export type IncomingRequestOutcome =
  /** 事件不属于本任务监听的讨论页，应交回处理器流水线 */
  | { kind: "not-relevant" }
  /** 属于本任务，但已处理/校验失败，无需继续 */
  | { kind: "ignored" }
  /**
   * 缺少标准模板，需要就地去提示正确用法（dry-run 下仅记录日志）。
   * 提示是一次维基写入，交由工作阶段执行，因此在此携带必要的上下文。
   */
  | {
      kind: "missing-template";
      revid: number;
      actorId: number;
      comment: string;
      targetSection: SectionInfo;
    }
  /** 请求有效，交由业务处理 */
  | { kind: "ready"; request: IncomingRequest };

export type ResolveIncomingRequestOptions = {
  /** 变更事件 */
  event: ChangeEvent;
  /** 受监听的讨论页 */
  talkPage: string;
  /** 请求模板名 */
  templateName: string;
  /** 日志前缀（如 review / afc / aiEdit） */
  label: string;
  /** 缺少标准模板时的回复文案（含前导换行） */
  missingTemplateReply: string;
  /** 缺少标准模板时的编辑摘要 */
  missingTemplateSummary: string;
};

/**
 * 各任务 Handler 的公共前置流程：幂等检查 → 修订校验 → 留言提取 → 章节定位 → 模板解析 →
 * 缺模板提示 → 状态检查 → 请求者身份校验 → 控制页熔断检查 → 当前页面幂等复核。
 */
export async function resolveIncomingRequest(
  ctx: HandlerContext,
  options: ResolveIncomingRequestOptions,
): Promise<IncomingRequestOutcome> {
  const { db, bot, cfg, log } = ctx;
  const {
    event,
    talkPage,
    templateName,
    label,
    missingTemplateReply,
    missingTemplateSummary,
  } = options;

  if (
    !isRelevant(
      event,
      talkPage,
      cfg.wiki.username,
      cfg.wiki.wikiId,
      cfg.events.allowBotEdits,
    )
  ) {
    return { kind: "not-relevant" };
  }

  const revid = event.revision!.new!;
  if (isEventDone(readEventState(db, revid, ctx.seenStatement))) {
    return { kind: "ignored" };
  }

  const rev = await revision(bot, revid);
  if (!rev || rev.actor !== event.user || rev.before === undefined) {
    return { kind: "ignored" };
  }

  const after = rev.after ?? "";
  const extraction = extractCommentDetails(
    rev.before,
    after,
    rev.timestamp,
    cfg.wiki.timestampFormat,
  );
  if (!extraction) return { kind: "ignored" };

  const sections = parseSections(after);
  const targetSection = resolveTargetSection(
    sections,
    extraction,
    templateName,
  );
  if (!targetSection) {
    log.debug({ revid }, `${label} edit not in a level-2 header section`);
    return { kind: "ignored" };
  }

  const state = readRequestTemplate(targetSection, templateName);

  // 缺少标准模板：仅在签名与触发修订的编辑者一致时提示正确用法。
  // 提示本身就是一次维基写入（重活），因此不在认领阶段执行。
  if (state.count === 0) {
    const signedUsers = extractSignatures(extraction.comment);
    if (!isSignatureMatchingActor(signedUsers, rev.actor)) {
      return { kind: "ignored" };
    }

    claimEvent(ctx, event, revid, rev.actorId);
    return {
      kind: "missing-template",
      revid,
      actorId: rev.actorId,
      comment: extraction.comment,
      targetSection,
    };
  }

  // 同一章节不得同时提交多个请求模板
  if (state.count > 1) {
    log.warn(
      { revid, count: state.count, section: targetSection.title },
      `${label}: multiple request templates in single section`,
    );
    return { kind: "ignored" };
  }

  if (state.handled) return { kind: "ignored" };

  // 请求者身份校验：触发修订的编辑者必须与签名一致
  const signedUsers = extractSignatures(extraction.comment);
  if (!isSignatureMatchingActor(signedUsers, rev.actor)) {
    const sectionSignedUsers = extractSignatures(targetSection.content);
    if (!isSignatureMatchingActor(sectionSignedUsers, rev.actor)) {
      log.warn(
        { revid, actor: rev.actor, signedUsers, sectionSignedUsers },
        `${label}: requester signature does not match revision actor, skipping`,
      );
      return { kind: "ignored" };
    }
  }

  if (!(await ctx.canWrite())) {
    log.info({ revid }, `${label} disabled by control page`);
    return { kind: "ignored" };
  }

  // 幂等复核已移到工作阶段（recheckRequestStillPending）：它必须与实际处理同处一把
  // 「同键串行锁」内，才能真正关闭「认领 → 执行」之间被另一路抢先完成的时间窗。

  // 认领：位点推进与工作完成解耦后，靠这次落库保证重启后仍能回收未完成的工作。
  claimEvent(ctx, event, revid, rev.actorId);

  return {
    kind: "ready",
    request: {
      revid,
      actor: rev.actor,
      actorId: rev.actorId,
      comment: extraction.comment,
      targetSection,
      reqTemplate: state.template!,
      status: state.status,
    },
  };
}

/**
 * 工作阶段的幂等复核（尽力而为）。
 *
 * 认领阶段的判定基于触发修订当时的页面内容，但事件可能是位点回放（进程重启、曾在其它实例
 * 上处理过），也可能在认领后被另一路（兜底扫描 / 上一次运行）处理完毕。执行前回到「当前页面」
 * 确认该请求模板仍未处理：只有当当前页面确实还在且状态已终结时才跳过，避免重复送去评测
 * （浪费大量 token）并把回复写进错误章节。页面读取失败或定位不到章节时保持原有行为。
 */
export async function recheckRequestStillPending(
  ctx: HandlerContext,
  options: {
    label: string;
    talkPage: string;
    templateName: string;
    revid: number;
    targetSection: RequestSectionRef;
    comment: string;
    /** 判定「仍未处理」的谓词；默认 status 为 done / not done 即视为已处理 */
    isStillPending?: (status: string) => boolean;
  },
): Promise<boolean> {
  const { bot, log } = ctx;
  const { label, talkPage, templateName, revid, targetSection, comment } =
    options;
  const isStillPending = options.isStillPending ?? ((s) => !isHandledStatus(s));

  try {
    const currentSection = findMatchingSection(
      parseSections(await pageText(bot, talkPage)),
      targetSection,
      comment,
      templateName,
    );
    if (currentSection) {
      const currentState = readRequestTemplate(currentSection, templateName);
      if (currentState.count !== 1 || !isStillPending(currentState.status)) {
        log.info(
          {
            revid,
            section: targetSection.title,
            count: currentState.count,
            status: currentState.status,
          },
          `${label} request is already handled or no longer present on the current page, skipping`,
        );
        return false;
      }
    }
  } catch (err) {
    log.warn(
      { err, revid },
      `${label} failed to re-read talk page for idempotency check`,
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// 6. 积压请求兜底清理
// ---------------------------------------------------------------------------

/**
 * 从讨论页近期修订历史中回溯积压请求的提交者与触发修订号。
 *
 * 优先选择「章节标题出现在内容中且修订作者与签名一致」的修订；否则退回签名用户 + 用户 ID 查询。
 */
export async function resolveBacklogRequester(
  ctx: HandlerContext,
  talkPage: string,
  section: SectionInfo,
  signedUsers: string[],
): Promise<{ actor: string; actorId: number; revid: number }> {
  const { bot, log } = ctx;
  let actor = signedUsers[0] ?? "";
  let actorId = 0;
  let revid = 0;

  try {
    const revsData = await bot.request({
      action: "query",
      prop: "revisions",
      titles: talkPage,
      rvprop: "ids|user|userid|timestamp|content",
      rvslots: "main",
      rvlimit: 50,
      formatversion: 2,
    });
    const pageInfo = revsData.query?.pages?.[0];
    const revs = pageInfo?.revisions ?? [];

    if (revs.length > 0) {
      revid = revs[0].revid; // 默认使用最新修订号

      for (const r of revs) {
        const content = r.slots?.main?.content ?? r.content ?? "";
        if (!content.includes(section.title)) continue;
        if (!r.userid || r.userid <= 0 || !r.user) continue;
        if (
          signedUsers.length === 0 ||
          isSignatureMatchingActor(signedUsers, r.user)
        ) {
          actor = r.user;
          actorId = r.userid;
          revid = r.revid;
          break;
        }
      }
    }
  } catch (err) {
    log.warn(
      { err, section: section.title },
      "failed to fetch talk page revisions for backlog item",
    );
  }

  // 若历史中未能取得 actorId，但有签名用户，则通过 API 补查用户 ID
  if (actorId <= 0 && actor) {
    try {
      const userData = await bot.request({
        action: "query",
        list: "users",
        ususers: actor,
        formatversion: 2,
      });
      const u = userData.query?.users?.[0];
      if (u && u.userid && u.userid > 0) actorId = u.userid;
    } catch (err) {
      log.warn({ err, actor }, "failed to fetch user info for backlog actor");
    }
  }

  return { actor, actorId, revid };
}

export type BacklogSweepOptions = {
  /** 日志前缀（如 review / afc），同时用于日志人读文案 */
  label: string;
  /** 受监听的讨论页 */
  talkPage: string;
  /** 请求模板名 */
  templateName: string;
  /** 该任务的请求锁注册表 */
  lock: RequestLockRegistry;
  /** 处理一条积压请求 */
  process: (request: IncomingRequest) => Promise<void>;
};

/**
 * 扫描讨论页中因网络抖动或异常遗漏的积压请求并补处理（启动时 / 定时兜底）。
 */
export async function sweepBacklogRequests(
  ctx: HandlerContext,
  options: BacklogSweepOptions,
): Promise<void> {
  const { bot, log, canWrite } = ctx;
  const { label, talkPage, templateName, lock, process } = options;

  if (!(await canWrite())) {
    log.info(`${label} backlog cleanup skipped: disabled by control page`);
    return;
  }

  let talkContent: string;
  try {
    talkContent = await pageText(bot, talkPage);
  } catch (err) {
    log.error(
      { err, talkPage },
      `failed to fetch ${label} talk page for backlog cleanup`,
    );
    return;
  }
  if (!talkContent || talkContent.trim().length === 0) return;

  for (const sec of parseSections(talkContent)) {
    if (!sec.title || !sec.header) continue;

    const state = readRequestTemplate(sec, templateName);
    // 积压扫描只处理 status 为空的模板：任何非空 status 都表示该章节已处理过，不得再动
    if (state.count !== 1 || !isBacklogPendingStatus(state.status)) continue;

    if (lock.isLocked(talkPage, sec.title)) {
      log.info(
        { section: sec.title, article: state.template!.params.article },
        `backlog ${label} request is currently being processed (locked), skipping`,
      );
      continue;
    }

    log.info(
      {
        section: sec.title,
        article: state.template!.params.article,
        status: state.status,
      },
      `found backlogged ${label} request, processing...`,
    );

    if (!(await canWrite())) {
      log.info(
        `${label} backlog cleanup aborted midway: disabled by control page`,
      );
      return;
    }

    const signedUsers = extractSignatures(sec.content);
    const requester = await resolveBacklogRequester(
      ctx,
      talkPage,
      sec,
      signedUsers,
    );
    if (!requester.actor || requester.actorId <= 0) {
      log.warn(
        {
          section: sec.title,
          actor: requester.actor,
          actorId: requester.actorId,
        },
        `cannot determine valid requester for backlogged ${label} request, skipping`,
      );
      continue;
    }

    // 与实时事件路径共用「请求键」：同一章节恒串行、不同章节可并行，
    // 因此兜底扫描不会阻塞实时请求，也不会与它们重复处理同一章节。
    await runWork(
      ctx,
      {
        key: requestWorkKey(label, talkPage, sec.title),
        label: `${label} backlog`,
      },
      async () => {
        await runWithRequestLock(
          lock,
          {
            talkPage,
            sectionTitle: sec.title,
            revid: requester.revid > 0 ? requester.revid : undefined,
            note: state.template!.params.article,
          },
          log,
          label,
          async () => {
            // 排队期间实时路径可能已处理完该章节（积压扫描判定更保守：任何非空 status 即视为已处理）
            if (
              !(await recheckRequestStillPending(ctx, {
                label,
                talkPage,
                templateName,
                revid: requester.revid,
                targetSection: sec,
                comment: sec.content,
                isStillPending: isBacklogPendingStatus,
              }))
            ) {
              return;
            }

            try {
              await process({
                revid: requester.revid,
                actor: requester.actor,
                actorId: requester.actorId,
                comment: sec.content,
                targetSection: sec,
                reqTemplate: state.template!,
                status: state.status,
              });
            } catch (err) {
              log.error(
                { err, section: sec.title },
                `error processing backlogged ${label} request`,
              );
            }
          },
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// 7. 模板请求任务处理器工厂
// ---------------------------------------------------------------------------

export type TemplateRequestHandlerOptions = {
  /** 日志前缀，如 review / afc / aiEdit */
  label: string;
  /** 任务是否启用 */
  isEnabled: (cfg: AppConfig) => boolean;
  /** 受监听的讨论页；返回 undefined 视为未配置 */
  talkPage: (cfg: AppConfig) => string | undefined;
  /** 请求模板名；返回 undefined 视为未配置 */
  templateName: (cfg: AppConfig) => string | undefined;
  /** 缺少标准模板时的回复文案（含前导换行） */
  missingTemplateReply: string;
  /** 缺少标准模板时的编辑摘要 */
  missingTemplateSummary: string;
  /** 该任务的请求锁注册表 */
  lock: RequestLockRegistry;
  /** 请求锁的可选附加标识（如请求中的条目名），仅用于排查 */
  note?: (request: IncomingRequest) => string | undefined;
  /** 已就绪请求的业务处理 */
  process: (ctx: HandlerContext, request: IncomingRequest) => Promise<void>;
};

/**
 * 生成一个「模板请求」任务处理器。
 *
 * 两阶段执行：
 * - 认领阶段（`await resolveIncomingRequest`）：只读 + 一次认领落库，毫秒~百毫秒级，
 *   完成即返回 `{ intercepted: true }`，不再把后续事件挡在门外；
 * - 工作阶段（`runWork` 提交）：幂等复核 → 请求互斥锁 → 业务处理，在键控并发队列中执行。
 *
 * 未注入工作队列（ctx.schedule 为空）时 runWork 退化为内联 await，保持旧语义。
 * 任务二、任务三 3-2、任务四的处理器由此统一生成，避免三条链路的入口行为漂移。
 */
export function createTemplateRequestHandler(
  options: TemplateRequestHandlerOptions,
): TaskHandler {
  const {
    label,
    isEnabled,
    talkPage,
    templateName,
    missingTemplateReply,
    missingTemplateSummary,
    lock,
    note,
    process,
  } = options;

  return async (event, ctx) => {
    const { cfg, log } = ctx;

    if (!isEnabled(cfg)) {
      return { intercepted: false };
    }

    const page = talkPage(cfg);
    const template = templateName(cfg);
    if (!page || !template) {
      return { intercepted: false };
    }

    const outcome = await resolveIncomingRequest(ctx, {
      event,
      talkPage: page,
      templateName: template,
      label,
      missingTemplateReply,
      missingTemplateSummary,
    });

    if (outcome.kind === "not-relevant") {
      return { intercepted: false };
    }
    if (outcome.kind === "ignored") {
      return { intercepted: true };
    }

    // 「缺少标准模板」的提示是一次维基写入：同样属于工作阶段
    if (outcome.kind === "missing-template") {
      const { revid, actorId, comment, targetSection } = outcome;
      await runWork(
        ctx,
        {
          key: requestWorkKey(label, page, targetSection.title),
          label: `${label} missing-template`,
          revid,
        },
        async () => {
          if (!cfg.writeEnabled) {
            log.info({ revid }, `[dry-run] ${label} missing-template reply`);
            return;
          }
          if (!(await ctx.canWrite())) return;

          await replyToRequest(ctx, {
            talkPage: page,
            templateName: template,
            targetSection,
            comment,
            reply: missingTemplateReply,
            summary: missingTemplateSummary,
            event: { revid, actorId },
          });
        },
      );
      return { intercepted: true };
    }

    const request = outcome.request;

    await runWork(
      ctx,
      {
        key: requestWorkKey(label, page, request.targetSection.title),
        label: `${label} request`,
        revid: request.revid,
      },
      async () => {
        await runWithRequestLock(
          lock,
          {
            talkPage: page,
            sectionTitle: request.targetSection.title,
            revid: request.revid,
            note: note?.(request),
          },
          log,
          label,
          async () => {
            // 复核与实际处理同处一把锁内，关闭「认领 → 执行」之间的 TOCTOU 窗口
            if (
              !(await recheckRequestStillPending(ctx, {
                label,
                talkPage: page,
                templateName: template,
                revid: request.revid,
                targetSection: request.targetSection,
                comment: request.comment,
              }))
            ) {
              return;
            }

            await process(ctx, request);
          },
        );
      },
    );

    return { intercepted: true };
  };
}
