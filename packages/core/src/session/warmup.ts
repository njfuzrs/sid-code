/**
 * 缓存预热机制（10.4）
 *
 * 会话开始时发一个最小请求（只有 system + tools + 一条 user 消息），
 * 触发 cache_creation，后续真正的请求就能 cache_read。
 *
 * 权衡：额外花一次 cache_creation 费用（input_tokens × 1.25），
 * 但如果会话预期 >= 3 轮对话，总体划算（2 次 cache_read 就回本）。
 *
 * 条件门控：
 * - 仅 Anthropic provider（其它 provider 无 prompt cache 机制）
 * - 仅 resume 恢复会话或明确 opt-in（SID_WARMUP_CACHE=1）
 * - SID_DISABLE_CACHE_WARMUP=1 一键关闭
 * - 非子代理（子代理生命周期短、预热的 cache_creation 成本回不来）
 *
 * ⚠️ 上一版这里写的是"子代理用 skipCacheWrite 模式，预热无意义"。**该说法失真**
 *（2026-08-09 实测）：`CacheStrategyOptions.skipCacheWrite` 生产从未被传入，
 * 子代理侧一处调用点都没有 —— 那是设计意图而非现状。门控成立的真实理由是上面那条
 * （成本回不来），与 skipCacheWrite 无关。留着错理由比没理由更糟：
 * 下次有人想验证"子代理到底写不写缓存"，会以为这里已经回答了。
 */

import type { Provider } from "../llm/provider.ts";
import type { ToolDefinition } from "../llm/types.ts";
import type { Message } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";
import { recordSideCall } from "../trace/side-call-sink.ts";
import { withSideCallDeadline } from "../llm/side-call-timeout.ts";
import { resolveSideCallTimeouts } from "../config/network-profile.ts";

export interface WarmupParams {
  provider: Provider;
  systemPrompt: string;
  tools: ToolDefinition[];
  /** 是否为 resume 恢复的会话（自动开启预热） */
  isResume?: boolean;
}

/**
 * 条件性执行缓存预热。
 * 返回 true 表示预热已发送，false 表示条件不满足（跳过）。
 *
 * 失败静默忽略（预热是优化，不是功能——失败只意味着首轮全价，不影响正确性）。
 */
export async function warmupPromptCache(params: WarmupParams): Promise<boolean> {
  const log = getLogger();

  // 门控条件
  if (process.env.SID_DISABLE_CACHE_WARMUP === "1") return false;
  if (params.provider.name() !== "anthropic") return false;
  if (!params.isResume && process.env.SID_WARMUP_CACHE !== "1") return false;
  if (!params.provider.sendMessageNonStreaming) return false;

  // 工具和 system 为空时预热无意义
  if (!params.systemPrompt && (!params.tools || params.tools.length === 0)) return false;

  log.info("CACHE_WARMUP", "发送缓存预热请求（最小 payload）");

  try {
    // 最小 payload：system + tools + 一条极短的 user 消息 + maxTokens=1
    // 目标仅是触发 cache_creation（服务端缓存 system+tools 前缀），
    // 不关心模型输出（会返回一个极短回复或被 stop 截断）。
    const warmupMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "." }],
      },
    ];

    // T3：warmup 是非流式 side-call，此前无 signal 也无 timeout——若网关 hang 则永久阻塞
    // 会话启动。套 10s 硬超时（Promise.race + 合并 signal），超时/失败都走下方 catch 静默降级。
    // 配置-4：走 network-profile 的 side-call 子表统一解析（env override > 默认 10s）
    const WARMUP_TIMEOUT_MS = resolveSideCallTimeouts().warmupMs;
    const resp = await withSideCallDeadline("cache-warmup", WARMUP_TIMEOUT_MS, (signal) =>
      params.provider.sendMessageNonStreaming!(
        {
          model: "", // 使用 provider 默认模型
          system: params.systemPrompt,
          tools: params.tools,
          messages: warmupMessages,
          maxTokens: 1, // 最小化输出 token 开销
        },
        signal,
      ),
    );

    // 记录辅助调用用量
    if (resp?.usage) {
      recordSideCall({
        label: "cache-warmup",
        model: "",
        inputTokens: resp.usage.inputTokens ?? 0,
        outputTokens: resp.usage.outputTokens ?? 0,
        cacheReadTokens: (resp.usage as any).cacheReadInputTokens ?? 0,
        cacheCreationTokens: (resp.usage as any).cacheCreationInputTokens ?? 0,
        durationMs: 0,
      });
    }

    log.info("CACHE_WARMUP", "预热完成（system+tools 已缓存）");
    return true;
  } catch (err: any) {
    // 预热失败完全无害——只意味着首轮请求会 cache_creation 而非 cache_read
    log.debug("CACHE_WARMUP", `预热失败（非阻断）: ${err?.message?.slice(0, 100)}`);
    // T13.3：记录失败的 side-call
    recordSideCall({
      label: "cache-warmup",
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
      success: false,
      error: err?.message?.slice(0, 200),
      timedOut: /timeout|超时|timed out/i.test(err?.message ?? ""),
    });
    return false;
  }
}
