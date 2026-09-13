import { describe, it, expect } from "vitest";
import { fetchRecentChanges, pollingStart } from "../src/utils/polling.js";
import { loadConfig } from "../src/config/index.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("RecentChanges polling", () => {
  it("filters by title and follows continuation before advancing checkpoint", async () => {
    const calls: Record<string, string | number>[] = [];
    const entry = (revid: number) => ({
      revid,
      type: "edit",
      ns: 3,
      title: "User talk:ExampleBot",
      user: "Visitor",
      timestamp: "2026-01-01T00:00:01Z",
      rcid: revid,
    });
    const request = async (params: Record<string, string | number>) => {
      calls.push(params);
      return calls.length === 1
        ? {
            query: { recentchanges: [entry(1)] },
            continue: { rccontinue: "cursor|1" },
          }
        : { query: { recentchanges: [entry(2)] } };
    };
    const changes = await fetchRecentChanges(
      request,
      "User talk:ExampleBot",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:00Z",
    );
    expect(changes.map((c) => c.revid)).toEqual([1, 2]);
    expect(calls[0].rctitle).toBe("User talk:ExampleBot");
    expect(calls[1].rccontinue).toBe("cursor|1");
    expect(pollingStart("2026-01-01T00:01:00Z", 60)).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
  it("does not succeed with a missing RC query", async () => {
    await expect(
      fetchRecentChanges(async () => ({}), "Talk", "2026-01-01", "2026-01-02"),
    ).rejects.toThrow();
  });
});

describe("event mode defaults", () => {
  it("selects EventStreams only on zh.wikipedia.org and honors override", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-config-"));
    try {
      const file = join(dir, "config.yaml");
      const common =
        "username: ExampleBot\n  talkPage: User talk:ExampleBot\n  personaPage: User:ExampleBot/Persona\n  controlPage: User:ExampleBot/Control\n";
      const write = (apiUrl: string, events = "") =>
        writeFileSync(
          file,
          `wiki:\n  apiUrl: ${apiUrl}\n  ${common}llm:\n  provider: openai\n  model: test\n${events}`,
        );
      write("https://zh.wikipedia.org/w/api.php");
      expect(loadConfig(file).events.mode).toBe("eventstream");
      write("https://publictestwiki.com/w/api.php");
      expect(loadConfig(file).events.mode).toBe("polling");
      write("https://zh.wikipedia.org/w/api.php", "events:\n  mode: polling\n");
      expect(loadConfig(file).events.mode).toBe("polling");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
