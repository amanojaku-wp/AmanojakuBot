import Database from "better-sqlite3";

/**
 * 初始化并维护机器人本地 SQLite 存储
 *
 * 架构设计说明：
 * - 采用 WAL (Write-Ahead Logging) 模式保证并发读写的稳定与高性能。
 * - 裸 SQL + 同步 API，保证状态机转移与维基幂等性事务一致。
 * - 每个维基站点隔离使用独立的 SQLite 数据库文件。
 *
 * 核心数据表业务语义：
 * 1. `events`: 讨论页事件处理状态机与幂等追踪，记录修订版本 ID (revid)、处理状态 (pending/done)、用户 ID 及机器人的回复 revid。
 * 2. `checkpoint`: 事件消费位点记录，保存 EventStreams SSE 的 `event_id` 或轮询的时间戳 `timestamp`，支持断点续传。
 * 3. `messages`: 任务一的短期对话记忆，按用户 ID (`actor_id`) 索引保留最近 8 轮上下文。
 * 4. `review_actions`: 任务二的每日评审操作流水表，按 (actor_id, utc_day, kind) 追踪 UTC 自然日内的有效评审额度消耗。
 * 5. `review_cycles`: 任务二的 30 天条目评审周期表，跟踪用户对特定条目的首次评审时间 (`first_at`) 与唯一一次复查时间 (`rechecked_at`)。
 * 6. `ai_findings`: 任务三检测到的高置信度疑似 AI 编辑线索，按 6 小时 UTC 聚合窗口 (`window_start`) 存储。
 * 7. `ai_analyzed`: 任务三已送审 LLM 的修订版本记录，防止窗口内重复消耗分析配额。
 * 8. `ai_report_windows`: 已完成维基页面汇总发布的 6 小时窗口标记。
 * 9. `publication`: 页面发布冷却时间记录，用于执行“任何报告页面发布间隔不快于 6 小时”的限频要求。
 */
export function openDb(path = "bot.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS events (revid INTEGER PRIMARY KEY, state TEXT NOT NULL, actor_id INTEGER, reply_revid INTEGER, updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS checkpoint (name TEXT PRIMARY KEY, event_id TEXT, timestamp TEXT);
 CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL, source_revid INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS messages_actor ON messages(actor_id,id);
 CREATE TABLE IF NOT EXISTS review_actions (source_revid INTEGER NOT NULL, actor_id INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, utc_day TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_revid,title));
 CREATE INDEX IF NOT EXISTS review_daily ON review_actions(actor_id,utc_day,kind);
 CREATE TABLE IF NOT EXISTS review_cycles (actor_id INTEGER NOT NULL, title TEXT NOT NULL, first_at TEXT NOT NULL, rechecked_at TEXT, PRIMARY KEY(actor_id,title));
 CREATE TABLE IF NOT EXISTS ai_findings (revid INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL, username TEXT NOT NULL, title TEXT NOT NULL, canonical_title TEXT NOT NULL, evidence TEXT NOT NULL, reason TEXT NOT NULL, confidence REAL NOT NULL, window_start TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS ai_window ON ai_findings(window_start);
 CREATE TABLE IF NOT EXISTS ai_analyzed (revid INTEGER PRIMARY KEY, window_start TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS ai_analyzed_window ON ai_analyzed(window_start);
 CREATE TABLE IF NOT EXISTS ai_report_windows (window_start TEXT PRIMARY KEY, reported_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS publication (page TEXT PRIMARY KEY, last_at TEXT NOT NULL);
 `);
  return db;
}
