import type Database from "better-sqlite3";
import type { Mwn } from "mwn";
import { pageText } from "../utils/wiki.js";
import { respond } from "../utils/llm.js";
import type { CommentExtractionResult } from "../utils/wikitext.js";

export type ChatConfig = {
  personaPage: string;
  provider: "openai" | "google";
  model: string;
};

/**
 * 任务一：讨论页自由对话处理
 *
 * 核心业务流程：
 * 1. 从机器人用户子页读取 Persona 人设提示词。
 * 2. 从本地数据库按 actor_id 查询最近 8 轮历史对话记忆。
 * 3. 注入当前所属二级标题章节的多人会话上下文，确保准确回应当前发言者并不忽略其他人的发言背景。
 * 4. 调用 LLM 生成客观、简短的回复。
 */
export async function prepareChatReply(
  db: Database.Database,
  bot: Mwn,
  actorId: number,
  actorName: string,
  message: string,
  extraction: CommentExtractionResult,
  cfg: ChatConfig,
): Promise<string> {
  const persona = await pageText(bot, cfg.personaPage);
  const history = db
    .prepare(
      "SELECT role,content FROM messages WHERE actor_id=? ORDER BY id DESC LIMIT 8",
    )
    .all(actorId)
    .reverse() as { role: "user" | "assistant"; content: string }[];

  return respond(
    cfg.provider,
    cfg.model,
    persona,
    message,
    history,
    extraction.sectionFullText,
    actorName,
  );
}
