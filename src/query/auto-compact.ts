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
  /**
   * 可选 Session Memory 提供方。
   * 提供时优先用结构化会话笔记压缩，为空则回退到 LLM 摘要。
   */
  sessionMemory?: import("../session-memory/compact.ts").SessionMemoryProvider;
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
    // 优先路径：Session Memory 压缩（结构化会话笔记）
    if (deps.sessionMemory) {
      try {
        const { trySessionMemoryCompaction } = await import("../session-memory/compact.ts");
        const smResult = await trySessionMemoryCompaction(deps.sessionMemory);
        if (smResult) {
          deps.ctxMgr.compactWithSummary(smResult.summary);
          circuitBreaker.recordSuccess();
          log.info("COMPACT", `Session Memory 压缩完成，剩余 ${deps.ctxMgr.messageCount()} 条消息`);
          return;
        }
        // smResult 为 null：Session Memory 为空，回退到 LLM 摘要（不计失败）
      } catch (err: any) {
        log.debug("COMPACT", `Session Memory 压缩异常，回退 LLM 摘要: ${err.message}`);
      }
    }

    // 尝试用 LLM 生成摘要（Layer 1：结构化 9 段 prompt 工程）
    const PRESERVE_RECENT = 4;
    const toSummarize = messages.slice(0, -PRESERVE_RECENT);
    const {
      COMPACT_SYSTEM_PROMPT,
      buildCompactUserPrompt,
      getCompactUserSummaryMessage,
    } = await import("./compact/auto-compact-prompt.ts");

    const summaryPrompt = buildCompactUserPrompt(toSummarize);

    const stream = deps.provider.sendMessageStream(
      {
        model: deps.config.model,
        messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }] }],
        system: COMPACT_SYSTEM_PROMPT,
        maxTokens: 4000,
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
      // Layer 2：post-compact 消息重组——剥离 analysis 草稿、追加静默续接 +
      // 保留消息提示 + 转录路径提示，让模型压缩后无缝续接而非"断片"。
      // 注意：不传 preservedCount。实际保留条数由 compactWithSummary 内部的
      // findCompressSplitPoint（按字符比例切分）决定，PRESERVE_RECENT 只用于本函数
      // 选取摘要输入范围，并非最终保留数 → 传具体数字会对模型谎报。走通用文案即可。
      const formattedSummary = getCompactUserSummaryMessage(summary, {
        suppressFollowUpQuestions: true,
        transcriptPath: deps.ctxMgr.getTranscriptPath(),
        recentMessagesPreserved: true,
      });
      deps.ctxMgr.compactWithSummary(formattedSummary);
      circuitBreaker.recordSuccess();
      log.info("COMPACT", `自动压缩完成，摘要 ${formattedSummary.length} 字符，剩余 ${deps.ctxMgr.messageCount()} 条消息`);
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

  // 解析不出报错文本里的具体上限时，回退到 ctxMgr 的真实上下文窗口
  // （由当前模型按 availableModels/内置 registry 推导，非硬编码 200000）。
  // 硬编码 200000 会让 1M 窗口模型的可用空间被严重低估，错误地放弃本可恢复的溢出。
  let contextLimit = ctxMgr.getMaxTokens();
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
