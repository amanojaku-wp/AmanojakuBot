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
    /** 草稿命名空间 ID，中文维基百科默认为 118（Draft:） */
    draftNamespace: z.number().int().nonnegative().default(118),
    /** 机器人自己的讨论页（如 User talk:AmanojakuBot），任务一聊天与任务二评审的唯一回复目标 */
    talkPage: z.string().regex(/^User talk:[^/]+$/i),
    /** 存放机器人人设提示词的页面（User:AmanojakuBot/persona） */
    personaPage: z.string().regex(/^User:[^/]+\//i),
    /** 存放运行控制开关的页面（User:AmanojakuBot/control），提供链上熔断/紧急停止机制 */
    controlPage: z.string().regex(/^User:[^/]+\//i),
    /**
     * 维基签名时间戳格式设置：
     * 支持内置预设名称（"zhwiki"、"publictestwiki"、"enwiki"）
     * 或自定义格式字符串（如 "YYYY年M月D日 (dd) HH:mm (UTC)"、"HH:mm, D MMMM YYYY (UTC)"）
     */
    timestampFormat: z.string().min(1).optional(),
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
    })
    .default({
      streamUrl: "https://stream.wikimedia.org/v2/stream/recentchange",
      pollIntervalSeconds: 60,
      overlapSeconds: 60,
    }),
  llm: z.object({
    provider: z.enum(["openai", "google"]),
    model: z.string().min(1),
  }),
  storage: z
    .object({ dbPath: z.string().min(1).default("bot.sqlite") })
    .default({ dbPath: "bot.sqlite" }),
  tasks: z
    .object({
      /** 任务二：应请求条目/草稿校对评审 */
      review: z
        .object({
          enabled: z.boolean().default(true),
          /** 非主人用户每个 UTC 自然日允许请求评审的有效页面上限 */
          dailyLimit: z.number().int().min(1).max(10).default(10),
        })
        .default({ enabled: true, dailyLimit: 10 }),
      /** 任务三：近期编辑疑似 AI 辅助内容的人工复核线索报告（默认关闭，需显式启用） */
      aiEdit: z
        .object({
          enabled: z.boolean().default(false),
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
        })
        .default({
          enabled: false,
          maxAnalysesPerWindow: 20,
          minConfidence: 0.85,
        }),
    })
    .default({
      review: { enabled: true, dailyLimit: 10 },
      aiEdit: { enabled: false, maxAnalysesPerWindow: 20, minConfidence: 0.85 },
    }),
  /** 写入使能总开关：必须为 true 且提供密码才允许向维基发起实际编辑 */
  writeEnabled: z.boolean().default(false),
});

export type RawConfig = z.infer<typeof configSchema>;
export type AppConfig = ReturnType<typeof loadConfig>;

/**
 * 加载并严格校验配置文件
 *
 * 关键安全断言：
 * - 强制检查 talkPage、personaPage、controlPage、reportPagePrefix、usersPage 全部归属于机器人自己
 * - 自动推断 zhwiki 默认 EventStreams 与 wikiId，保障非 zhwiki 站点配置的完备性
 */
export function loadConfig(path = "config.yaml") {
  const cfg = configSchema.parse(YAML.parse(readFileSync(path, "utf8")));
  const user = cfg.wiki.username.replaceAll("_", " ").toLowerCase();
  if (
    cfg.wiki.talkPage.slice(10).replaceAll("_", " ").toLowerCase() !== user ||
    ![cfg.wiki.personaPage, cfg.wiki.controlPage].every((p) =>
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
    cfg.tasks.aiEdit.enabled &&
    (!cfg.tasks.aiEdit.reportPagePrefix || !cfg.tasks.aiEdit.usersPage)
  )
    throw new Error("AI-edit reports require reportPagePrefix and usersPage");
  for (const p of [
    cfg.tasks.aiEdit.reportPagePrefix,
    cfg.tasks.aiEdit.usersPage,
  ].filter((v): v is string => !!v))
    if (
      !p
        .slice(5)
        .replaceAll("_", " ")
        .toLowerCase()
        .startsWith(user + "/")
    )
      throw new Error("AI-edit output pages must belong to the configured bot");
  const isZhwiki = new URL(cfg.wiki.apiUrl).hostname === "zh.wikipedia.org";
  const mode = cfg.events.mode ?? (isZhwiki ? "eventstream" : "polling");
  if (mode === "eventstream" && !cfg.wiki.wikiId && !isZhwiki)
    throw new Error(
      "events.mode=eventstream requires wiki.wikiId on non-zhwiki sites",
    );
  const defaultTimestampFormat = isZhwiki ? "zhwiki" : "publictestwiki";
  const timestampFormat = cfg.wiki.timestampFormat ?? defaultTimestampFormat;
  return {
    ...cfg,
    events: { ...cfg.events, mode },
    wiki: {
      ...cfg.wiki,
      wikiId: cfg.wiki.wikiId ?? (isZhwiki ? "zhwiki" : undefined),
      timestampFormat,
    },
  };
}
