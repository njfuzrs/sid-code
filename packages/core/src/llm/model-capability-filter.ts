/**
 * 模型能力参数过滤中间件 — model-capability-filter.ts
 *
 * 基于 model-params-catalog.ts 声明的协议能力字段，在发送请求前自动过滤/转换参数。
 * 集中处理 o-series 等模型的特殊需求（system→developer role、max_tokens→max_completion_tokens、
 * 不支持 temperature 等），避免散落在 openai.ts 多处。
 *
 * 设计原则：
 * - 未注册模型走透传（兼容未知模型，不修改参数）
 * - 所有新增字段可选（向后兼容）
 * - 只处理已声明的能力字段，不做假设
 */

import { lookupCatalog } from "./model-params-catalog.ts";

/**
 * OpenAI 兼容的请求参数（仅包含本中间件关心的字段，其余透传）。
 * 这不是完整的 OpenAI 请求接口，而是过滤器关心的子集。
 */
export interface FilterableParams {
  messages?: Array<{ role: string; [key: string]: any }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  [key: string]: any;
}

/**
 * 根据模型在 catalog 中声明的协议能力，自动过滤/转换请求参数。
 *
 * - 未注册模型（lookupCatalog miss）：原样透传，不做任何修改
 * - 已注册模型：按声明的 systemRole、maxTokensField、supportsTemperature、reasoningEffortValues 过滤
 *
 * @param model 模型名
 * @param params 请求参数（会被原地修改）
 * @returns 修改后的 params（同一引用）
 */
export function filterParamsForModel<T extends FilterableParams>(model: string, params: T): T {
  const entry = lookupCatalog(model);
  if (!entry) return params; // 未注册模型走透传

  // 1. system role 转换：system → developer
  if (entry.systemRole === "developer" && params.messages) {
    params.messages = params.messages.map((m) =>
      m.role === "system" ? { ...m, role: "developer" } : m,
    );
  }

  // 2. max_tokens 字段名映射：max_tokens → max_completion_tokens
  if (entry.maxTokensField === "max_completion_tokens" && params.max_tokens !== undefined) {
    params.max_completion_tokens = params.max_tokens;
    delete params.max_tokens;
  }

  // 3. 不支持的采样参数：删除 temperature / top_p
  if (entry.supportsTemperature === false) {
    delete params.temperature;
    delete params.top_p;
  }

  // 4. reasoning_effort 钳制：不在支持列表中的值降为最高支持值
  if (entry.reasoningEffortValues && params.reasoning_effort) {
    if (!entry.reasoningEffortValues.includes(params.reasoning_effort as any)) {
      params.reasoning_effort = entry.reasoningEffortValues[entry.reasoningEffortValues.length - 1];
    }
  }

  return params;
}
