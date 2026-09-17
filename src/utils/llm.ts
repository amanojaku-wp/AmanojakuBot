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

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type PartialTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
};

export function createTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addTokenUsage(
  target: TokenUsage,
  added?: PartialTokenUsage | null,
): TokenUsage {
  if (!added) return target;
  const input = added.inputTokens ?? added.promptTokens ?? 0;
  const output = added.outputTokens ?? added.completionTokens ?? 0;
  const total = added.totalTokens ?? input + output;
  target.inputTokens += input;
  target.outputTokens += output;
  target.totalTokens += total;
  return target;
}

export function formatTokenUsage(usage: TokenUsage): string {
  return `I${usage.inputTokens}/O${usage.outputTokens}/T${usage.totalTokens}`;
}

export type FallbackRunnerResult<T> =
  { result: T; usage?: PartialTokenUsage } | T;

/**
 * 带有 Fallback 降级重试与 Token 统计累加的 LLM 执行器
 */
export async function executeWithFallback<T>(
  models: LlmModelSpec[],
  runner: (
    model: LanguageModel,
    spec: LlmModelSpec,
  ) => Promise<FallbackRunnerResult<T>>,
  usageTracker?: TokenUsage,
): Promise<{ result: T; usage: TokenUsage }> {
  if (!models || models.length === 0) {
    throw new Error("No LLM models configured");
  }

  const currentUsage = usageTracker ?? createTokenUsage();
  let lastError: unknown;

  for (const spec of models) {
    try {
      const model = getLanguageModel(spec);
      const output = await runner(model, spec);
      if (output !== null && typeof output === "object" && "result" in output) {
        addTokenUsage(
          currentUsage,
          (output as { usage?: PartialTokenUsage }).usage,
        );
        return {
          result: (output as { result: T }).result,
          usage: currentUsage,
        };
      } else {
        return { result: output as T, usage: currentUsage };
      }
    } catch (err) {
      console.error(`[LLM] ${spec.provider}/${spec.model} failed`, err);

      if (err && typeof err === "object" && "usage" in err) {
        addTokenUsage(
          currentUsage,
          (err as { usage?: PartialTokenUsage }).usage,
        );
      }
      lastError = err;
      // 继续尝试下一个模型
    }
  }

  throw lastError ?? new Error("All LLM fallbacks failed");
}
