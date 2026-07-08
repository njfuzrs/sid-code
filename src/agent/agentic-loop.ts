/**
 * AgenticLoop — 共享的 Agent 循环核心
 *
 * 对标 claude-code 的 runAgent()，使子代理和主代理共享同一套循环逻辑。
 * 从 executeInner() 提取，消除与 AgentLoopRunner.run() 之间的代码重复。
 *
 * M5 里程碑：子代理独立 Agent Loop
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, Usage, SendParams } from "../llm/types.ts";
import { accumulateUsage, normalizeCacheUsage } from "../llm/types.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/logger.ts";
import { emitStreamPhase } from "../trace/stream-observer.ts";
import type { HookSystem } from "../hook/system.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT } from "./loop-detection.ts";
import { processStream, type StreamProcessResult } from "./stream-processor.ts";
import { executeTools } from "./tool-executor.ts";
import { isEmptyToolInput, toolHasRequiredParams } from "../query/empty-param.ts";

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
    /** 截至本轮的累计真实 token 数（input + output，来自 totalUsage），供进度面板展示 */
    tokenCount: number;
    /** 截至本轮的累计工具调用次数 */
    toolUseCount: number;
  }) => void;
  /** 循环恢复提示词（默认使用全局 LOOP_RECOVERY_PROMPT） */
  loopRecoveryPrompt?: string;
  /** LLM 请求额外参数 */
  sendParamsExtra?: Partial<SendParams>;
  /** Hook 系统（透传给工具执行，驱动子代理工具的 Pre/PostToolUse hook 与 execute_tool span）。
   *  缺省时工具执行不触发 hook（兼容无 hook 环境/测试）。 */
  hookSystem?: HookSystem;
  /** 权限检查器（子代理用 dontAsk 语义：危险命令拦截 + safetyCheck 照常生效，ask→deny）。
   *  缺省时不做权限检查（兼容旧测试 / 纯只读子代理）。 */
  permissionChecker?: import("../permission/types.ts").Checker;
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

    // T4：per-turn AbortController，与父 signal 合并后传给上游流。
    // 让 processStream 的心跳/整体超时在触发时能主动 abort 上游（而非仅靠外层
    // 5min Promise.race——它在 Bun 事件循环阻塞时可能延迟数分钟才 fire）。
    const turnAbort = new AbortController();
    const combinedSignal = AbortSignal.any([signal, turnAbort.signal]);

    // T13.1：子代理 LLM 调用 StreamPhase 事件（fetch_sent）
    const agentStreamIndex = 10000 + turns;
    const turnStartTime = Date.now();
    emitStreamPhase(agentStreamIndex, "fetch_sent", { caller: "sub-agent", model });

    const stream = provider.sendMessageStream(sendParams, combinedSignal);

    // B2: 子代理硬超时保护（对齐主循环 L1），作为 T4 setInterval 心跳之上的最后兜底
    const AGENT_STREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5min
    const timeoutPromise = new Promise<StreamProcessResult>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`子代理流式超时：${AGENT_STREAM_TIMEOUT_MS / 1000}s 无响应`));
      }, AGENT_STREAM_TIMEOUT_MS);
    });

    // 处理流式响应（T4：传入心跳 + 整体超时 + turnAbort 引用）
    let response: StreamProcessResult;
    try {
      response = await Promise.race([
        processStream(stream, {
          signal: combinedSignal,
          getAbortController: () => turnAbort,
        }),
        timeoutPromise,
      ]);
      // T13.1：子代理 LLM 调用完成
      emitStreamPhase(agentStreamIndex, "completed", { caller: "sub-agent", model, elapsed_ms: Date.now() - turnStartTime });
    } catch (err: any) {
      // T13.1：子代理 LLM 调用失败
      emitStreamPhase(agentStreamIndex, "error", { caller: "sub-agent", model, error: err.message, elapsed_ms: Date.now() - turnStartTime });
      // 超时或 abort 都走错误返回
      log.error("AGENT_LOOP", `流式处理异常: ${err.message}`);
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: err.message || "流式处理超时",
      };
    }
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
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
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

      // 空参数检测（对标主循环 F1）：弱模型退化时输出 input={} 的 tool_use，
      // 直接执行会报参数缺失错误，浪费工具执行 token。检测到后替换为错误提示让模型重试。
      const emptyParamBlocks = toolUseBlocks.filter(b => {
        if (b.type !== "tool_use") return false;
        if (!isEmptyToolInput(b.input)) return false;
        const schema = tools.get(b.name)?.inputSchema?.();
        return toolHasRequiredParams(schema);
      });
      if (emptyParamBlocks.length > 0) {
        log.warn("AGENT_LOOP", `检测到 ${emptyParamBlocks.length} 个空参数 tool_use，注入重试提示`);
        // 构造 tool_result 错误响应 + 重试提示
        const errorResults: ContentBlock[] = emptyParamBlocks.map(b => ({
          type: "tool_result" as const,
          tool_use_id: (b as { type: "tool_use"; id: string }).id,
          content: "错误：工具参数为空。请检查工具定义，提供完整的必需参数后重新调用。",
          is_error: true,
        }));
        ctxMgr.addMessage({ role: "user", content: errorResults });
        continue;
      }

      // 执行工具
      const toolResults = await executeTools(response.content, tools, signal, config.hookSystem, config.permissionChecker);
      ctxMgr.addMessage({ role: "user", content: toolResults });

      // 每轮结束回调（进度追踪 + 磁盘输出）
      const turnToolInfo = toolUseBlocks.map(b => ({
        name: b.type === "tool_use" ? b.name : "",
        input: b.type === "tool_use" ? (b.input as Record<string, unknown>) : {},
      }));
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: turnToolInfo, tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });

      continue;
    }

    // max_tokens 续写
    if (response.stopReason === "max_tokens" || response.stopReason === "length") {
      log.info("AGENT_LOOP", `输出达到 token 上限，自动续写 (轮次 ${turns})`);
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
      continue;
    }

    // 其他未知停止原因（含 null）
    // 背景（事故复盘 session 20260708-102143）：伪装成功的空流（网关对不可用模型
    // 回 200 + text/html 错误页，被解析成 0 事件）会让 stopReason=null 且 content 为空。
    // 此前本分支直接 break 落到"强制总结"路径，把空响应当成正常收尾返回给父级——
    // 掩盖真实故障。现在区分：空响应 → success:false 显式报错（对齐上方 stopReason==="error"
    // 的返回模式，让父级 loop 能如实呈现）；非空但停止原因未识别 → 保留原 break（内容已在
    // lastTextOutput 中，交给下方强制总结收尾）。
    if (response.content.length === 0) {
      log.error(
        "AGENT_LOOP",
        `空响应且停止原因异常（stopReason=${response.stopReason}），判定为伪装成功的空流，子代理中断`,
      );
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: `模型返回空响应（停止原因: ${response.stopReason ?? "null"}），疑似模型不可用或网关返回非流式错误页`,
      };
    }
    log.warn("AGENT_LOOP", `未知停止原因: ${response.stopReason}`);
    break;
  }

  // 达到最大轮次——强制请求总结（额外一轮，不计入 maxTurns）。
  // 问题：子代理达到 max_turns 被强制终止时，最后一条 assistant 消息可能是
  // "Let me check..." 这类 thinking/planning 文本，extractFinalText 取到它就
  // 导致 result 无法被主循环利用。对标 CC 的策略（Anthropic 模型 thinking 有独立 type
  // 自然被过滤），但 sid-code 支持第三方模型（DeepSeek 等），其 reasoning 混在 text block 中，
  // 无法靠 type 过滤。解法：在退出前追加一轮"请总结"，让模型输出结构化结论再退出。
  if (!signal.aborted) {
    log.info("AGENT_LOOP", `达到最大轮次 ${maxTurns}，请求强制总结`);
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "你已达到最大轮次限制，无法继续调用工具。请立即输出你到目前为止的所有发现和结论，以结构化格式（表格/列表）呈现。不要再调用任何工具，直接输出结论。" }],
    });

    // T13.1：强制总结轮同样发射 StreamPhase 事件（与主循环轮对齐，避免总结轮 LLM 调用不可见）。
    // 用独立命名空间 20000+turns，与主循环轮 10000+turns 区分，避免 index 撞车。
    const summaryStreamIndex = 20000 + turns;
    const summaryStartTime = Date.now();
    emitStreamPhase(summaryStreamIndex, "fetch_sent", { caller: "sub-agent-summary", model });

    try {
      const summaryStream = provider.sendMessageStream({
        model,
        messages: ctxMgr.getMessages(),
        system: ctxMgr.getSystemPrompt(),
        maxTokens: 4096,
        // 不传 tools，禁止模型继续调工具
        ...config.sendParamsExtra,
      }, signal);

      const summaryResponse = await processStream(summaryStream);
      accumulateUsage(totalUsage, summaryResponse.usage);
      emitStreamPhase(summaryStreamIndex, "completed", { caller: "sub-agent-summary", model, elapsed_ms: Date.now() - summaryStartTime });

      // 提取总结文本
      const summaryTexts = summaryResponse.content.filter(b => b.type === "text");
      if (summaryTexts.length > 0) {
        lastTextOutput = summaryTexts
          .map(b => b.type === "text" ? b.text : "")
          .join("\n");
      }

      // 添加总结到历史
      ctxMgr.addMessage({ role: "assistant", content: summaryResponse.content });
      config.onTurnEnd?.({ turn: turns + 1, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
    } catch (err: any) {
      // 强制总结失败不影响整体返回（降级到 extractFinalText 的启发式过滤）
      emitStreamPhase(summaryStreamIndex, "error", { caller: "sub-agent-summary", model, error: err.message, elapsed_ms: Date.now() - summaryStartTime });
      log.warn("AGENT_LOOP", `强制总结轮失败: ${err.message}`);
    }
  }

  return {
    success: true,
    turns,
    totalUsage,
    toolUseCount,
    lastTextOutput,
    messages: ctxMgr.getMessages(),
  };
}
