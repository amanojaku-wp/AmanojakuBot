import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export type LlmModelSpec = {
  provider: "openai" | "google";
  model: string;
};

export function getLanguageModel(spec: LlmModelSpec): LanguageModel {
  if (spec.provider === "openai") {
    return openai(spec.model);
  }
  if (spec.provider === "google") {
    return google(spec.model);
  }
  throw new Error(
    `Unsupported provider: ${(spec as { provider: string }).provider}`,
  );
}

/**
 * 带有 Fallback 降级重试的 LLM 执行器
 */
export async function executeWithFallback<T>(
  models: LlmModelSpec[],
  runner: (model: LanguageModel, spec: LlmModelSpec) => Promise<T>,
): Promise<T> {
  if (!models || models.length === 0) {
    throw new Error("No LLM models configured");
  }

  let lastError: unknown;
  for (const spec of models) {
    try {
      const model = getLanguageModel(spec);
      return await runner(model, spec);
    } catch (err) {
      lastError = err;
      // 继续尝试下一个模型
    }
  }

  throw lastError ?? new Error("All LLM fallbacks failed");
}
