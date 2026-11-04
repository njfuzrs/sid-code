/**
 * LLM Provider 接口
 * 所有 LLM 提供商（Anthropic/OpenAI/Ollama）必须实现此接口
 */

import type { SendParams, StreamEvent, AccumulatedResponse } from "./types.ts";
import type { QuotaScope } from "./quota-scope.ts";

/** Provider 支持的能力 */
export interface ProviderCapabilities {
  streaming: boolean; // 流式输出
  tools: boolean; // 工具调用
  thinking: boolean; // Extended Thinking / 深度思考
  vision: boolean; // 图片输入
  promptCaching: boolean; // Prompt Caching
  parallelToolCalls: boolean; // 并行工具调用
}

export interface Provider {
  /** 提供商名称 */
  name(): string;

  /** 发送消息并返回流式响应 */
  sendMessageStream(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent>;

  /** 查询 Provider 支持的能力（可选，默认全 true） */
  capabilities?(): ProviderCapabilities;

  /**
   * 非流式请求（可选，用于流式降级场景）。
   * 当某些网关不支持 SSE 时，stream-handler 会降级到此方法。
   * 返回累积好的完整响应，由调用方转换为流式事件序列。
   */
  sendMessageNonStreaming?(params: SendParams, signal?: AbortSignal): Promise<AccumulatedResponse>;

  /**
   * 账户级额度状态的**作用域**（可选，2026-11-04 F2 ⑥）。
   *
   * 额度是账户级资源（同一端点 + 同一凭据共用一份余额），不是模型级属性。
   * 漏斗判定额度耗尽后按这个作用域记标记，让同账户的其余循环（含并行子代理）
   * 直接快速失败，不再各自撞 2 次。
   *
   * ⛔ 不实现 = 不参与跨循环共享（fail-open）：拿不到可靠的账户标识时，
   * 宁可各自撞一次，也不要把两个账户的额度混成一个。
   * 返回的 `credential` 必须是**不可逆指纹**，不得放明文 key（见 quota-scope.ts）。
   */
  quotaScope?(): QuotaScope;
}

/** 默认能力（向后兼容，不强制实现） */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  thinking: false,
  vision: false,
  promptCaching: false,
  parallelToolCalls: true,
};

/** 获取 Provider 能力的辅助函数 */
export function getCapabilities(provider: Provider): ProviderCapabilities {
  return provider.capabilities?.() ?? DEFAULT_CAPABILITIES;
}
