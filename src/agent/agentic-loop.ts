/**
 * AgenticLoop — 共享的 Agent 循环核心
 *
 * 对标 claude-code 的 runAgent()，使子代理和主代理共享同一套循环逻辑。
 * 从 executeInner() 提取，消除与 AgentLoopRunner.run() 之间的代码重复。
 *
 * M5 里程碑：子代理独立 Agent Loop
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, Usage, StreamEvent, SendParams } from "../llm/types.ts";
import { accumulateUsage, normalizeCacheUsage } from "../llm/types.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/logger.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT } from "./loop-detection.ts";
import { processStream } from "./stream-processor.ts";
import { executeTools } from "./tool-executor.ts";

// ============================================================
// 配置接口
// ============================================================

/** Agent 循环配置 */
export interface AgentLoopConfig {
  /** LLM Provider */
  provider: Provider;
  /** 模型名称 */
  model: string;
  /** 上下文管理器（系统提示词和首条用户消息已预先填充） */
  ctxMgr: ContextManager;
  /** 工具注册表（已过滤） */
  tools: ToolRegistry;
  /** 最大轮次 */
  maxTurns: number;
  /** 中止信号 */
  signal: AbortSignal;
  /** 循环检测器（外部创建，便于生命周期控制） */
  loopDetector: LoopDetector;
  /** 流式文本回调（用于 TUI 实时显示） */
  onStreamText?: (text: string) => void;
  /** 每轮开始前的回调（用于 SendMessage 注入等） */
  onBeforeTurn?: (turn: number) => void;
  /** 每轮结束后的回调（含本轮文本和工具信息，用于磁盘输出 + 进度追踪） */
  onTurnEnd?: (info: {
    turn: number;
    /** 本轮文本输出（完整内容） */
    textOutput: string;
    /** 本轮工具调用信息 */
    tools: Array<{ name: string; input: Record<string, unknown> }>;
  }) => void;
  /** 循环恢复提示词（默认使用全局 LOOP_RECOVERY_PROMPT） */
  loopRecoveryPrompt?: string;
  /** LLM 请求额外参数 */
  sendParamsExtra?: Partial<SendParams>;
}

/** Agent 循环结果 */
export interface AgentLoopResult {
  success: boolean;
  turns: number;
  totalUsage: Usage;
  toolUseCount: number;
  /** 最后一轮的文本输出 */
  lastTextOutput: string;
  /** 累积的上下文消息 */
  messages: Array<{ role: string; content: ContentBlock[] }>;
  /** 失败时携带的错误消息 */
  errorMessage?: string;
}

// ============================================================
// 核心循环函数
// ============================================================

/**
 * 运行 Agent 循环核心
 *
 * 处理 LLM 流式响应、工具调用、循环检测的标准模式。
 * 调用方负责：创建 ctxMgr（含 system prompt 和首条 user 消息）、
 * 创建 tools（已过滤）、创建 loopDetector（生命周期控制）。
 *
 * 对标 claude-code runAgent()，一个函数同时服务于主 Agent 和子 Agent。
 */
export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const log = getLogger();
  const {
    provider, model, ctxMgr, tools, maxTurns, signal, loopDetector,
    loopRecoveryPrompt = LOOP_RECOVERY_PROMPT,
  } = config;

  let turns = 0;
  let toolUseCount = 0;
  let lastTextOutput = "";
  const totalUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  while (turns < maxTurns) {
    turns++;
    log.debug("AGENT_LOOP", `轮次 ${turns}/${maxTurns}`);

    // 每轮开始前的回调（SendMessage 注入等）
    config.onBeforeTurn?.(turns);

    const toolDefs = tools.size() > 0 ? tools.definitions() : undefined;

    const sendParams: SendParams = {
      model,
      messages: ctxMgr.getMessages(),
      system: ctxMgr.getSystemPrompt(),
      maxTokens: 4096,
      tools: toolDefs,
      ...config.sendParamsExtra,
    };

    const stream = provider.sendMessageStream(sendParams, signal);

    // 处理流式响应
    const response = await processStream(stream);
    if (config.onStreamText) {
      const responseText = response.content
        .filter(b => b.type === "text")
        .map(b => b.type === "text" ? b.text : "")
        .join("");
      if (responseText) config.onStreamText(responseText);
    }

    // LLM API 错误：返回失败（不 throw，由调用方转换为状态变更）
    if (response.stopReason === "error") {
      log.error("AGENT_LOOP", `LLM 错误: ${response.errorMessage}`);
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: response.errorMessage || "LLM 错误",
      };
    }

    // 累加本轮 usage（统一走 accumulateUsage，补齐 cacheRead/cacheCreation 字段；
    // response.usage 已是本轮 processStream 累加好的完整 usage）
    accumulateUsage(totalUsage, response.usage);

    // P1-6/P1-7：用真实 usage 校准子代理上下文估算器（防 compact 触发过晚 → 溢出）
    try {
      const norm = normalizeCacheUsage(response.usage, provider.name());
      ctxMgr.recordActualTokens(norm.promptTotal, tools.size());
    } catch { /* 校准失败不影响子代理循环 */ }

    // 提取文本输出
    const textBlocks = response.content.filter(b => b.type === "text");
    if (textBlocks.length > 0) {
      lastTextOutput = textBlocks
        .map(b => b.type === "text" ? b.text : "")
        .join("\n");
    }

    // 添加助手消息到历史
    ctxMgr.addMessage({ role: "assistant", content: response.content });

    // 内容循环检测
    if (lastTextOutput && loopDetector.recordContent(lastTextOutput)) {
      if (!loopDetector.tryRecover()) {
        log.warn("AGENT_LOOP", "内容循环恢复次数耗尽，终止");
        return {
          success: false,
          turns,
          totalUsage,
          toolUseCount,
          lastTextOutput,
          messages: ctxMgr.getMessages(),
          errorMessage: "内容循环恢复次数耗尽",
        };
      }
      log.info("AGENT_LOOP", "检测到内容循环，注入恢复提示");
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: loopRecoveryPrompt }],
      });
      continue;
    }

    // 停止原因处理
    if (response.stopReason === "end_turn" || response.stopReason === "stop") {
      log.info("AGENT_LOOP", `完成，共 ${turns} 轮`);
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [] });
      return {
        success: true,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
      };
    }

    // 工具调用
    if (response.stopReason === "tool_use") {
      // 工具调用循环检测
      let loopDetected = false;
      for (const block of response.content) {
        if (block.type === "tool_use") {
          if (loopDetector.recordToolCall(block.name, block.input)) {
            loopDetected = true;
            break;
          }
        }
      }
      if (loopDetected) {
        if (!loopDetector.tryRecover()) {
          log.warn("AGENT_LOOP", "工具循环恢复次数耗尽，终止");
          return {
            success: false,
            turns,
            totalUsage,
            toolUseCount,
            lastTextOutput,
            messages: ctxMgr.getMessages(),
            errorMessage: "工具循环恢复次数耗尽",
          };
        }
        log.info("AGENT_LOOP", "检测到工具循环，注入恢复提示");
        ctxMgr.addMessage({
          role: "user",
          content: [{ type: "text", text: loopRecoveryPrompt }],
        });
        continue;
      }

      // 统计工具调用次数
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      toolUseCount += toolUseBlocks.length;

      // 执行工具
      const toolResults = await executeTools(response.content, tools, signal);
      ctxMgr.addMessage({ role: "user", content: toolResults });

      // 每轮结束回调（进度追踪 + 磁盘输出）
      const turnToolInfo = toolUseBlocks.map(b => ({
        name: b.type === "tool_use" ? b.name : "",
        input: b.type === "tool_use" ? (b.input as Record<string, unknown>) : {},
      }));
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: turnToolInfo });

      continue;
    }

    // max_tokens 续写
    if (response.stopReason === "max_tokens" || response.stopReason === "length") {
      log.info("AGENT_LOOP", `输出达到 token 上限，自动续写 (轮次 ${turns})`);
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [] });
      continue;
    }

    // 其他未知停止原因
    log.warn("AGENT_LOOP", `未知停止原因: ${response.stopReason}`);
    break;
  }

  // 达到最大轮次
  return {
    success: true,
    turns,
    totalUsage,
    toolUseCount,
    lastTextOutput,
    messages: ctxMgr.getMessages(),
  };
}
