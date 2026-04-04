/**
 * 自动压缩逻辑
 * 从 app.ts 提取，处理上下文压缩和溢出恢复
 * 集成熔断器：连续失败时停止浪费 API 调用
 */

import type { Provider } from "../llm/provider.ts";
import type { Config } from "../config/config.ts";
import type { HookSystem } from "../hook/system.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { getLogger } from "../debug/index.ts";
import { AutoCompactCircuitBreaker } from "./circuit-breaker.ts";

/** 全局熔断器实例（跨调用共享状态） */
let globalCircuitBreaker: AutoCompactCircuitBreaker | null = null;

function getCircuitBreaker(): AutoCompactCircuitBreaker {
  if (!globalCircuitBreaker) {
    globalCircuitBreaker = new AutoCompactCircuitBreaker();
  }
  return globalCircuitBreaker;
}

/** 重置熔断器（测试用） */
export function resetCircuitBreaker(): void {
  globalCircuitBreaker?.reset();
  globalCircuitBreaker = null;
}

/** 自动压缩依赖 */
export interface AutoCompactDeps {
  provider: Provider;
  config: Config;
  ctxMgr: ContextManager;
  hookSystem: HookSystem;
  getAbortSignal: () => AbortSignal | undefined;
}

/**
 * 自动压缩：上下文接近上限时，用 LLM 生成摘要并压缩消息历史
 * 如果 LLM 不可用或熔断器打开，则使用简单截断策略
 */
export async function autoCompact(deps: AutoCompactDeps): Promise<void> {
  const log = getLogger();
  const messages = deps.ctxMgr.getMessages();
  const circuitBreaker = getCircuitBreaker();

  if (messages.length <= 4) {
    log.debug("COMPACT", "消息太少，跳过压缩");
    return;
  }

  // 熔断器检查：如果熔断中，直接降级为简单截断
  if (!circuitBreaker.canExecute()) {
    log.warn("COMPACT", "autoCompact 熔断中，降级为简单截断");
    const simpleSummary = `[自动截断] 之前有 ${messages.length - 4} 条消息被截断以释放上下文空间。（autoCompact 熔断中）`;
    deps.ctxMgr.compactWithSummary(simpleSummary);
    return;
  }

  // pre_compact hook（blocking 时可阻止压缩）
  const preCompactResult = await deps.hookSystem.firePreCompactEvent("auto");
  if (preCompactResult.finalOutput?.isBlockingDecision()) {
    log.info("HOOK", `压缩被 hook 阻止: ${preCompactResult.finalOutput.getEffectiveReason()}`);
    return;
  }

  try {
    // 尝试用 LLM 生成摘要
    const toSummarize = messages.slice(0, -4);
    const summaryPrompt = `请用中文简洁地总结以下对话内容，保留关键信息（文件路径、代码修改、决策、待办事项）：\n\n${
      toSummarize.map(m => {
        const texts = m.content
          .filter(b => b.type === "text")
          .map(b => b.type === "text" ? b.text : "")
          .join("\n");
        return `[${m.role}] ${texts.slice(0, 500)}`;
      }).join("\n\n")
    }`;

    const stream = deps.provider.sendMessageStream(
      {
        model: deps.config.model,
        messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }] }],
        system: "你是一个对话摘要助手。请简洁准确地总结对话内容。",
        maxTokens: 2000,
      },
      deps.getAbortSignal(),
    );

    let summary = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        summary += event.delta.text;
      }
    }

    if (summary) {
      deps.ctxMgr.compactWithSummary(summary);
      circuitBreaker.recordSuccess();
      log.info("COMPACT", `自动压缩完成，摘要 ${summary.length} 字符，剩余 ${deps.ctxMgr.messageCount()} 条消息`);
      return;
    }

    // 空摘要也算失败
    circuitBreaker.recordFailure();
  } catch (err: any) {
    log.warn("COMPACT", `LLM 摘要失败，使用简单截断: ${err.message}`);
    circuitBreaker.recordFailure();
  }

  // 降级：简单截断
  const simpleSummary = `[自动截断] 之前有 ${messages.length - 4} 条消息被截断以释放上下文空间。`;
  deps.ctxMgr.compactWithSummary(simpleSummary);
  log.info("COMPACT", `简单截断完成，剩余 ${deps.ctxMgr.messageCount()} 条消息`);
}

/**
 * 处理上下文溢出错误，尝试自动缩小 max_tokens
 * 返回调整后的 maxTokens，无法恢复时返回 null
 */
export function handleContextOverflow(
  err: any,
  _currentMaxTokens: number,
  ctxMgr: ContextManager,
  toolCount: number,
): number | null {
  const msg = err.message || String(err);
  const overflowMatch = msg.match(/(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
  if (!overflowMatch && !msg.toLowerCase().includes("context") && !msg.toLowerCase().includes("token")) {
    return null;
  }

  let contextLimit = 200000;
  let inputTokens = 0;

  if (overflowMatch) {
    inputTokens = parseInt(overflowMatch[1], 10);
    contextLimit = parseInt(overflowMatch[3], 10);
  } else {
    inputTokens = ctxMgr.estimateTokens(toolCount);
  }

  const available = Math.max(0, contextLimit - inputTokens - 1000);
  if (available < 3000) {
    return null;
  }

  return available;
}
