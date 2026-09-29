import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { isValidCron } from "../utils/schedule.js";

/** cron 表达式校验（统一按 UTC 解释，由 utils/schedule 提供） */
const cronExpressionSchema = z
  .string()
  .min(1)
  .refine(isValidCron, "invalid cron expression (UTC timezone)");

/**
 * 机器人全局配置契约定义
 *
 * 核心安全与业务约束：
 * 1. 权限边界隔离：bot 仅允许读写自身所属的用户子页面与讨论页，防止被注入或误写入公共/条目命名空间。
 * 2. 凭据分离：密码与 API Key 通过进程环境变量注入（WIKI_BOT_PASSWORD / OPENAI_API_KEY 等），不落地在 YAML/Git。
 * 3. 默认安全：默认处于 dry-run 模式（writeEnabled: false），只打日志不向维基发起真实写入或消耗额度。
 */
const llmSpecSchema = z.object({
  provider: z.enum(["openai", "google"]),
  model: z.string().min(1),
});

const llmConfigSchema = z.union([llmSpecSchema, z.array(llmSpecSchema).min(1)]);

export type LlmModelSpec = z.infer<typeof llmSpecSchema>;
export type LlmConfig = z.infer<typeof llmConfigSchema>;

/**
 * 将单个或多个 LLM 配置标准化为数组
 */
export function normalizeLlmConfig(
  specific?: LlmConfig,
  fallback?: LlmConfig,
): LlmModelSpec[] {
  const target = specific ?? fallback;
  if (!target) return [];
  return Array.isArray(target) ? target : [target];
}

/**
 * 机器人全局配置契约定义
 *
 * 核心安全与业务约束：
 * 1. 权限边界隔离：bot 仅允许读写自身所属的用户子页面与讨论页，防止被注入或误写入公共/条目命名空间。
 * 2. 凭据分离：密码与 API Key 通过进程环境变量注入（WIKI_BOT_PASSWORD / OPENAI_API_KEY 等），不落地在 YAML/Git。
 * 3. 默认安全：默认处于 dry-run 模式（writeEnabled: false），只打日志不向维基发起真实写入或消耗额度。
 */
export const configSchema = z.object({
  wiki: z.object({
    apiUrl: z.string().url().default("https://zh.wikipedia.org/w/api.php"),
    /** 站点唯一标识符（如 zhwiki），在 Wikimedia EventStreams 模式下用于过滤事件流中的目标站点 */
    wikiId: z.string().min(1).optional(),
    /** 机器人维基用户名（显示名称） */
    username: z.string().min(1),
    /** 登录用户名（若使用了 BotPassword 则形如 `User@botname`，与 username 分离） */
    loginUsername: z.string().min(1).optional(),
    /** 机器人维护者（主人）的 MediaWiki User ID，享有免除每日评审限额的豁免权 */
    ownerUserId: z.number().int().positive().optional(),
    /** 存放运行控制开关的页面（User:AmanojakuBot/control），提供链上熔断/紧急停止机制 */
    controlPage: z.string().regex(/^User:[^/]+\//i),
    /**
     * 维基签名时间戳格式设置：
     * 支持内置预设名称（"zhwiki"、"publictestwiki"、"enwiki"）
     * 或自定义格式字符串（如 "YYYY年M月D日 (dd) HH:mm (UTC)"、"HH:mm, D MMMM YYYY (UTC)"）
     */
    timestampFormat: z.string().min(1).optional(),
    /** 写入使能总开关（支持在 wiki 层级或顶层配置） */
    writeEnabled: z.boolean().default(false),
  }),
  events: z
    .object({
      /** 事件监听模式：zhwiki 默认使用 EventStreams SSE；第三方维基默认使用 RecentChanges 轮询 */
      mode: z.enum(["eventstream", "polling"]).optional(),
      streamUrl: z
        .string()
        .url()
        .default("https://stream.wikimedia.org/v2/stream/recentchange"),
      pollIntervalSeconds: z.number().int().min(10).default(60),
      /** 轮询回溯重叠窗口，防止因 API 复制延迟或时钟偏差遗漏变更 */
      overlapSeconds: z.number().int().min(0).max(300).default(60),
      allowBotEdits: z.boolean().default(false),
    })
    .default({
      streamUrl: "https://stream.wikimedia.org/v2/stream/recentchange",
      pollIntervalSeconds: 60,
      overlapSeconds: 60,
      allowBotEdits: false,
    }),
  storage: z
    .object({
      type: z.string().optional(),
      dbPath: z.string().min(1).default("bot.sqlite"),
    })
    .default({ dbPath: "bot.sqlite" }),
  log: z
    .object({
      level: z.string().default("info"),
      responseTokenOnWiki: z.boolean().default(false),
    })
    .default({ level: "info", responseTokenOnWiki: false }),
  /**
   * 运行时并发与超时约束
   *
   * 「认领」与「执行」解耦后，事件消费不再被单笔耗时评审阻塞，代价是同时会有多笔工作
   * 在跑。这里给出全局闸门，避免打爆 MediaWiki API / LLM 限流：
   * - 工作队列并发上限（异键并行度）；
   * - 单次 LLM 调用超时与 LLM 并发上限；
   * - 队列排队时长告警阈值与运行状态统计间隔。
   */
  runtime: z
    .object({
      /** 后台工作队列的全局并发上限（建议 2~4） */
      workConcurrency: z.number().int().min(1).max(16).default(3),
      /** 任务排队等待超过该时长即输出 warn 日志（秒） */
      slowWaitSeconds: z.number().int().min(1).default(30),
      /** 运行状态（队列深度 / LLM 闸门）统计日志间隔（秒），0 表示关闭 */
      statsIntervalSeconds: z.number().int().min(0).default(300),
      /** 同时进行的 LLM 调用上限 */
      llmMaxConcurrent: z.number().int().min(1).max(16).default(2),
      /** 单次 LLM 调用超时（秒） */
      llmTimeoutSeconds: z.number().int().min(10).default(180),
    })
    .default({
      workConcurrency: 3,
      slowWaitSeconds: 30,
      statsIntervalSeconds: 300,
      llmMaxConcurrent: 2,
      llmTimeoutSeconds: 180,
    }),
  llm: llmConfigSchema.optional(),
  tasks: z
    .object({
      /** 任务一：讨论页自由对话 */
      chat: z
        .object({
          enabled: z.boolean().default(true),
          talkPage: z
            .string()
            .regex(/^User talk:[^/]+(?:\/.+)?$/i)
            .optional(),
          personaPage: z
            .string()
            .regex(/^User:[^/]+\//i)
            .optional(),
          llm: llmConfigSchema.optional(),
        })
        .default({ enabled: true }),
      /** 任务二：应请求条目/草稿校对评审 */
      review: z
        .object({
          enabled: z.boolean().default(true),
          talkPage: z
            .string()
            .regex(/^User talk:[^/]+(?:\/.+)?$/i)
            .optional(),
          rulePage: z
            .string()
            .regex(/^User:[^/]+\//i)
            .optional(),
          template: z.string().min(1).optional(),
          draftNamespace: z
            .union([
              z.number().int().nonnegative(),
              z.array(z.number().int().nonnegative()),
            ])
            .default([2, 118]),
          /** 每个用户每个 UTC 自然日最多成功提交的校对请求数量 */
          userDailyLimit: z.number().int().min(1).default(5),
          /** 兼容旧配置项 dailyLimit */
          dailyLimit: z.number().int().min(1).optional(),
          /** 积压校对请求兜底清理的 cron 表达式（UTC 时区），默认每小时整点 */
          cleanupCron: cronExpressionSchema.default("0 * * * *"),
          llm: llmConfigSchema.optional(),
        })
        .default({
          enabled: true,
          draftNamespace: [2, 118],
          userDailyLimit: 5,
          cleanupCron: "0 * * * *",
        }),
      /** 任务三：近期编辑疑似 AI 辅助内容的人工复核线索报告（默认关闭，需显式启用） */
      aiEdit: z
        .object({
          enabled: z.boolean().default(false),
          /**
           * 3-2 模板请求额外允许的草稿命名空间（与条目命名空间 0 一并接受，可为单个数字或数组）。
           * 3-1 动态扫描仍仅处理主命名空间（条目，ns 0）。
           */
          draftNamespace: z
            .union([
              z.number().int().nonnegative(),
              z.array(z.number().int().nonnegative()),
            ])
            .default([2, 118]),
          /** 按月分段的线索报告页前缀（如 User:AmanojakuBot/task/U3/check），实际写入 <前缀>/YYYY-MM */
          reportPagePrefix: z
            .string()
            .regex(/^User:[^/]+\/.+$/i)
            .optional(),
          /** 跨 3 个不同条目触发线索的用户汇总页（如 User:AmanojakuBot/task/U3/checkuser） */
          usersPage: z
            .string()
            .regex(/^User:[^/]+\/.+$/i)
            .optional(),
          /** 3-1 扫描时用于判断“疑似 AI 线索”的规则页面 */
          rulePage: z
            .string()
            .regex(/^User:[^/]+\//i)
            .optional(),
          /** 静默模式：true 时仅写本地日志，不向维基写入任何报告页（默认安全） */
          silent: z.boolean().default(true),
          /** 3-1 动态扫描的 cron 表达式（UTC 时区），默认每小时整点 */
          cron: cronExpressionSchema.default("0 * * * *"),
          /** 3-1 结构化分析结果的本地 Markdown 调试日志文件路径 */
          debugLog: z.string().min(1).optional(),
          /** 3-2 请求监听所在机器人讨论页（模板请求） */
          talkPage: z
            .string()
            .regex(/^User talk:[^/]+(?:\/.+)?$/i)
            .optional(),
          /** 3-2 请求模板名称 */
          template: z.string().min(1).optional(),
          /** 每次扫描最多送审 LLM 的条目数（同时限制 6 小时窗口与单次扫描预算） */
          maxAnalysesPerWindow: z.number().int().min(1).max(100).default(20),
          /**
           * 记录为有效线索的最低线索强度阈值（0-1）：仅当该次分析确实记录了线索、
           * 且线索强度 >= 该阈值时，才写入 check 页与 checkuser 页。
           */
          minConfidence: z.number().min(0.5).max(1).default(0.85),
          llm: llmConfigSchema.optional(),
        })
        .default({
          enabled: false,
          draftNamespace: [2, 118],
          silent: true,
          cron: "0 * * * *",
          maxAnalysesPerWindow: 20,
          minConfidence: 0.85,
        }),
      /** 任务四：针对新手的条目发布前评审（AfC评审） */
      afc: z
        .object({
          enabled: z.boolean().default(true),
          talkPage: z
            .string()
            .regex(/^User talk:[^/]+(?:\/.+)?$/i)
            .optional(),
          rulePage: z
            .string()
            .regex(/^User:[^/]+\//i)
            .optional(),
          template: z.string().min(1).optional(),
          draftNamespace: z
            .union([
              z.number().int().nonnegative(),
              z.array(z.number().int().nonnegative()),
            ])
            .default([2, 118]),
          /** 每个用户每个 UTC 自然日最多成功提交的发布前评审请求数量 */
          userDailyLimit: z.number().int().min(1).default(50),
          /** 兼容旧配置项 dailyLimit */
          dailyLimit: z.number().int().min(1).optional(),
          /** 积压 AfC 请求兜底清理的 cron 表达式（UTC 时区），默认每小时整点 */
          cleanupCron: cronExpressionSchema.default("0 * * * *"),
          llm: llmConfigSchema.optional(),
        })
        .default({
          enabled: true,
          draftNamespace: [2, 118],
          userDailyLimit: 50,
          cleanupCron: "0 * * * *",
        }),
    })
    .default({
      chat: { enabled: true },
      review: {
        enabled: true,
        draftNamespace: [2, 118],
        userDailyLimit: 5,
        cleanupCron: "0 * * * *",
      },
      aiEdit: {
        enabled: false,
        draftNamespace: [2, 118],
        silent: true,
        cron: "0 * * * *",
        maxAnalysesPerWindow: 20,
        minConfidence: 0.85,
      },
      afc: {
        enabled: true,
        draftNamespace: [2, 118],
        userDailyLimit: 50,
        cleanupCron: "0 * * * *",
      },
    }),
  /** 写入使能总开关（兼容顶层定义） */
  writeEnabled: z.boolean().optional(),
});

export type RawConfig = z.infer<typeof configSchema>;
export type AppConfig = ReturnType<typeof loadConfig>;

/**
 * 加载并严格校验配置文件
 */
export function loadConfig(path = "config.yaml") {
  const parsed = configSchema.parse(YAML.parse(readFileSync(path, "utf8")));
  const user = parsed.wiki.username.replaceAll("_", " ").toLowerCase();

  // 整理 writeEnabled
  const writeEnabled = parsed.wiki.writeEnabled ?? false;

  // 默认 talkPage 和 personaPage
  const chatTalkPage =
    parsed.tasks.chat.talkPage ?? `User talk:${parsed.wiki.username}`;
  const reviewTalkPage =
    parsed.tasks.review.talkPage ?? `User talk:${parsed.wiki.username}/review`;
  const personaPage =
    parsed.tasks.chat.personaPage ??
    `User:${parsed.wiki.username}/config/persona`;
  const reviewRulePage =
    parsed.tasks.review.rulePage ?? `User:${parsed.wiki.username}/task/2/rule`;
  const reviewTemplate =
    parsed.tasks.review.template ??
    `User:${parsed.wiki.username}/template/ReviewRequest`;
  const draftNamespaceRaw = parsed.tasks.review.draftNamespace;
  const reviewDraftNamespaces: number[] = Array.isArray(draftNamespaceRaw)
    ? draftNamespaceRaw
    : [draftNamespaceRaw];
  const reviewUserDailyLimit =
    parsed.tasks.review.userDailyLimit ?? parsed.tasks.review.dailyLimit ?? 5;

  const afcTalkPage =
    parsed.tasks.afc.talkPage ?? `User talk:${parsed.wiki.username}/afc`;
  const afcRulePage =
    parsed.tasks.afc.rulePage ?? `User:${parsed.wiki.username}/task/U4/rule`;
  const afcTemplate =
    parsed.tasks.afc.template ??
    `User:${parsed.wiki.username}/template/ReviewRequest`;
  const afcDraftNamespaceRaw = parsed.tasks.afc.draftNamespace;
  const afcDraftNamespaces: number[] = Array.isArray(afcDraftNamespaceRaw)
    ? afcDraftNamespaceRaw
    : [afcDraftNamespaceRaw];
  const afcUserDailyLimit =
    parsed.tasks.afc.userDailyLimit ?? parsed.tasks.afc.dailyLimit ?? 50;

  const aiEditTalkPage =
    parsed.tasks.aiEdit.talkPage ?? `User talk:${parsed.wiki.username}/ai`;
  const aiEditRulePage =
    parsed.tasks.aiEdit.rulePage ?? `User:${parsed.wiki.username}/task/U3/rule`;
  const aiEditTemplate =
    parsed.tasks.aiEdit.template ??
    `User:${parsed.wiki.username}/template/AIcheck`;
  const aiEditDraftNamespaceRaw = parsed.tasks.aiEdit.draftNamespace;
  const aiEditDraftNamespaces: number[] = Array.isArray(aiEditDraftNamespaceRaw)
    ? aiEditDraftNamespaceRaw
    : [aiEditDraftNamespaceRaw];

  // 校验归属权
  const isBotTalkPage = (p: string) => {
    const target = p.slice(10).replaceAll("_", " ").toLowerCase();
    return target === user || target.startsWith(`${user}/`);
  };

  if (
    !isBotTalkPage(chatTalkPage) ||
    !isBotTalkPage(reviewTalkPage) ||
    !isBotTalkPage(afcTalkPage) ||
    !isBotTalkPage(aiEditTalkPage) ||
    ![
      personaPage,
      parsed.wiki.controlPage,
      reviewRulePage,
      afcRulePage,
      aiEditRulePage,
    ].every((p) =>
      p
        .slice(5)
        .replaceAll("_", " ")
        .toLowerCase()
        .startsWith(user + "/"),
    )
  )
    throw new Error(
      "All writable and control pages must belong to the configured bot",
    );

  if (
    parsed.tasks.aiEdit.enabled &&
    !parsed.tasks.aiEdit.silent &&
    (!parsed.tasks.aiEdit.reportPagePrefix || !parsed.tasks.aiEdit.usersPage)
  )
    throw new Error(
      "AI-edit reports require reportPagePrefix and usersPage when silent=false",
    );

  for (const p of [
    parsed.tasks.aiEdit.reportPagePrefix,
    parsed.tasks.aiEdit.usersPage,
  ].filter((v): v is string => !!v))
    if (
      !p
        .slice(5)
        .replaceAll("_", " ")
        .toLowerCase()
        .startsWith(user + "/")
    )
      throw new Error("AI-edit output pages must belong to the configured bot");

  const isZhwiki = new URL(parsed.wiki.apiUrl).hostname === "zh.wikipedia.org";
  const mode = parsed.events.mode ?? (isZhwiki ? "eventstream" : "polling");
  if (mode === "eventstream" && !parsed.wiki.wikiId && !isZhwiki)
    throw new Error(
      "events.mode=eventstream requires wiki.wikiId on non-zhwiki sites",
    );
  const defaultTimestampFormat = isZhwiki ? "zhwiki" : "publictestwiki";
  const timestampFormat = parsed.wiki.timestampFormat ?? defaultTimestampFormat;

  // 解析各个任务的 LLM 模型链列表
  const globalLlm = parsed.llm;
  const chatModels = normalizeLlmConfig(parsed.tasks.chat.llm, globalLlm);
  const reviewModels = normalizeLlmConfig(parsed.tasks.review.llm, globalLlm);
  const aiEditModels = normalizeLlmConfig(parsed.tasks.aiEdit.llm, globalLlm);
  const afcModels = normalizeLlmConfig(parsed.tasks.afc.llm, globalLlm);

  if (chatModels.length === 0 && parsed.tasks.chat.enabled) {
    throw new Error("No LLM configuration found for task: chat");
  }

  if (aiEditModels.length === 0 && parsed.tasks.aiEdit.enabled) {
    throw new Error("No LLM configuration found for task: aiEdit");
  }

  return {
    ...parsed,
    writeEnabled,
    events: { ...parsed.events, mode },
    wiki: {
      ...parsed.wiki,
      writeEnabled,
      talkPage: chatTalkPage,
      personaPage,
      timestampFormat,
    },
    tasks: {
      chat: {
        ...parsed.tasks.chat,
        talkPage: chatTalkPage,
        personaPage,
        models: chatModels,
      },
      review: {
        ...parsed.tasks.review,
        talkPage: reviewTalkPage,
        rulePage: reviewRulePage,
        template: reviewTemplate,
        draftNamespaces: reviewDraftNamespaces,
        userDailyLimit: reviewUserDailyLimit,
        models: reviewModels,
      },
      aiEdit: {
        ...parsed.tasks.aiEdit,
        rulePage: aiEditRulePage,
        talkPage: aiEditTalkPage,
        template: aiEditTemplate,
        draftNamespaces: aiEditDraftNamespaces,
        models: aiEditModels,
      },
      afc: {
        ...parsed.tasks.afc,
        talkPage: afcTalkPage,
        rulePage: afcRulePage,
        template: afcTemplate,
        draftNamespaces: afcDraftNamespaces,
        userDailyLimit: afcUserDailyLimit,
        models: afcModels,
      },
    },
  };
}
