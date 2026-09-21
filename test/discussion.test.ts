import { describe, it, expect } from "vitest";
import {
  addedComment,
  extractCommentDetails,
  formatDiscussionReply,
  formatWikiTimestamp,
  getCommentIndentLevel,
  insertReplyIntoContent,
  isRelevant,
  parseSections,
} from "../src/utils/wikitext.js";
import {
  addTokenUsage,
  createTokenUsage,
  formatTokenUsage,
} from "../src/utils/llm.js";

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

  it("calculates indentation levels and formats outdent when exceeding 8", () => {
    expect(getCommentIndentLevel("Hello world")).toBe(0);
    expect(getCommentIndentLevel(":First reply")).toBe(1);
    expect(getCommentIndentLevel(":::Third reply")).toBe(3);
    expect(getCommentIndentLevel("::::::::Level 8 reply")).toBe(8);
    expect(getCommentIndentLevel(":::::::::Level 9 reply")).toBe(9);

    const marker = "<!-- marker -->";
    // 0 -> 1 level (:)
    expect(formatDiscussionReply("回复内容", 0, marker)).toBe(
      ":回复内容 —~~~~ <!-- marker -->",
    );
    // 1 -> 2 level (::)
    expect(formatDiscussionReply("回复内容", 1, marker)).toBe(
      "::回复内容 —~~~~ <!-- marker -->",
    );
    // 7 -> 8 level (::::::::)
    expect(formatDiscussionReply("回复内容", 7, marker)).toBe(
      "::::::::回复内容 —~~~~ <!-- marker -->",
    );
    // 8 -> 9 level (> 8) -> outdent to 0
    expect(formatDiscussionReply("回复内容", 8, marker)).toBe(
      "{{Outdent|8}}\n回复内容 —~~~~ <!-- marker -->",
    );
    // 9 -> 10 level (> 8) -> outdent to 0
    expect(formatDiscussionReply("回复内容", 9, marker)).toBe(
      "{{Outdent|8}}\n回复内容 —~~~~ <!-- marker -->",
    );
  });

  it("cleans AI-generated signatures and leading colons properly", () => {
    const marker = "<!-- marker -->";

    // Clean trailing signatures like --~~~~, —~~~~, ~~~~
    expect(formatDiscussionReply("这是回复 --~~~~", 0, marker)).toBe(
      ":这是回复 —~~~~ <!-- marker -->",
    );
    expect(formatDiscussionReply("这是回复 — ~~~~", 0, marker)).toBe(
      ":这是回复 —~~~~ <!-- marker -->",
    );
    expect(formatDiscussionReply("这是回复:: —~~~~", 2, marker)).toBe(
      ":::这是回复 —~~~~ <!-- marker -->",
    );
    expect(
      formatDiscussionReply(
        "四就是四。:: —[[U:AmanojakuBot|听话的天邪鬼Bot]] <small>([[UT:AmanojakuBot|人机对话]])</small> 2026年9月21日 (一) 00:40 (UTC)",
        2,
        marker,
        "AmanojakuBot",
      ),
    ).toBe(":::四就是四。 —~~~~ <!-- marker -->");
    expect(formatDiscussionReply("第一行回复\n::: —~~~~", 2, marker)).toBe(
      ":::第一行回复 —~~~~ <!-- marker -->",
    );
    expect(
      formatDiscussionReply(
        "这是回复\n--[[User:Bot|Bot]]（留言） 2026年9月21日 (一) 08:00 (UTC)",
        0,
        marker,
        "Bot",
      ),
    ).toBe(":这是回复 —~~~~ <!-- marker -->");

    // Preserve user mentions when botUsername is provided
    expect(
      formatDiscussionReply(
        "正如 [[User:Alice|Alice]] 在 2026年9月20日 所提到的那样，这个方案可行。",
        1,
        marker,
        "AmanojakuBot",
      ),
    ).toBe(
      "::正如 [[User:Alice|Alice]] 在 2026年9月20日 所提到的那样，这个方案可行。 —~~~~ <!-- marker -->",
    );

    // Clean AI-generated colons on each line
    const aiColoned = ":第一行说明\n:第二行说明\n::第三行列表";
    expect(formatDiscussionReply(aiColoned, 1, marker)).toBe(
      "::第一行说明\n::第二行说明\n::第三行列表 —~~~~ <!-- marker -->",
    );
  });

  it("preserves internal line formatting inside multiline tags without adding colons", () => {
    const marker = "<!-- marker -->";
    const codeReply = `请参考以下示例代码：
<syntaxhighlight lang="typescript">
function sum(a: number, b: number): number {
    return a + b;
}
</syntaxhighlight>
以及数学公式：
<math>
E = mc^2
</math>
还有预格式化文本：
<pre>
line 1
line 2
</pre>
希望对您有帮助！`;

    const formatted = formatDiscussionReply(codeReply, 1, marker);
    expect(formatted).toBe(`::请参考以下示例代码：
::<syntaxhighlight lang="typescript">
function sum(a: number, b: number): number {
    return a + b;
}
</syntaxhighlight>
::以及数学公式：
::<math>
E = mc^2
</math>
::还有预格式化文本：
::<pre>
line 1
line 2
</pre>
::希望对您有帮助！ —~~~~ <!-- marker -->`);
  });

  it("inserts reply directly on the next line following target comment", () => {
    const content = `== 话题一 ==\nAlice: 留言 1\n:Charlie: 插话！\n:Eve: 后续留言\n\n== 话题二 ==\nBob: 留言 2`;
    const targetComment = ":Charlie: 插话！";
    const reply = "::机器人回复 --~~~~ <!-- marker -->";

    const updated = insertReplyIntoContent(
      content,
      reply,
      "话题一",
      targetComment,
    );
    expect(updated).toBe(
      `== 话题一 ==\nAlice: 留言 1\n:Charlie: 插话！\n::机器人回复 --~~~~ <!-- marker -->\n:Eve: 后续留言\n\n== 话题二 ==\nBob: 留言 2`,
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

  it("accumulates and formats token usage correctly", () => {
    const usage = createTokenUsage();
    expect(formatTokenUsage(usage)).toBe("I0/O0/T0");

    addTokenUsage(usage, { inputTokens: 1234, outputTokens: 567 });
    expect(formatTokenUsage(usage)).toBe("I1234/O567/T1801");

    addTokenUsage(usage, {
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
    });
    expect(formatTokenUsage(usage)).toBe("I1334/O767/T2101");
  });
});
