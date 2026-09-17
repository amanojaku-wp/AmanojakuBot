import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

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
    })
    .default({ level: "info" }),
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
          draftNamespace: z.number().int().nonnegative().default(118),
          /** 非主人用户每个 UTC 自然日允许请求评审的有效页面上限 */
          dailyLimit: z.number().int().min(1).max(10).default(10),
          llm: llmConfigSchema.optional(),
        })
        .default({ enabled: true, draftNamespace: 118, dailyLimit: 10 }),
      /** 任务三：近期编辑疑似 AI 辅助内容的人工复核线索报告（默认关闭，需显式启用） */
      aiEdit: z
        .object({
          enabled: z.boolean().default(false),
          draftNamespace: z.number().int().nonnegative().default(118),
          /** 按月分段的线索报告页前缀（如 User:AmanojakuBot/AI线索） */
          reportPagePrefix: z
            .string()
            .regex(/^User:[^/]+\/.+$/i)
            .optional(),
          /** 跨 3 个不同条目触发线索的用户汇总页（如 User:AmanojakuBot/AI用户） */
          usersPage: z
            .string()
            .regex(/^User:[^/]+\/.+$/i)
            .optional(),
          /** 每个 6 小时 UTC 聚合窗口内送审 LLM 的最大候选编辑数（防预算超支） */
          maxAnalysesPerWindow: z.number().int().min(1).max(100).default(20),
          /** 记录为有效线索的最低置信度阈值（要求高置信度与严格原文摘录） */
          minConfidence: z.number().min(0.7).max(1).default(0.85),
          llm: llmConfigSchema.optional(),
        })
        .default({
          enabled: false,
          draftNamespace: 118,
          maxAnalysesPerWindow: 20,
          minConfidence: 0.85,
        }),
    })
    .default({
      chat: { enabled: true },
      review: { enabled: true, draftNamespace: 118, dailyLimit: 10 },
      aiEdit: {
        enabled: false,
        draftNamespace: 118,
        maxAnalysesPerWindow: 20,
        minConfidence: 0.85,
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

  // 校验归属权
  const isBotTalkPage = (p: string) => {
    const target = p.slice(10).replaceAll("_", " ").toLowerCase();
    return target === user || target.startsWith(`${user}/`);
  };

  if (
    !isBotTalkPage(chatTalkPage) ||
    !isBotTalkPage(reviewTalkPage) ||
    ![personaPage, parsed.wiki.controlPage].every((p) =>
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
    (!parsed.tasks.aiEdit.reportPagePrefix || !parsed.tasks.aiEdit.usersPage)
  )
    throw new Error("AI-edit reports require reportPagePrefix and usersPage");

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

  if (chatModels.length === 0 && parsed.tasks.chat.enabled) {
    throw new Error("No LLM configuration found for task: chat");
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
        models: reviewModels,
      },
      aiEdit: {
        ...parsed.tasks.aiEdit,
        models: aiEditModels,
      },
    },
  };
}
