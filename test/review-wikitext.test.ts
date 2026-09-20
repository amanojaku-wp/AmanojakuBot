import { describe, it, expect } from "vitest";
import {
  parseWikiTemplates,
  updateWikiTemplate,
  extractSignatures,
  isSignatureMatchingActor,
  generateUniqueSectionTitle,
  formatReviewResultWikitext,
  parseSections,
  findMatchingSection,
  type ReviewResult,
} from "../src/utils/wikitext.js";

describe("Review Wikitext utilities", () => {
  it("finds the exact matching section when multiple sections share the same title", () => {
    const wikitext = `== 测试条目 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status = done
| oldid = 11111
}}
:已完成校对。~~~~

== 测试条目 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
第二次请求校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)`;

    const sections = parseSections(wikitext);
    expect(sections.length).toBe(2);

    // Matching by new comment
    const matchedByComment = findMatchingSection(
      sections,
      { title: "测试条目" },
      "第二次请求校对--[[User:Alice|Alice]] 2026年9月20日 (日) 12:00 (UTC)",
      "User:AmanojakuBot/template/ReviewRequest",
    );
    expect(matchedByComment).toBeDefined();
    expect(matchedByComment?.index).toBe(1);

    // Matching by unprocessed status when no comment provided
    const matchedByUnprocessed = findMatchingSection(
      sections,
      { title: "测试条目" },
      undefined,
      "User:AmanojakuBot/template/ReviewRequest",
    );
    expect(matchedByUnprocessed).toBeDefined();
    expect(matchedByUnprocessed?.index).toBe(1);
  });

  it("parses standard ReviewRequest templates correctly", () => {
    const wikitext = `== 请求章节 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
请帮忙校对，谢谢！--[[User:Example|Example]] 2026年9月20日 (日) 12:00 (UTC)`;

    const templates = parseWikiTemplates(
      wikitext,
      "User:AmanojakuBot/template/ReviewRequest",
    );

    expect(templates.length).toBe(1);
    expect(templates[0].params.article).toBe("测试条目");
    expect(templates[0].params.status).toBe("");
  });

  it("handles case-insensitivity and whitespace in template names and parameters", () => {
    const wikitext = `{{ user:AmanojakuBot/template/reviewrequest | article = [[ 用户草稿 ]] | status = done }}`;
    const templates = parseWikiTemplates(
      wikitext,
      "User:AmanojakuBot/template/ReviewRequest",
    );

    expect(templates.length).toBe(1);
    expect(templates[0].params.article).toBe("[[ 用户草稿 ]]");
    expect(templates[0].params.status).toBe("done");
  });

  it("updates template parameters cleanly", () => {
    const wikitext = `== 测试 ==
{{User:AmanojakuBot/template/ReviewRequest
| article = 测试条目
| status =
}}
留言--[[User:Alice|Alice]] ~~~~~`;

    const updated = updateWikiTemplate(
      wikitext,
      "User:AmanojakuBot/template/ReviewRequest",
      {
        status: "done",
        oldid: "123456",
        section: "2026年9月20日",
        resultpage: "测试条目",
      },
    );

    expect(updated).toContain("| status = done");
    expect(updated).toContain("| oldid = 123456");
    expect(updated).toContain("| section = 2026年9月20日");
    expect(updated).toContain("| resultpage = 测试条目");
    expect(updated).toContain("留言--[[User:Alice|Alice]]");
  });

  it("extracts signatures and matches revision actor", () => {
    const comment1 =
      "请校对。--[[User:TestUser|TestUser]] 2026年9月20日 (日) 00:00 (UTC)";
    const sigs1 = extractSignatures(comment1);
    expect(sigs1).toContain("TestUser");
    expect(isSignatureMatchingActor(sigs1, "TestUser")).toBe(true);
    expect(isSignatureMatchingActor(sigs1, "AnotherUser")).toBe(false);

    const comment2 =
      "[[用户:ChineseUser|中文]] ([[User talk:ChineseUser|对话]])";
    const sigs2 = extractSignatures(comment2);
    expect(sigs2).toContain("ChineseUser");
    expect(isSignatureMatchingActor(sigs2, "ChineseUser")).toBe(true);
  });

  it("generates unique section titles without collision", () => {
    const existing = ["2026年9月20日", "2026年9月20日 (2)"];
    expect(generateUniqueSectionTitle(existing, "2026年9月20日")).toBe(
      "2026年9月20日 (3)",
    );
    expect(generateUniqueSectionTitle(existing, "2026年9月21日")).toBe(
      "2026年9月21日",
    );
  });

  it("formats structured ReviewResult to Wikitext properly", () => {
    const sampleResult: ReviewResult = {
      summary: "条目整体结构清晰，但存在几处错别字和维基语法错误。",
      issues: [
        {
          severity: "confirmed",
          category: "language",
          location: "导言区第二段",
          originalText: "该项目于2020年建立",
          description: "缺少句号",
          suggestion: "在句末补全句号。",
        },
        {
          severity: "suggestion",
          category: "structure",
          description: "建议增加参考资料章节",
        },
      ],
    };

    const formatted = formatReviewResultWikitext(sampleResult);
    expect(formatted).toContain("'''【校对概述】'''");
    expect(formatted).toContain("条目整体结构清晰");
    expect(formatted).toContain("'''［确认问题］'''（语言文字）");
    expect(formatted).toContain("导言区第二段");
    expect(formatted).toContain("<nowiki>该项目于2020年建立</nowiki>");
    expect(formatted).toContain("'''［改进建议］'''（结构与排版）");
    expect(formatted).not.toContain("~~~~");
  });
});
