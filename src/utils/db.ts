import Database from "better-sqlite3";

/**
 * 数据库 Migration 接口定义
 */
export type Migration = {
  /** 格式如 20260123000000 的版本字符串，用于按升序依次应用 */
  version: string;
  name: string;
  up: (db: Database.Database) => void;
};

/**
 * 机器人的按序数据库迁移列表
 *
 * 迁移历史：
 * - 20260123000000: 初始建表（events, checkpoint, messages, review_*, ai_*, publication）
 * - 20260920000001: events 表新增 input_tokens, output_tokens, model 字段
 * - 20260920000002: 新增 error_logs 错误日志表
 * - 20260924000000: checkpoint 表新增 last_revid 字段
 */
export const MIGRATIONS: Migration[] = [
  {
    version: "20260123000000",
    name: "create_initial_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          revid INTEGER PRIMARY KEY,
          state TEXT NOT NULL,
          actor_id INTEGER,
          reply_revid INTEGER,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS checkpoint (
          name TEXT PRIMARY KEY,
          event_id TEXT,
          timestamp TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY,
          actor_id INTEGER NOT NULL,
          source_revid INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_actor ON messages(actor_id, id);
        CREATE TABLE IF NOT EXISTS review_actions (
          source_revid INTEGER NOT NULL,
          actor_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,
          utc_day TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(source_revid, title)
        );
        CREATE INDEX IF NOT EXISTS review_daily ON review_actions(actor_id, utc_day, kind);
        CREATE TABLE IF NOT EXISTS review_cycles (
          actor_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          first_at TEXT NOT NULL,
          rechecked_at TEXT,
          PRIMARY KEY(actor_id, title)
        );
        CREATE TABLE IF NOT EXISTS ai_findings (
          revid INTEGER PRIMARY KEY,
          actor_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          title TEXT NOT NULL,
          canonical_title TEXT NOT NULL,
          evidence TEXT NOT NULL,
          reason TEXT NOT NULL,
          confidence REAL NOT NULL,
          window_start TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ai_window ON ai_findings(window_start);
        CREATE TABLE IF NOT EXISTS ai_analyzed (
          revid INTEGER PRIMARY KEY,
          window_start TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ai_analyzed_window ON ai_analyzed(window_start);
        CREATE TABLE IF NOT EXISTS ai_report_windows (
          window_start TEXT PRIMARY KEY,
          reported_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS publication (
          page TEXT PRIMARY KEY,
          last_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: "20260920000001",
    name: "add_token_and_model_to_events",
    up: (db) => {
      const tableInfo = db.prepare("PRAGMA table_info(events)").all() as {
        name: string;
      }[];
      const columnNames = new Set(tableInfo.map((col) => col.name));

      if (!columnNames.has("input_tokens")) {
        db.exec("ALTER TABLE events ADD COLUMN input_tokens INTEGER;");
      }
      if (!columnNames.has("output_tokens")) {
        db.exec("ALTER TABLE events ADD COLUMN output_tokens INTEGER;");
      }
      if (!columnNames.has("model")) {
        db.exec("ALTER TABLE events ADD COLUMN model TEXT;");
      }
    },
  },
  {
    version: "20260920000002",
    name: "create_error_logs_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS error_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL DEFAULT 'error',
          message TEXT NOT NULL,
          error_name TEXT,
          error_message TEXT,
          stack TEXT,
          context TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at);
      `);
    },
  },
  {
    version: "20260920000003",
    name: "create_review_requests_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_revid INTEGER NOT NULL UNIQUE,
          actor_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          article TEXT NOT NULL,
          article_revid INTEGER,
          status TEXT NOT NULL,
          result_name TEXT,
          result_section TEXT,
          result_page TEXT,
          result_revid INTEGER,
          reply_revid INTEGER,
          utc_day TEXT NOT NULL,
          review_result_json TEXT,
          error TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          model TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_review_requests_actor_day ON review_requests(actor_id, utc_day, status);
        CREATE INDEX IF NOT EXISTS idx_review_requests_source_revid ON review_requests(source_revid);
      `);
    },
  },
  {
    version: "20260924000000",
    name: "add_last_revid_to_checkpoint",
    up: (db) => {
      const tableInfo = db.prepare("PRAGMA table_info(checkpoint)").all() as {
        name: string;
      }[];
      const columnNames = new Set(tableInfo.map((col) => col.name));

      if (!columnNames.has("last_revid")) {
        db.exec("ALTER TABLE checkpoint ADD COLUMN last_revid INTEGER;");
      }
    },
  },
];

/**
 * 运行数据库迁移，记录已应用版本至 schema_migrations 表
 */
export function runMigrations(
  db: Database.Database,
  migrations = MIGRATIONS,
): { applied: string[]; currentVersion: string | null } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as { version: string }[];
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const sorted = [...migrations].sort((a, b) =>
    a.version.localeCompare(b.version),
  );

  const newlyApplied: string[] = [];
  const recordMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, datetime('now'))",
  );

  for (const m of sorted) {
    if (!appliedSet.has(m.version)) {
      db.transaction(() => {
        m.up(db);
        recordMigration.run(m.version, m.name);
      })();
      newlyApplied.push(m.version);
    }
  }

  const latestRow = db
    .prepare(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    )
    .get() as { version: string } | undefined;

  return {
    applied: newlyApplied,
    currentVersion: latestRow?.version ?? null,
  };
}

/**
 * 获取当前数据库的 schema 版本
 */
export function getSchemaVersion(db: Database.Database): string | null {
  try {
    const row = db
      .prepare(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get() as { version: string } | undefined;
    return row?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * 获取所有已应用的迁移记录列表
 */
export function getAppliedMigrations(
  db: Database.Database,
): { version: string; name: string; applied_at: string }[] {
  try {
    return db
      .prepare(
        "SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC",
      )
      .all() as { version: string; name: string; applied_at: string }[];
  } catch {
    return [];
  }
}

/**
 * 错误日志结构
 */
export type ErrorLogEntry = {
  level?: string;
  message: string;
  error?: unknown;
  context?: unknown;
};

/**
 * 将错误日志记录到数据库 error_logs 表
 */
export function recordError(db: Database.Database, entry: ErrorLogEntry): void {
  try {
    const level = entry.level ?? "error";
    let errorName: string | null = null;
    let errorMessage: string | null = null;
    let stack: string | null = null;

    if (entry.error instanceof Error) {
      errorName = entry.error.name;
      errorMessage = entry.error.message;
      stack = entry.error.stack ?? null;
    } else if (entry.error !== undefined && entry.error !== null) {
      if (typeof entry.error === "object") {
        try {
          errorMessage = JSON.stringify(entry.error);
        } catch {
          errorMessage = String(entry.error);
        }
      } else {
        errorMessage = String(entry.error);
      }
    }

    let contextStr: string | null = null;
    if (entry.context !== undefined && entry.context !== null) {
      try {
        contextStr =
          typeof entry.context === "string"
            ? entry.context
            : JSON.stringify(entry.context);
      } catch {
        contextStr = String(entry.context);
      }
    }

    db.prepare(
      `INSERT INTO error_logs (level, message, error_name, error_message, stack, context, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(level, entry.message, errorName, errorMessage, stack, contextStr);
  } catch (e) {
    console.error("[DB] Failed to record error log into database:", e);
  }
}

/**
 * 事件查询预编译 SQL
 */
export const EVENT_SEEN_SQL = "SELECT state FROM events WHERE revid=?";

/**
 * 事件状态与统计记录保存预编译 SQL（支持 input_tokens, output_tokens, model 更新）
 */
export const EVENT_SAVE_SQL = `INSERT INTO events(revid, state, actor_id, reply_revid, updated_at, input_tokens, output_tokens, model)
VALUES(?, ?, ?, ?, datetime('now'), ?, ?, ?)
ON CONFLICT(revid) DO UPDATE SET
  state = excluded.state,
  reply_revid = excluded.reply_revid,
  updated_at = excluded.updated_at,
  input_tokens = COALESCE(excluded.input_tokens, events.input_tokens),
  output_tokens = COALESCE(excluded.output_tokens, events.output_tokens),
  model = COALESCE(excluded.model, events.model)`;

/**
 * 任务二：条目校对请求记录结构
 */
export type ReviewRequestRecord = {
  id?: number;
  source_revid: number;
  actor_id: number;
  username: string;
  article: string;
  article_revid?: number | null;
  status: "pending" | "completed" | "rejected" | "failed";
  result_name?: string | null;
  result_section?: string | null;
  result_page?: string | null;
  result_revid?: number | null;
  reply_revid?: number | null;
  utc_day: string;
  review_result_json?: string | null;
  error?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  model?: string | null;
  created_at?: string;
  completed_at?: string | null;
};

/**
 * 查询指定用户在特定 UTC 自然日内已成功完成的校对请求数量
 */
export function countDailyCompletedReviews(
  db: Database.Database,
  actorId: number,
  utcDay: string,
): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM review_requests WHERE actor_id = ? AND utc_day = ? AND status = 'completed'",
    )
    .get(actorId, utcDay) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * 保存或更新校对请求记录（基于 source_revid 唯一约束）
 */
export function saveReviewRequest(
  db: Database.Database,
  record: ReviewRequestRecord,
): void {
  db.prepare(
    `INSERT INTO review_requests (
      source_revid, actor_id, username, article, article_revid, status,
      result_name, result_section, result_page, result_revid, reply_revid,
      utc_day, review_result_json, error, input_tokens, output_tokens, model,
      created_at, completed_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      datetime('now'), ?
    ) ON CONFLICT(source_revid) DO UPDATE SET
      article = excluded.article,
      article_revid = COALESCE(excluded.article_revid, review_requests.article_revid),
      status = excluded.status,
      result_name = COALESCE(excluded.result_name, review_requests.result_name),
      result_section = COALESCE(excluded.result_section, review_requests.result_section),
      result_page = COALESCE(excluded.result_page, review_requests.result_page),
      result_revid = COALESCE(excluded.result_revid, review_requests.result_revid),
      reply_revid = COALESCE(excluded.reply_revid, review_requests.reply_revid),
      review_result_json = COALESCE(excluded.review_result_json, review_requests.review_result_json),
      error = excluded.error,
      input_tokens = COALESCE(excluded.input_tokens, review_requests.input_tokens),
      output_tokens = COALESCE(excluded.output_tokens, review_requests.output_tokens),
      model = COALESCE(excluded.model, review_requests.model),
      completed_at = COALESCE(excluded.completed_at, review_requests.completed_at)`,
  ).run(
    record.source_revid,
    record.actor_id,
    record.username,
    record.article,
    record.article_revid ?? null,
    record.status,
    record.result_name ?? null,
    record.result_section ?? null,
    record.result_page ?? null,
    record.result_revid ?? null,
    record.reply_revid ?? null,
    record.utc_day,
    record.review_result_json ?? null,
    record.error ?? null,
    record.input_tokens ?? null,
    record.output_tokens ?? null,
    record.model ?? null,
    record.completed_at ??
      (record.status === "completed" ? new Date().toISOString() : null),
  );
}

/**
 * 根据 source_revid 获取校对请求记录
 */
export function getReviewRequest(
  db: Database.Database,
  sourceRevid: number,
): ReviewRequestRecord | undefined {
  return db
    .prepare("SELECT * FROM review_requests WHERE source_revid = ?")
    .get(sourceRevid) as ReviewRequestRecord | undefined;
}

/**
 * 初始化并维护机器人本地 SQLite 存储，自动应用数据库迁移
 *
 * 架构设计说明：
 * - 采用 WAL (Write-Ahead Logging) 模式保证并发读写的稳定与高性能。
 * - 裸 SQL + 同步 API，保证状态机转移与维基幂等性事务一致。
 * - 每个维基站点隔离使用独立的 SQLite 数据库文件。
 * - 通过 schema_migrations 表执行增量 schema 迁移。
 *
 * 核心数据表业务语义：
 * 1. `events`: 讨论页事件处理状态机与幂等追踪，记录修订版本 ID (revid)、处理状态 (pending/done)、用户 ID、机器人的回复 revid、输入/输出 Token 统计与使用的大模型。
 * 2. `checkpoint`: 事件消费位点记录，保存 EventStreams SSE 的 `event_id` 或轮询的时间戳 `timestamp`，支持断点续传。
 * 3. `messages`: 任务一的短期对话记忆，按用户 ID (`actor_id`) 索引保留最近 8 轮上下文。
 * 4. `review_actions`: 任务二的每日评审操作流水表，按 (actor_id, utc_day, kind) 追踪 UTC 自然日内的有效评审额度消耗。
 * 5. `review_cycles`: 任务二的 30 天条目评审周期表，跟踪用户对特定条目的首次评审时间 (`first_at`) 与唯一一次复查时间 (`rechecked_at`)。
 * 6. `ai_findings`: 任务三检测到的高置信度疑似 AI 编辑线索，按 6 小时 UTC 聚合窗口 (`window_start`) 存储。
 * 7. `ai_analyzed`: 任务三已送审 LLM 的修订版本记录，防止窗口内重复消耗分析配额。
 * 8. `ai_report_windows`: 已完成维基页面汇总发布的 6 小时窗口标记。
 * 9. `publication`: 页面发布冷却时间记录，用于执行“任何报告页面发布间隔不快于 6 小时”的限频要求。
 * 10. `error_logs`: 系统运行异常与错误日志记录表。
 * 11. `schema_migrations`: 数据库版本迁移追踪表。
 */
export function openDb(path = "bot.sqlite"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  runMigrations(db);
  return db;
}
