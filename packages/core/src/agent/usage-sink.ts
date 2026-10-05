/**
 * 子代理 usage 归集 sink（P0-1）—— 从 cli/app.ts 下沉到 core 的唯一实现
 *
 * 下沉的理由是**可测**：这段逻辑原本是 App 的私有方法，会话级回放测试
 * （tests/llm/vcr/session-replay.test.ts）拿不到它，只能在测试里复制一份——
 * 而复制品对「生产那份被注释掉」完全无感，测试照样绿。正是 4.56 倍成本事故
 * 那一类「漏记一个入口」的回归要拦的东西，所以测试必须跑生产这份。
 */

import type { SubAgentResult } from "./sub-agent.ts";
import { SessionState } from "../session/state.ts";
import type { PricingModelEntry } from "../api/cost-tracker.ts";

export interface UsageSinkConfig {
  model: string;
  baseURL?: string;
  availableModels?: Array<PricingModelEntry & { name?: string; baseURL?: string }>;
}

export function createSubAgentUsageSink(
  sessionState: SessionState,
  config: UsageSinkConfig,
): (result: SubAgentResult) => void {
  return (result) => {
    const usage = result.usage;
    if (!usage) return;
    // 子代理可能用不同 subAgentModel，按其实际 model 分别计费；缺省回退主模型。
    const model = result.model || config.model;
    const provider = result.provider || SessionState.inferProvider(model, config.availableModels);
    // 端点必须与主循环同口径（loop.ts 的 updateUsage 传了 config.baseURL）：
    // 计价按 (model, endpoint) 复合键精确匹配，缺 baseURL 会让子代理落进
    // 空 key 桶（"官方默认端点"），于是主/子两条路径对**同一个模型**取到不同价格桶，
    // 同一会话内的费用口径自相矛盾。按子代理实际模型在 availableModels 里的
    // 配置取端点，缺省回退主模型端点（与 resolveEffortCap 同款派生）。
    const mc = config.availableModels?.find((m) => m.name === model);
    const baseURL = mc?.baseURL ?? config.baseURL;
    // 子代理无独立 API 耗时归集口径，durationMs 计 0（费用/ token 才是归集重点）。
    sessionState.updateUsage(model, usage, 0, provider, baseURL);
  };
}
