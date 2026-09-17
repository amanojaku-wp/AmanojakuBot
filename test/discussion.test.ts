import { describe, it, expect } from "vitest";
import {
  addedComment,
  extractCommentDetails,
  formatWikiTimestamp,
  insertReplyIntoContent,
  isRelevant,
  parseSections,
} from "../src/utils/wikitext.js";

describe("discussion filtering & timestamp handling", () => {
  it("formats timestamps according to wiki configuration", () => {
    // 2026-09-14 01:23:45 UTC (Monday / (一))
    const zhDate = new Date("2026-09-14T01:23:45Z");
    expect(formatWikiTimestamp(zhDate, "zhwiki")).toBe(
      "2026年9月14日 (一) 01:23 (UTC)",
    );

    // 2026-06-07 14:14:30 UTC (publictestwiki)
    const testwikiDate = new Date("2026-06-07T14:14:30Z");
    expect(formatWikiTimestamp(testwikiDate, "publictestwiki")).toBe(
      "14:14, 7 June 2026 (UTC)",
    );
  });

  it("extracts appended signed comments at the bottom of the page", () => {
    expect(addedComment("prior", "prior\n\nhello ~~~~")).toBe("hello ~~~~");
    expect(addedComment("prior", "prior\nformatting")).toBeNull();
  });

  it("allows inline comments in the middle of a discussion page (插话) with matching timestamp", () => {
    const before = `== 话题一 ==\nAlice: 第一条留言\n\n== 话题二 ==\nBob: 第二个话题`;
    const after = `== 话题一 ==\nAlice: 第一条留言\n:Charlie: 插话！--[[User:Charlie|Charlie]] 2026年9月14日 (一) 01:23 (UTC)\n\n== 话题二 ==\nBob: 第二个话题`;

    const details = extractCommentDetails(
      before,
      after,
      "2026-09-14T01:23:00Z",
      "zhwiki",
    );
    expect(details).not.toBeNull();
    expect(details?.comment).toBe(
      ":Charlie: 插话！--[[User:Charlie|Charlie]] 2026年9月14日 (一) 01:23 (UTC)",
    );
    expect(details?.sectionTitle).toBe("话题一");
    expect(details?.sectionFullText).toContain("Alice: 第一条留言");
    expect(details?.sectionFullText).toContain("Charlie: 插话！");
  });

  it("recognizes publictestwiki timestamps for inline comments", () => {
    const before = `== Topic 1 ==\nUserA: Hello\n\n== Topic 2 ==\nUserB: World`;
    const after = `== Topic 1 ==\nUserA: Hello\n:UserC: Reply here [[User:UserC|UserC]] 14:14, 7 June 2026 (UTC)\n\n== Topic 2 ==\nUserB: World`;

    const details = extractCommentDetails(
      before,
      after,
      "2026-06-07T14:14:00Z",
      "publictestwiki",
    );
    expect(details).not.toBeNull();
    expect(details?.comment).toBe(
      ":UserC: Reply here [[User:UserC|UserC]] 14:14, 7 June 2026 (UTC)",
    );
    expect(details?.sectionTitle).toBe("Topic 1");
  });

  it("ignores edits with outdated or non-matching timestamps (e.g. typo fixes in old comments)", () => {
    const before = `== 话题 ==\n旧留言错别字 --[[User:Alice|Alice]] 2023年1月1日 (日) 00:00 (UTC)`;
    const after = `== 话题 ==\n旧留言修正字 --[[User:Alice|Alice]] 2023年1月1日 (日) 00:00 (UTC)`;

    const details = extractCommentDetails(
      before,
      after,
      "2026-09-14T01:23:00Z",
      "zhwiki",
    );
    expect(details).toBeNull();
  });

  it("parses sections and inserts reply into the target section correctly", () => {
    const content = `== 话题一 ==\nAlice: 留言 1\n\n== 话题二 ==\nBob: 留言 2`;
    const sections = parseSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("话题一");
    expect(sections[1].title).toBe("话题二");

    const reply = ":机器人回复 --~~~~ <!-- marker -->";
    const updated = insertReplyIntoContent(content, reply, "话题一");
    expect(updated).toBe(
      `== 话题一 ==\nAlice: 留言 1\n:机器人回复 --~~~~ <!-- marker -->\n\n== 话题二 ==\nBob: 留言 2`,
    );
  });

  it("ignores other wikis and namespaces", () => {
    const e = {
      wiki: "zhwiki",
      type: "edit",
      namespace: 3,
      title: "User talk:ExampleBot",
      user: "Visitor",
      revision: { new: 12 },
    };
    expect(isRelevant(e, "User talk:ExampleBot", "ExampleBot")).toBe(true);
    expect(
      isRelevant(
        { ...e, namespace: 0 },
        "User talk:ExampleBot",
        "ExampleBot",
        "zhwiki",
        false,
      ),
    ).toBe(false);
  });
});
