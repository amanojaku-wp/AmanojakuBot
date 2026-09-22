import { describe, it, expect } from "vitest";
import {
  addedComment,
  extractCommentDetails,
  formatDiscussionReply,
  formatWikiTimestamp,
  getCommentIndentLevel,
  hasDiscussionComments,
  insertReplyIntoContent,
  isRelevant,
  parseDiscussionThread,
  parseSections,
  parseStructuredComment,
  parseStructuredDiscussionPage,
  type StructuredDiscussionSection,
} from "../src/utils/wikitext.js";
import {
  formatStructuredCurrentMessage,
  formatStructuredDiscussionContext,
} from "../src/tasks/chat.js";
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
      ":回复内容 ~~~~ <!-- marker -->",
    );
    // 1 -> 2 level (::)
    expect(formatDiscussionReply("回复内容", 1, marker)).toBe(
      "::回复内容 ~~~~ <!-- marker -->",
    );
    // 7 -> 8 level (::::::::)
    expect(formatDiscussionReply("回复内容", 7, marker)).toBe(
      "::::::::回复内容 ~~~~ <!-- marker -->",
    );
    // 8 -> 9 level (> 8) -> outdent to 0
    expect(formatDiscussionReply("回复内容", 8, marker)).toBe(
      "{{Outdent|8}}\n回复内容 ~~~~ <!-- marker -->",
    );
    // 9 -> 10 level (> 8) -> outdent to 0
    expect(formatDiscussionReply("回复内容", 9, marker)).toBe(
      "{{Outdent|9}}\n回复内容 ~~~~ <!-- marker -->",
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

  it("parses single comments into structured author, timestamp, indent, and clean body", () => {
    const raw =
      ":Charlie: 插话！--[[User:Charlie|Charlie]] 2026年9月14日 (一) 01:23 (UTC)";
    const parsed = parseStructuredComment(raw);
    expect(parsed.author).toBe("Charlie");
    expect(parsed.timestamp).toBe("2026年9月14日 (一) 01:23 (UTC)");
    expect(parsed.indentLevel).toBe(1);
    expect(parsed.text).toBe("Charlie: 插话！");

    // IP user signature
    const ipRaw =
      "::匿名意见。 --[[Special:Contributions/192.0.2.1|192.0.2.1]] 2026年9月14日 (一) 02:00 (UTC)";
    const ipParsed = parseStructuredComment(ipRaw);
    expect(ipParsed.author).toBe("192.0.2.1");
    expect(ipParsed.timestamp).toBe("2026年9月14日 (一) 02:00 (UTC)");
    expect(ipParsed.indentLevel).toBe(2);
    expect(ipParsed.text).toBe("匿名意见。");

    // Unsigned template
    const unsignedRaw =
      ":未签名内容。{{unsigned|Eve|2026年9月14日 (一) 03:00 (UTC)}}";
    const unsignedParsed = parseStructuredComment(unsignedRaw);
    expect(unsignedParsed.author).toBe("Eve");
    expect(unsignedParsed.timestamp).toBe("2026年9月14日 (一) 03:00 (UTC)");
    expect(unsignedParsed.indentLevel).toBe(1);
    expect(unsignedParsed.text).toBe("未签名内容。");

    // Preserves body mentions of other users without confusing author
    const mentionRaw =
      ":正如 [[User:Bob|Bob]] 所述，这个方案可行。 --[[User:Alice|Alice]] 2026年9月14日 (一) 01:00 (UTC)";
    const mentionParsed = parseStructuredComment(mentionRaw);
    expect(mentionParsed.author).toBe("Alice");
    expect(mentionParsed.timestamp).toBe("2026年9月14日 (一) 01:00 (UTC)");
    expect(mentionParsed.text).toBe(
      "正如 [[User:Bob|Bob]] 所述，这个方案可行。",
    );

    // Multiple user mentions in body and backward user link lookup
    const multiMentionRaw =
      ":{{ping|User1}} 感谢 [[User:User2|二号用户]] 与 [[User:User3]] 的建议。 --[[User:AuthorUser|签名]]（[[User talk:AuthorUser|讨论]]） 2026年9月14日 (一) 01:30 (UTC)";
    const multiMentionParsed = parseStructuredComment(multiMentionRaw);
    expect(multiMentionParsed.author).toBe("AuthorUser");
    expect(multiMentionParsed.timestamp).toBe("2026年9月14日 (一) 01:30 (UTC)");
    expect(multiMentionParsed.text).toBe(
      "{{ping|User1}} 感谢 [[User:User2|二号用户]] 与 [[User:User3]] 的建议。",
    );

    // Signature with custom styling/span/font/small tags around links
    const styledSigRaw =
      ':我也赞同这个观点。<span style="color:#007acc;">--[[User:StyledUser|风格化用户]]</span> <small>([[User talk:StyledUser|留言]])</small> 2026年9月14日 (一) 01:45 (UTC)';
    const styledSigParsed = parseStructuredComment(styledSigRaw);
    expect(styledSigParsed.author).toBe("StyledUser");
    expect(styledSigParsed.timestamp).toBe("2026年9月14日 (一) 01:45 (UTC)");
    expect(styledSigParsed.text).toBe("我也赞同这个观点。");

    // Unexpanded signature with fallback
    const tildeRaw = ":请问在吗？ --~~~~";
    const tildeParsed = parseStructuredComment(tildeRaw, {
      defaultAuthor: "David",
      defaultTimestamp: "2026年9月14日 (一) 04:00 (UTC)",
    });
    expect(tildeParsed.author).toBe("David");
    expect(tildeParsed.timestamp).toBe("2026年9月14日 (一) 04:00 (UTC)");
    expect(tildeParsed.text).toBe("请问在吗？");
  });

  it("parses multi-turn discussion threads into structured comments", () => {
    const threadWikitext = `== 探讨条目校对规则 ==
你好，请问机器人的校对规则是在哪里配置的？ --[[User:Alice|Alice]] 2026年9月14日 (一) 01:00 (UTC)
:在 User:AmanojakuBot/task/2/rule 页面中配置。 --[[User:Bob|Bob]]（[[User talk:Bob|留言]]） 2026年9月14日 (一) 01:05 (UTC)
::知道了，多谢！ --[[Special:Contributions/192.0.2.1|192.0.2.1]] 2026年9月14日 (一) 01:10 (UTC)
:::机器人可以帮我看一下这个吗？ --~~~~`;

    const comments = parseDiscussionThread(threadWikitext, {
      defaultAuthor: "Charlie",
      defaultTimestamp: "2026年9月14日 (一) 01:15 (UTC)",
    });

    expect(comments).toHaveLength(4);
    expect(comments[0]).toMatchObject({
      author: "Alice",
      timestamp: "2026年9月14日 (一) 01:00 (UTC)",
      indentLevel: 0,
      text: "你好，请问机器人的校对规则是在哪里配置的？",
    });
    expect(comments[1]).toMatchObject({
      author: "Bob",
      timestamp: "2026年9月14日 (一) 01:05 (UTC)",
      indentLevel: 1,
      text: "在 User:AmanojakuBot/task/2/rule 页面中配置。",
    });
    expect(comments[2]).toMatchObject({
      author: "192.0.2.1",
      timestamp: "2026年9月14日 (一) 01:10 (UTC)",
      indentLevel: 2,
      text: "知道了，多谢！",
    });
    expect(comments[3]).toMatchObject({
      author: "Charlie",
      timestamp: "2026年9月14日 (一) 01:15 (UTC)",
      indentLevel: 3,
      text: "机器人可以帮我看一下这个吗？",
    });
  });

  it("formats structured discussion history and current message into JSON format", () => {
    const threadWikitext = `== 话题测试 ==
Alice的第一句话 --[[User:Alice|Alice]] 2026年9月14日 (一) 01:00 (UTC)
:Bob的回复 --[[User:Bob|Bob]] 2026年9月14日 (一) 01:05 (UTC)`;

    const jsonHistory = formatStructuredDiscussionContext(
      threadWikitext,
      "话题测试",
      "zhwiki",
      123456,
    );
    const parsedHistory = JSON.parse(jsonHistory);
    expect(parsedHistory).toHaveLength(1);
    expect(parsedHistory[0].title).toBe("话题测试");
    expect(parsedHistory[0].messages).toHaveLength(2);
    expect(parsedHistory[0].messages[0].id).toBe("r-123456-202609140100");
    expect(parsedHistory[0].messages[0].author).toBe("Alice");
    expect(parsedHistory[0].messages[0].text).toBe("Alice的第一句话");
    expect(parsedHistory[0].messages[0].rawText).toBeUndefined(); // rawText 必须剔除以防止幻觉
    expect(parsedHistory[0].messages[1].id).toBe("r-123456-202609140105");
    expect(parsedHistory[0].messages[1].author).toBe("Bob");

    const jsonCurrent = formatStructuredCurrentMessage(
      ":Charlie: 最新提问 --[[User:Charlie|Charlie]] 2026年9月14日 (一) 01:23 (UTC)",
      "Charlie",
      "2026-09-14T01:23:00Z",
      "zhwiki",
      undefined,
      123456,
    );
    const parsedCurrent = JSON.parse(jsonCurrent);
    expect(parsedCurrent.id).toBe("r-123456-202609140123");
    expect(parsedCurrent.author).toBe("Charlie");
    expect(parsedCurrent.indentLevel).toBe(1);
    expect(parsedCurrent.text).toBe("Charlie: 最新提问");
    expect(parsedCurrent.rawText).toBeUndefined();
  });

  it("splits comments strictly by end-of-line signatures rather than indentation changes", () => {
    const threadWithMultilineAndLists = `== 复杂排版讨论 ==
:这是 Alice 发言的第一段内容。
:* 列表项 1：需要重点注意的事情
:* 列表项 2：另一项补充内容
:这是 Alice 发言的最后一段总结，其中顺便提到了 [[User:Someone|Someone]] 在 2026年1月1日 (四) 00:00 (UTC) 的旧发言作为参考。 --[[User:Alice|Alice]] 2026年9月14日 (一) 01:00 (UTC)
::这是 Bob 对 Alice 的回复。
::包含第二行。 --[[User:Bob|Bob]] 2026年9月14日 (一) 01:05 (UTC)`;

    const comments = parseDiscussionThread(threadWithMultilineAndLists);
    expect(comments).toHaveLength(2);

    // Alice 的整段复杂留言应该被保留为单个 comment，不因列表或正文中的旧时间戳断开
    expect(comments[0].author).toBe("Alice");
    expect(comments[0].timestamp).toBe("2026年9月14日 (一) 01:00 (UTC)");
    expect(comments[0].indentLevel).toBe(1);
    expect(comments[0].text).toContain("这是 Alice 发言的第一段内容。");
    expect(comments[0].text).toContain("列表项 1：需要重点注意的事情");
    expect(comments[0].text).toContain("列表项 2：另一项补充内容");
    expect(comments[0].text).toContain("这是 Alice 发言的最后一段总结");

    // Bob 的回复也是单个 comment
    expect(comments[1].author).toBe("Bob");
    expect(comments[1].timestamp).toBe("2026年9月14日 (一) 01:05 (UTC)");
    expect(comments[1].indentLevel).toBe(2);
    expect(comments[1].text).toBe("这是 Bob 对 Alice 的回复。\n包含第二行。");
  });

  it("identifies discussion comments with hasDiscussionComments", () => {
    expect(
      hasDiscussionComments("这是一段普通的条目正文，没有签名和时间戳。"),
    ).toBe(false);
    expect(
      hasDiscussionComments(
        "我支持这个提议。--[[User:Alice]] 2026年9月14日 (一) 01:00 (UTC)",
      ),
    ).toBe(true);
  });

  it("parses entire discussion page into hierarchical JSON with multi-level headings", () => {
    const fullPageWikitext = `{{Talk header}}
导言区的告示或未分类留言 --[[User:Admin|Admin]] 2026年9月14日 (一) 00:30 (UTC)

== 二级讨论话题一 ==
这是讨论一的正文。 --[[User:Alice|Alice]] 2026年9月14日 (一) 01:00 (UTC)
:回复Alice。 --[[User:Bob|Bob]] 2026年9月14日 (一) 01:05 (UTC)

=== 三级子标题 1.1 ===
这是子话题1.1的内容。 --[[User:Charlie|Charlie]] 2026年9月14日 (一) 01:10 (UTC)

==== 四级小节 1.1.1 ====
这是更深层次的小节。 --[[User:Dave|Dave]] 2026年9月14日 (一) 01:15 (UTC)

=== 三级子标题 1.2 ===
另一个子话题的内容。 --[[User:Eve|Eve]] 2026年9月14日 (一) 01:20 (UTC)

== 二级讨论话题二 ==
第二个大话题。 --[[User:Frank|Frank]] 2026年9月14日 (一) 02:00 (UTC)`;

    const tree = parseStructuredDiscussionPage(fullPageWikitext);

    // 结构验证
    expect(tree).toHaveLength(3);

    // 导言区 (level 0)
    expect(tree[0].level).toBe(0);
    expect(tree[0].messages).toHaveLength(1);
    expect((tree[0].messages[0] as any).author).toBe("Admin");

    // 二级标题 1
    const sec1 = tree[1];
    expect(sec1.level).toBe(2);
    expect(sec1.title).toBe("二级讨论话题一");
    expect(sec1.messages).toHaveLength(4);

    // 消息 1 与 2
    expect((sec1.messages[0] as any).id).toBe("r-0-202609140100");
    expect((sec1.messages[0] as any).author).toBe("Alice");
    expect((sec1.messages[0] as any).text).toBe("这是讨论一的正文。");
    expect((sec1.messages[0] as any).indentLevel).toBe(0);
    expect((sec1.messages[0] as any).rawText).toBeUndefined(); // rawText 必须剔除以防止幻觉
    expect((sec1.messages[1] as any).id).toBe("r-0-202609140105");
    expect((sec1.messages[1] as any).author).toBe("Bob");
    expect((sec1.messages[1] as any).indentLevel).toBe(1);

    // 三级标题 1.1
    const subSec1_1 = sec1.messages[2] as StructuredDiscussionSection;
    expect(subSec1_1.level).toBe(3);
    expect(subSec1_1.title).toBe("三级子标题 1.1");
    expect(subSec1_1.messages).toHaveLength(2);
    expect((subSec1_1.messages[0] as any).id).toBe("r-0-202609140110");
    expect((subSec1_1.messages[0] as any).author).toBe("Charlie");

    // 四级标题 1.1.1
    const subSec1_1_1 = subSec1_1.messages[1] as StructuredDiscussionSection;
    expect(subSec1_1_1.level).toBe(4);
    expect(subSec1_1_1.title).toBe("四级小节 1.1.1");
    expect((subSec1_1_1.messages[0] as any).id).toBe("r-0-202609140115");
    expect((subSec1_1_1.messages[0] as any).author).toBe("Dave");

    // 三级标题 1.2
    const subSec1_2 = sec1.messages[3] as StructuredDiscussionSection;
    expect(subSec1_2.level).toBe(3);
    expect(subSec1_2.title).toBe("三级子标题 1.2");
    expect((subSec1_2.messages[0] as any).id).toBe("r-0-202609140120");
    expect((subSec1_2.messages[0] as any).author).toBe("Eve");

    // 二级标题 2
    const sec2 = tree[2];
    expect(sec2.level).toBe(2);
    expect(sec2.title).toBe("二级讨论话题二");
    expect(sec2.messages).toHaveLength(1);
    expect((sec2.messages[0] as any).id).toBe("r-0-202609140200");
    expect((sec2.messages[0] as any).author).toBe("Frank");
  });
});
