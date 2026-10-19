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

/** G2：子代理成本落盘事件名（events.jsonl）。 */
export const SUBAGENT_COST_EVENT_NAME = "SubagentCost";

/**
 * G2：子代理成本进轨迹的模块级通道。
 *
 * 为什么是模块级 sink：usage-sink 在 cli.ts 注册工具时就创建了，那时 TraceCollector
 * 还不存在（与 jit / file_freshness 同款时序）。App 在 collector 就绪后注入；
 * 未注入或写入抛错一律静默——度量不影响入账本身。
 *
 * 为什么新增字段而不是让 `total_cost_usd` 运行中就含子代理：历史曲线会断层。
 * 口径铁律见 `trace/builder.ts` 的 `subagent_cost_usd` 注释。
 */
export type SubagentCostTraceSink = (data: Record<string, unknown>) => void;
let costTraceSink: SubagentCostTraceSink | null = null;

/** 注入/清除子代理成本埋点通道（null = 关闭，测试收尾复位用） */
export function setSubagentCostTraceSink(s: SubagentCostTraceSink | null): void {
  costTraceSink = s;
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
    // G6：请求数按真实值累加（调用方用入账票据回填）；缺省 1 = 旧口径，不猜。
    const requests = result.apiRequests && result.apiRequests > 0 ? result.apiRequests : 1;
    // 子代理无独立 API 耗时归集口径，durationMs 计 0（费用/ token 才是归集重点）。
    const costUSD = sessionState.updateUsage(model, usage, 0, provider, baseURL, false, requests);
    // G2：落盘的金额就是刚入账、状态栏看到的那个数，不另算一遍——两边才对得上账。
    if (costTraceSink) {
      try {
        costTraceSink({
          ...(result.agentId ? { agent_id: result.agentId } : {}),
          model,
          provider,
          cost_usd: costUSD,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadInputTokens ?? 0,
          cache_creation_tokens: usage.cacheCreationInputTokens ?? 0,
          api_requests: requests,
          // false = 调用方没给真实请求数，api_requests 是兜底的 1
          api_requests_exact: result.apiRequests !== undefined && result.apiRequests > 0,
        });
      } catch {
        /* 度量不影响入账 */
      }
    }
  };
}
