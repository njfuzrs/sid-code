/**
 * 「只知道模型名时，它属于哪家 provider」—— 全仓唯一的按名兜底推断。
 *
 * ## 为什么要收成一份（D6，多 Provider 层审计）
 *
 * 此前有五份实现、三种判据：计费侧两份 `/^claude/i` 且先解析真名，可观测侧三份
 * `/claude/i` / `includes("claude")` 且不解析真名。两组输入下给出**相反**归因：
 *
 * | 别名 | 计费侧 | 可观测侧 |
 * | --- | --- | --- |
 * | `gw-fast`（modelId=claude-sonnet-5） | anthropic ✓ | openai ✗ |
 * | `my-claude-clone-v2`（第三方模型） | openai ✓ | anthropic ✗ |
 *
 * 没有一份是全对的，所以不是「统一到其中一份」，而是：
 *
 * 1. **身份优先取事实**：事件 / usage 自带的 provider（发生侧盖章，见 `stampUsageProvider`、
 *    provider 内各 emit 点的 `provider` 字段）—— 有事实就根本走不到这里；
 * 2. 其次取用户配置 `availableModels[].provider`（权威声明）；
 * 3. 最后才按**真名**做锚定匹配。
 *
 * ## 为什么锚定 `^`
 *
 * 与 `dialect/classify.ts`、`dialect/always-thinking.ts` 同口径（都吃真名、都从头匹配）：
 * 不锚定会把 `my-claude-clone-v2` 这类名字里含 claude 的第三方模型判成 anthropic，
 * `normalizeCacheUsage` 的三段拆分随之反掉（Anthropic 的 inputTokens 不含命中）。
 * 带网关前缀的 Claude 别名应当配 `modelId` 或 `provider`，前两层会接住它。
 */

import { resolveWireModel, lookupWireModelAlias } from "./wire-model.ts";

/** 推断所需的最小配置结构（避免反向依赖 config.ts，防 import 环） */
export interface ProviderInferEntry {
  name?: string;
  modelId?: string;
  provider?: string;
}

/**
 * 按模型名兜底推断 provider。
 *
 * @param model 本地别名或真名
 * @param availableModels 用户配置的模型列表；缺省时用进程级别名表翻译真名
 *        （离线分析 events.jsonl 时两者都没有，此时按原名判）
 * @returns `"anthropic"` / `"openai"`；空名返回 `"unknown"`
 */
export function inferProviderByModelName(
  model: string,
  availableModels?: readonly ProviderInferEntry[],
): string {
  if (!model) return "unknown";
  const mc = availableModels?.find((m) => m.name === model);
  if (mc?.provider) return mc.provider;
  const wire = availableModels?.length
    ? resolveWireModel(model, availableModels)
    : (lookupWireModelAlias(model) ?? model);
  return /^claude/i.test(wire) ? "anthropic" : "openai";
}
