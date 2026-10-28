/**
 * `-p --output-format json` 结果里的用量/成本字段（#8 / #9，2026-10-27）。
 *
 * 原 `usage` 是内部 `Usage` 原样输出，`inputTokens` 的含义随 provider 变：
 * Anthropic 是未命中余量，OpenAI 兼容端点是含命中的全量（llm/types.ts 的约定）。
 * 同名字段两种含义，调用方（bug2mr 的 MR 描述）按 `inputTokens + cacheRead` 解读，
 * GLM 会话被读成 628 万 token，实际 324 万。JSON 里还没有 model / provider / 成本。
 *
 * `usage` 保持原样不动（已有调用方在读），新增 `usage_normalized` 给出跨 provider 统一的互斥分段。
 *
 * ⚠️ 必须**逐模型**归一化后再累加，不能先累加再归一化：会话中途 fallback 换了 provider 时，
 * `getTotalUsage()` 把两种口径的 inputTokens 直接相加，事后已无法拆开。
 */

import { normalizeCacheUsage } from "@sid-code/core/llm/types.ts";

/** 只取用得到的字段，不耦合 SessionState 的完整类型 */
export interface ModelUsageLike {
  cumulativePromptTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  provider: string;
}

export interface NormalizedUsageSummary {
  /** 既非命中也非写入的全价输入 */
  uncached: number;
  cache_read: number;
  cache_write: number;
  /** 完整输入 = uncached + cache_read + cache_write（与用量账本 promptTotal 同口径） */
  prompt_total: number;
  output: number;
}

export function normalizeModelUsage(
  modelUsage: Record<string, ModelUsageLike>,
): NormalizedUsageSummary {
  const sum: NormalizedUsageSummary = {
    uncached: 0,
    cache_read: 0,
    cache_write: 0,
    prompt_total: 0,
    output: 0,
  };
  for (const s of Object.values(modelUsage)) {
    const n = normalizeCacheUsage(
      {
        inputTokens: s.cumulativePromptTokens,
        outputTokens: s.outputTokens,
        cacheReadInputTokens: s.cacheReadInputTokens,
        cacheCreationInputTokens: s.cacheCreationInputTokens,
      },
      s.provider,
    );
    sum.uncached += n.uncachedInputTokens;
    sum.cache_read += n.cacheHitTokens;
    sum.cache_write += n.cacheWriteTokens;
    sum.prompt_total += n.promptTotal;
    sum.output += n.outputTokens;
  }
  return sum;
}

/**
 * 本次会话实际用到的 provider。只用过一个就是它本身；fallback 换过就逗号拼接，
 * 不挑一个冒充——调用方按 provider 自行计价时，看到多值就该知道要逐模型看账本。
 */
export function providersOf(modelUsage: Record<string, ModelUsageLike>): string | undefined {
  const set = [
    ...new Set(
      Object.values(modelUsage)
        .map((s) => s.provider)
        .filter(Boolean),
    ),
  ];
  return set.length > 0 ? set.join(",") : undefined;
}
