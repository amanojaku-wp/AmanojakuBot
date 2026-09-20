import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  openDb,
  runMigrations,
  getSchemaVersion,
  getAppliedMigrations,
  recordError,
  countDailyCompletedReviews,
  saveReviewRequest,
  getReviewRequest,
  EVENT_SAVE_SQL,
  EVENT_SEEN_SQL,
  MIGRATIONS,
} from "../src/utils/db.js";

describe("Database migrations and schema management", () => {
  it("initializes a fresh database and applies all migrations", () => {
    const db = openDb(":memory:");
    const currentVersion = getSchemaVersion(db);
    expect(currentVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);

    const applied = getAppliedMigrations(db);
    expect(applied.length).toBe(MIGRATIONS.length);
    expect(applied.map((m) => m.version)).toEqual([
      "20260123000000",
      "20260920000001",
      "20260920000002",
      "20260920000003",
    ]);
  });

  it("is idempotent when runMigrations is executed multiple times", () => {
    const db = openDb(":memory:");
    const secondRun = runMigrations(db);
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.currentVersion).toBe("20260920000003");
  });

  it("applies migrations incrementally to an older database", () => {
    const db = new Database(":memory:");
    // Manually apply first migration only
    MIGRATIONS[0].up(db);
    db.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at) VALUES ('20260123000000', 'create_initial_tables', datetime('now'));
    `);

    // Initially events table has no input_tokens column
    let tableInfo = db.prepare("PRAGMA table_info(events)").all() as {
      name: string;
    }[];
    expect(tableInfo.some((c) => c.name === "input_tokens")).toBe(false);

    // Run migrations
    const result = runMigrations(db);
    expect(result.applied).toEqual([
      "20260920000001",
      "20260920000002",
      "20260920000003",
    ]);

    // Now events table has input_tokens, output_tokens, model columns
    tableInfo = db.prepare("PRAGMA table_info(events)").all() as {
      name: string;
    }[];
    expect(tableInfo.some((c) => c.name === "input_tokens")).toBe(true);
    expect(tableInfo.some((c) => c.name === "output_tokens")).toBe(true);
    expect(tableInfo.some((c) => c.name === "model")).toBe(true);
  });
});

describe("Events token and model tracking", () => {
  it("saves and updates input_tokens, output_tokens, and model", () => {
    const db = openDb(":memory:");
    const save = db.prepare(EVENT_SAVE_SQL);
    const seen = db.prepare(EVENT_SEEN_SQL);

    // Save pending event with token usage and model
    save.run(1001, "pending", 42, null, 1500, 320, "openai/gpt-5.6-luna");

    const row = db
      .prepare(
        "SELECT revid, state, actor_id, reply_revid, input_tokens, output_tokens, model FROM events WHERE revid=1001",
      )
      .get() as {
      revid: number;
      state: string;
      actor_id: number;
      reply_revid: number | null;
      input_tokens: number;
      output_tokens: number;
      model: string;
    };

    expect(row).toEqual({
      revid: 1001,
      state: "pending",
      actor_id: 42,
      reply_revid: null,
      input_tokens: 1500,
      output_tokens: 320,
      model: "openai/gpt-5.6-luna",
    });

    expect(seen.get(1001)).toEqual({ state: "pending" });

    // Transition to done, preserving existing tokens/model if null passed
    save.run(1001, "done", 42, 2002, null, null, null);

    const updatedRow = db
      .prepare(
        "SELECT revid, state, actor_id, reply_revid, input_tokens, output_tokens, model FROM events WHERE revid=1001",
      )
      .get() as typeof row;

    expect(updatedRow).toEqual({
      revid: 1001,
      state: "done",
      actor_id: 42,
      reply_revid: 2002,
      input_tokens: 1500,
      output_tokens: 320,
      model: "openai/gpt-5.6-luna",
    });
  });
});

describe("Error logging into database", () => {
  it("records error logs with error object and context into error_logs table", () => {
    const db = openDb(":memory:");

    const testError = new Error("MediaWiki API timeout");
    recordError(db, {
      level: "error",
      message: "handler execution failed",
      error: testError,
      context: { revid: 5555, user: "Alice" },
    });

    const rows = db.prepare("SELECT * FROM error_logs").all() as {
      id: number;
      level: string;
      message: string;
      error_name: string;
      error_message: string;
      stack: string;
      context: string;
      created_at: string;
    }[];

    expect(rows.length).toBe(1);
    expect(rows[0].level).toBe("error");
    expect(rows[0].message).toBe("handler execution failed");
    expect(rows[0].error_name).toBe("Error");
    expect(rows[0].error_message).toBe("MediaWiki API timeout");
    expect(rows[0].stack).toContain("Error: MediaWiki API timeout");
    expect(JSON.parse(rows[0].context)).toEqual({ revid: 5555, user: "Alice" });
  });

  it("handles string errors and non-Error objects gracefully", () => {
    const db = openDb(":memory:");

    recordError(db, {
      level: "fatal",
      message: "Unexpected crash",
      error: "String error message",
      context: "raw-string-context",
    });

    const row = db
      .prepare("SELECT * FROM error_logs WHERE level='fatal'")
      .get() as {
      level: string;
      message: string;
      error_name: string | null;
      error_message: string;
      context: string;
    };

    expect(row.level).toBe("fatal");
    expect(row.message).toBe("Unexpected crash");
    expect(row.error_name).toBeNull();
    expect(row.error_message).toBe("String error message");
    expect(row.context).toBe("raw-string-context");
  });
});

describe("Review requests persistence and quota tracking", () => {
  it("tracks daily quota and saves request states", () => {
    const db = openDb(":memory:");
    const today = "2026-09-20";

    expect(countDailyCompletedReviews(db, 100, today)).toBe(0);

    saveReviewRequest(db, {
      source_revid: 101,
      actor_id: 100,
      username: "Alice",
      article: "条目A",
      status: "completed",
      result_name: "条目A",
      result_section: "2026年9月20日",
      result_page: "User talk:AmanojakuBot/review/条目A",
      result_revid: 201,
      reply_revid: 202,
      utc_day: today,
    });

    expect(countDailyCompletedReviews(db, 100, today)).toBe(1);
    expect(countDailyCompletedReviews(db, 200, today)).toBe(0);

    // Save a rejected request, should not count towards quota
    saveReviewRequest(db, {
      source_revid: 102,
      actor_id: 100,
      username: "Alice",
      article: "不存在条目",
      status: "rejected",
      utc_day: today,
    });

    expect(countDailyCompletedReviews(db, 100, today)).toBe(1);

    const saved = getReviewRequest(db, 101);
    expect(saved?.article).toBe("条目A");
    expect(saved?.status).toBe("completed");
  });
});
