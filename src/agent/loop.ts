/**
 * AgentLoopRunner — 统一的 Agentic While-Loop 核心循环
 * 消除 app.ts 中 agentLoop() 和 tuiAgentLoop() 的重复代码
 * 通过回调接口处理 REPL/TUI 的 UI 差异
 */

import type { Provider } from "../llm/provider.ts";
import type {
  ContentBlock,
  StreamEvent,
  AccumulatedResponse,
  SendParams,
} from "../llm/types.ts";
import type { Config } from "../config/config.ts";
import type { QuotaManager } from "../llm/quota.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { ModelFallback } from "../llm/fallback.ts";
import { ThinkingManager } from "../llm/thinking.ts";
import { SessionState } from "../session/state.ts";
import { getLogger } from "../debug/logger.ts";
import type { HookRunner } from "../hook/runner.ts";

/** UI 回调接口，处理 REPL/TUI 的差异 */
export interface AgentLoopCallbacks {
  /** 流式文本输出 */
  onStreamText(text: string): void;
  /** 工具开始执行 */
  onToolStart(toolName: string, toolInput?: unknown): void;
  /** 工具执行结束 */
  onToolEnd(toolName: string, result?: { isError?: boolean; elapsedMs?: number }): void;
  /** 上下文压缩完成 */
  onCompact(): void;
  /** 循环结束 */
  onComplete(turns: number): void;
  /** 上下文剩余警告 */
  onContextWarning?(remaining: number): void;
  /** 最大轮次警告 */
  onMaxTurns?(maxTurns: number): void;
}

/** AgentLoopRunner 依赖 */
export interface AgentLoopDeps {
  config: Config;
  provider: Provider;
  ctxMgr: ContextManager;
  toolRegistry: ToolRegistry;
  sessionState: SessionState;
  fallback: ModelFallback;
  thinkingMgr: ThinkingManager;
  hookRunner?: HookRunner;
  quotaManager?: QuotaManager;
  /** 执行工具调用（含权限检查） */
  executeTools: (content: ContentBlock[]) => Promise<ContentBlock[]>;
  /** 处理流式响应 */
  processStream: (
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
  ) => Promise<AccumulatedResponse>;
  /** 自动压缩 */
  autoCompact: () => Promise<void>;
  /** 处理上下文溢出 */
  handleContextOverflow: (err: any, currentMaxTokens: number) => number | null;
  /** 获取 abort signal */
  getAbortSignal: () => AbortSignal | undefined;
}

export class AgentLoopRunner {
  private deps: AgentLoopDeps;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
  }

  /** 更新 Provider（模型切换时调用） */
  updateProvider(provider: Provider): void {
    this.deps.provider = provider;
  }

  /** 发送消息给 LLM（带重试和回退） */
  private sendWithRetry(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.deps.fallback.reset();
    return this.deps.fallback.executeWithFallback(this.deps.provider, params, signal);
  }

  /** 运行 Agent 循环 */
  async run(userInput: string, callbacks: AgentLoopCallbacks): Promise<void> {
    const log = getLogger();
    const { config, ctxMgr, toolRegistry, sessionState } = this.deps;

    log.info("AGENT", `用户输入: ${userInput.slice(0, 200)}${userInput.length > 200 ? "..." : ""}`);

    // user_prompt_submit hook：可拦截或修改用户输入
    let finalInput = userInput;
    if (this.deps.hookRunner) {
      const hookResults = await this.deps.hookRunner.run("user_prompt_submit", {
        userInput,
      });
      // 检查是否被阻止
      const blocked = hookResults.find(r => r.blocked);
      if (blocked) {
        log.info("HOOK", `用户输入被 hook 阻止: ${blocked.reason || "无原因"}`);
        return;
      }
      // 检查是否修改了输入
      const modified = hookResults.find(r => r.modifiedInput);
      if (modified?.modifiedInput) {
        log.info("HOOK", `用户输入被 hook 修改`);
        finalInput = modified.modifiedInput;
      }
    }

    // 解析 thinking hint（如 "think", "think hard", "ultrathink"）
    const { cleaned: cleanedInput, config: thinkingConfig } =
      this.deps.thinkingMgr.parseThinkingHint(finalInput);
    // 如果没有显式 hint，根据输入自动推断
    const thinking = thinkingConfig ?? this.deps.thinkingMgr.getThinkingConfig(cleanedInput);

    // 添加用户消息（使用清理后的输入）
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: cleanedInput }],
    });

    let turns = 0;
    const maxTurns = config.maxTurns || 50;

    while (turns < maxTurns) {
      turns++;

      // 上下文使用率监控（两段式触发，对标 Claude Code）
      const toolCount = toolRegistry.size();
      const currentTokens = ctxMgr.estimateTokens(toolCount);
      const contextMax = ctxMgr.getMaxTokens();
      const usagePercent = (currentTokens / contextMax) * 100;
      const remaining = 100 - usagePercent;

      log.info("AGENT", `轮次 ${turns}/${maxTurns}，消息数 ${ctxMgr.getMessages().length}，上下文 ${usagePercent.toFixed(0)}%`);

      if (remaining <= 0) {
        log.warn("AGENT", "上下文已满，强制压缩");
        await this.deps.autoCompact();
        callbacks.onCompact();
      } else if (remaining <= 6) {
        callbacks.onContextWarning?.(remaining);
      } else if (ctxMgr.needsCompaction(toolCount)) {
        log.warn("AGENT", `上下文接近上限 (${currentTokens} tokens, ${usagePercent.toFixed(0)}%)，触发自动压缩`);
        await this.deps.autoCompact();
        callbacks.onCompact();
      }

      // 构建请求参数
      const cleanedMessages = ctxMgr.getCleanedMessages();
      const toolDefs = toolCount > 0 ? toolRegistry.definitions() : undefined;
      log.llmRequest(config.provider, config.model, cleanedMessages.length, toolDefs?.length ?? 0, config.maxTokens);
      log.info("LLM", `系统提示词 ${ctxMgr.getSystemPrompt().length}字符`);

      const sendParams: SendParams = {
        model: config.model,
        messages: cleanedMessages,
        system: ctxMgr.getSystemPrompt(),
        maxTokens: config.maxTokens,
        tools: toolDefs,
        // Extended Thinking（仅首轮传入，后续工具循环不需要）
        thinking: turns === 1 ? thinking : undefined,
      };

      // 发送请求（含上下文溢出自动调整）
      let stream: AsyncIterable<StreamEvent>;
      const signal = this.deps.getAbortSignal();
      try {
        stream = this.sendWithRetry(sendParams, signal);
      } catch (err: any) {
        const adjusted = this.deps.handleContextOverflow(err, sendParams.maxTokens);
        if (adjusted !== null) {
          log.info("AGENT", `上下文溢出，自动调整 maxTokens: ${sendParams.maxTokens} → ${adjusted}`);
          sendParams.maxTokens = adjusted;
          stream = this.sendWithRetry(sendParams, signal);
        } else {
          log.warn("AGENT", "上下文溢出且无法调整 maxTokens，触发自动压缩");
          await this.deps.autoCompact();
          callbacks.onCompact();
          continue;
        }
      }

      // 处理流式响应（记录 API 耗时）
      const apiStart = Date.now();
      const response = await this.deps.processStream(stream, (text) => {
        callbacks.onStreamText(text);
      });
      const apiDuration = Date.now() - apiStart;

      // 更新 SessionState
      sessionState.updateUsage(config.model, response.usage, apiDuration);

      // 成本配额检查
      if (this.deps.quotaManager) {
        const quotaResult = this.deps.quotaManager.check(sessionState.totalCostUSD);
        if (quotaResult) {
          if (quotaResult.level === "exceeded") {
            callbacks.onStreamText(`\n⚠️ ${quotaResult.message}\n`);
            callbacks.onComplete(turns);
            break;
          } else if (quotaResult.level === "critical" || quotaResult.level === "warning") {
            callbacks.onStreamText(`\n⚠️ ${quotaResult.message}\n`);
          }
        }
      }

      log.llmResponse(response.stopReason || "unknown", response.usage, apiDuration, sessionState.totalCostUSD);
      const totalUsage = sessionState.getTotalUsage();
      log.debug("AGENT", `累计用量: input=${totalUsage.inputTokens}, output=${totalUsage.outputTokens}, 费用=$${sessionState.totalCostUSD.toFixed(4)}`);

      // 记录 LLM 回复文本内容
      const responseText = response.content
        .filter(b => b.type === "text")
        .map(b => b.type === "text" ? b.text : "")
        .join("");
      if (responseText) {
        log.llmResponseText(responseText);
      }

      // 添加助手消息到历史
      ctxMgr.addMessage({
        role: "assistant",
        content: response.content,
      });

      // 检查停止原因
      if (response.stopReason === "end_turn" || response.stopReason === "stop") {
        log.info("AGENT", `对话结束 (${response.stopReason})，共 ${turns} 轮，累计费用 $${sessionState.totalCostUSD.toFixed(4)}`);
        callbacks.onComplete(turns);
        break;
      }

      // 处理工具调用
      if (response.stopReason === "tool_use") {
        const toolBlocks = response.content.filter(b => b.type === "tool_use");
        const toolNames = toolBlocks.map(b => b.type === "tool_use" ? b.name : "").filter(Boolean);
        log.info("AGENT", `工具调用: ${toolNames.join(", ")}`);

        for (const b of toolBlocks) {
          if (b.type === "tool_use") {
            callbacks.onToolStart(b.name, b.input);
          }
        }

        const toolStartTime = Date.now();
        const toolResults = await this.deps.executeTools(response.content);
        const toolElapsed = Date.now() - toolStartTime;
        ctxMgr.addMessage({ role: "user", content: toolResults });

        // 从结果中提取最后一个工具的 isError 状态
        const lastResult = toolResults[toolResults.length - 1];
        const lastIsError = lastResult && lastResult.type === "tool_result" ? !!lastResult.is_error : false;
        const lastName = toolNames[toolNames.length - 1] || "";

        callbacks.onToolEnd(lastName, { isError: lastIsError, elapsedMs: toolElapsed });
        continue;
      }

      // max_tokens 续写
      if (response.stopReason === "max_tokens" || response.stopReason === "length") {
        log.info("AGENT", `输出达到 token 上限，自动续写 (轮次 ${turns})`);
        continue;
      }

      // 其他停止原因
      log.warn("AGENT", `未知停止原因: ${response.stopReason}`);
      callbacks.onComplete(turns);
      break;
    }

    if (turns >= maxTurns) {
      log.warn("AGENT", `达到最大轮次限制: ${maxTurns}`);
      callbacks.onMaxTurns?.(maxTurns);
    }
  }
}
