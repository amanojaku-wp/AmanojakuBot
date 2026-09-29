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
  /**
   * 命中 prompt 缓存的输入 token（cached input tokens）。
   *
   * 缓存命中的部分通常按更低单价计费（OpenAI 约 1/4、Google 约 1/4），
   * 单独统计它与总用量分开核对，才能判断「省钱改造」是否真的生效。
   */
  cachedInputTokens: number;
};

export type PartialTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** 部分 provider / 旧版 SDK 直接在 usage 顶层给出缓存命中 token */
  cachedInputTokens?: number;
  /**
   * AI SDK v5+ 的 usage 形状：缓存命中 token 位于 `inputTokenDetails.cacheReadTokens`，
   * 实际 provider 可能把字段置为 undefined（无缓存或不支持）。
   */
  inputTokenDetails?: {
    noCacheTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
  };
};

export function createTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };
}

/** 从 provider 的 usage 里取出缓存命中的输入 token（兼容两种字段位置）。 */
export function cachedInputTokensOf(added: PartialTokenUsage): number {
  return (
    added.cachedInputTokens ?? added.inputTokenDetails?.cacheReadTokens ?? 0
  );
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
  target.cachedInputTokens += cachedInputTokensOf(added);
  return target;
}

/** 紧凑格式：I输入/O输出/T合计（不含缓存明细，保持既有日志与测试稳定）。 */
export function formatTokenUsage(usage: TokenUsage): string {
  return `I${usage.inputTokens}/O${usage.outputTokens}/T${usage.totalTokens}`;
}

/**
 * 含缓存命中的详细格式：I输入/O输出/T合计/C缓存命中输入。
 *
 * 用于任务三 debugLog 的成本核对（T 包含 C，C 为其中按缓存价计费的部分）。
 */
export function formatTokenUsageDetailed(usage: TokenUsage): string {
  return `${formatTokenUsage(usage)}/C${usage.cachedInputTokens}`;
}

export type FallbackRunnerResult<T> =
  { result: T; usage?: PartialTokenUsage; model?: string } | T;

/**
 * LLM 运行时约束
 *
 * 工作队列允许异键任务并行后，同时到达的评审请求可能各自发起 LLM 调用。
 * 这里在模型调用层再加一道全局闸门：
 * 1. 并发上限：避免瞬时打爆 provider 的速率限制（429）进而触发整条模型链降级重试；
 * 2. 单次超时：避免上游挂起时无限占用并发槽位与工作队列槽位。
 */
export type LlmRuntimeOptions = {
  /** 同时进行的 LLM 调用上限 */
  maxConcurrent: number;
  /** 单次 LLM 调用超时（毫秒） */
  timeoutMs: number;
};

let llmMaxConcurrent = 2;
let llmTimeoutMs = 180_000;
let llmActive = 0;
const llmWaiters: (() => void)[] = [];

/** 由进程入口依据配置注入 LLM 运行时约束（默认：并发 2、超时 3 分钟）。 */
export function configureLlmRuntime(options: Partial<LlmRuntimeOptions>): void {
  if (options.maxConcurrent && options.maxConcurrent > 0) {
    llmMaxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  }
  if (options.timeoutMs && options.timeoutMs > 0) {
    llmTimeoutMs = Math.floor(options.timeoutMs);
  }
}

/** LLM 闸门当前占用状况（日志与排查用）。 */
export function llmRuntimeStats(): {
  maxConcurrent: number;
  active: number;
  waiting: number;
  timeoutMs: number;
} {
  return {
    maxConcurrent: llmMaxConcurrent,
    active: llmActive,
    waiting: llmWaiters.length,
    timeoutMs: llmTimeoutMs,
  };
}

/** 获取一个 LLM 调用额度，返回释放函数（幂等，可重复调用）。 */
async function acquireLlmSlot(): Promise<() => void> {
  while (llmActive >= llmMaxConcurrent) {
    await new Promise<void>((resolve) => llmWaiters.push(resolve));
  }
  llmActive++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    llmActive--;
    llmWaiters.shift()?.();
  };
}

/**
 * 带有 Fallback 降级重试与 Token 统计累加的 LLM 执行器
 *
 * runner 的第三个参数为本次调用的 AbortSignal（超时中断），调用方应透传给 generateText /
 * generateObject 的 `abortSignal` 参数。
 */
export async function executeWithFallback<T>(
  models: LlmModelSpec[],
  runner: (
    model: LanguageModel,
    spec: LlmModelSpec,
    signal: AbortSignal,
  ) => Promise<FallbackRunnerResult<T>>,
  usageTracker?: TokenUsage,
): Promise<{
  result: T;
  usage: TokenUsage;
  totalUsage: TokenUsage;
  model: string;
}> {
  if (!models || models.length === 0) {
    throw new Error("No LLM models configured");
  }

  const totalUsage = usageTracker ?? createTokenUsage();
  const callUsage = createTokenUsage();
  let lastError: unknown;

  for (const spec of models) {
    const release = await acquireLlmSlot();
    try {
      const model = getLanguageModel(spec);
      const modelIdentifier = `${spec.provider}/${spec.model}`;
      const signal = AbortSignal.timeout(llmTimeoutMs);
      const output = await runner(model, spec, signal);
      if (output !== null && typeof output === "object" && "result" in output) {
        const usage = (output as { usage?: PartialTokenUsage }).usage;
        addTokenUsage(callUsage, usage);
        addTokenUsage(totalUsage, usage);
        return {
          result: (output as { result: T }).result,
          usage: { ...callUsage },
          totalUsage: { ...totalUsage },
          model: (output as { model?: string }).model ?? modelIdentifier,
        };
      } else {
        return {
          result: output as T,
          usage: { ...callUsage },
          totalUsage: { ...totalUsage },
          model: modelIdentifier,
        };
      }
    } catch (err) {
      console.error(`[LLM] ${spec.provider}/${spec.model} failed`, err);

      if (err && typeof err === "object" && "usage" in err) {
        const usage = (err as { usage?: PartialTokenUsage }).usage;
        addTokenUsage(callUsage, usage);
        addTokenUsage(totalUsage, usage);
      }
      lastError = err;
      // 继续尝试下一个模型
    } finally {
      release();
    }
  }

  throw lastError ?? new Error("All LLM fallbacks failed");
}
