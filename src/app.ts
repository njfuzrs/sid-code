/**
 * 应用主循环
 * 实现 Agentic While-Loop：用户输入 → LLM 流式响应 → 工具调用 → 循环
 */

import type { Provider } from "./llm/provider.ts";
import type {
  ContentBlock,
  ToolUseBlock,
  StreamEvent,
  AccumulatedResponse,
  SendParams,
} from "./llm/types.ts";
import type { Config } from "./config/config.ts";
import type { Checker } from "./permission/types.ts";
import { Manager as ContextManager } from "./context/manager.ts";
import { Registry as ToolRegistry } from "./tool/registry.ts";
import { Registry as CommandRegistry } from "./command/registry.ts";
import { ModelFallback } from "./llm/fallback.ts";
import { ThinkingManager } from "./llm/thinking.ts";
import { SessionState } from "./session/state.ts";
import { loadCLAUDEmd } from "./config/rules.ts";
import { getLogger } from "./debug/logger.ts";
import { maskSensitiveData } from "./permission/sensitive.ts";
import * as readline from "readline";

/** App 配置 */
export interface AppOptions {
  config: Config;
  provider: Provider;
  toolRegistry?: ToolRegistry;
  commandRegistry?: CommandRegistry;
  permissionChecker?: Checker;
  initialPrompt?: string;
}

export class App {
  private config: Config;
  private provider: Provider;
  private ctxMgr: ContextManager;
  private toolRegistry: ToolRegistry;
  private commandRegistry: CommandRegistry;
  private permissionChecker: Checker | null;
  private fallback: ModelFallback;
  private thinkingMgr: ThinkingManager;
  private sessionState: SessionState;
  private abortController: AbortController | null = null;
  private isTUIMode: boolean = false;
  /** TUI 模式下的权限确认回调（由 TUI 注入） */
  private tuiConfirmCallback: ((desc: string) => Promise<boolean>) | null = null;

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.provider = opts.provider;
    this.toolRegistry = opts.toolRegistry ?? new ToolRegistry();
    this.commandRegistry = opts.commandRegistry ?? new CommandRegistry();
    this.permissionChecker = opts.permissionChecker ?? null;
    this.ctxMgr = new ContextManager({ maxTokens: 200000 });
    this.sessionState = new SessionState(
      opts.config.sessionId || crypto.randomUUID().slice(0, 8),
    );
    // Extended Thinking 仅 Anthropic 支持
    this.thinkingMgr = new ThinkingManager(opts.config.provider === "anthropic");
    this.fallback = new ModelFallback({ maxRetries: 3 }, {
      onRetry: (attempt, error, delayMs) => {
        const log = getLogger();
        log.info("FALLBACK", `重试 ${attempt}，错误: ${error}，延迟 ${delayMs}ms`);
        if (!this.isTUIMode) {
          console.log(`\n[重试 ${attempt}，${delayMs}ms 后重试...]`);
        }
      },
      onFallback: (reason, model) => {
        const log = getLogger();
        log.warn("FALLBACK", `降级到 ${model}，原因: ${reason}`);
        if (!this.isTUIMode) {
          console.log(`\n[模型降级到 ${model}]`);
        }
      },
    });
  }

  /** 发送消息给 LLM（带重试和回退） */
  private sendWithRetry(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.fallback.reset();
    return this.fallback.executeWithFallback(this.provider, params, signal);
  }

  /**
   * 处理上下文溢出错误，尝试自动缩小 max_tokens
   * 返回调整后的 maxTokens，无法恢复时返回 null
   */
  private handleContextOverflow(err: any, currentMaxTokens: number): number | null {
    const msg = err.message || String(err);
    // 匹配常见的上下文溢出错误格式
    const overflowMatch = msg.match(/(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
    if (!overflowMatch && !msg.toLowerCase().includes("context") && !msg.toLowerCase().includes("token")) {
      return null; // 不是上下文溢出错误
    }

    let contextLimit = 200000; // 默认上下文窗口
    let inputTokens = 0;

    if (overflowMatch) {
      inputTokens = parseInt(overflowMatch[1], 10);
      contextLimit = parseInt(overflowMatch[3], 10);
    } else {
      // 用估算值
      inputTokens = this.ctxMgr.estimateTokens(this.toolRegistry.size());
    }

    // 留 1000 token buffer
    const available = Math.max(0, contextLimit - inputTokens - 1000);

    // 至少需要 3000 tokens 输出空间，否则没意义
    if (available < 3000) {
      return null;
    }

    return available;
  }

  /**
   * 自动压缩：上下文接近上限时，用 LLM 生成摘要并压缩消息历史
   * 如果 LLM 不可用，则使用简单截断策略
   */
  private async autoCompact(): Promise<void> {
    const log = getLogger();
    const messages = this.ctxMgr.getMessages();

    if (messages.length <= 4) {
      log.debug("AGENT", "消息太少，跳过压缩");
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

      const stream = this.provider.sendMessageStream(
        {
          model: this.config.model,
          messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }] }],
          system: "你是一个对话摘要助手。请简洁准确地总结对话内容。",
          maxTokens: 2000,
        },
        this.abortController?.signal,
      );

      let summary = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          summary += event.delta.text;
        }
      }

      if (summary) {
        this.ctxMgr.compactWithSummary(summary);
        log.info("AGENT", `自动压缩完成，摘要 ${summary.length} 字符，剩余 ${this.ctxMgr.messageCount()} 条消息`);
        if (!this.isTUIMode) {
          console.log("\n[上下文已自动压缩]");
        }
        return;
      }
    } catch (err: any) {
      log.warn("AGENT", `LLM 摘要失败，使用简单截断: ${err.message}`);
    }

    // 降级：简单截断（保留最近消息，丢弃旧消息）
    const simpleSummary = `[自动截断] 之前有 ${messages.length - 4} 条消息被截断以释放上下文空间。`;
    this.ctxMgr.compactWithSummary(simpleSummary);
    log.info("AGENT", `简单截断完成，剩余 ${this.ctxMgr.messageCount()} 条消息`);
    if (!this.isTUIMode) {
      console.log("\n[上下文已自动截断]");
    }
  }

  /** 初始化：加载系统提示词 */
  async init(): Promise<void> {
    const log = getLogger();
    log.info("APP", "开始初始化...");

    let systemPrompt = this.config.systemPrompt;

    if (!systemPrompt) {
      // 加载 CLAUDE.md 规则
      const rules = await loadCLAUDEmd(process.cwd());
      if (rules) {
        log.debug("APP", `加载 CLAUDE.md 规则 (${rules.length} 字符)`);
      }

      // 从文件加载系统提示词
      let filePrompt: string | undefined;
      if (this.config.systemPromptFile) {
        try {
          const content = await Bun.file(this.config.systemPromptFile).text();
          filePrompt = content;
          log.debug("APP", `加载系统提示词文件: ${this.config.systemPromptFile}`);
        } catch (err) {
          log.error("APP", `加载系统提示词文件失败: ${err}`);
          console.error(`加载系统提示词文件失败: ${err}`);
        }
      }

      // 使用新的系统提示词构建模块
      const { buildSystemPrompt } = await import("./config/system-prompt.ts");
      systemPrompt = buildSystemPrompt({
        tools: this.toolRegistry.all(),
        projectRules: rules || undefined,
        appendPrompt: this.config.appendSystemPrompt || undefined,
        filePrompt,
      });
    }

    this.ctxMgr.setSystemPrompt(systemPrompt);
    log.info("APP", `初始化完成，系统提示词 ${systemPrompt.length} 字符，工具数 ${this.toolRegistry.size()}`);
  }

  /**
   * 恢复会话：从 SessionData 恢复消息历史
   * 如果消息太多，注入摘要而非完整历史
   */
  async restoreSession(sessionData: import("./session/store.ts").SessionData): Promise<void> {
    const log = getLogger();
    const { SessionStore } = await import("./session/store.ts");

    log.info("APP", `恢复会话: ${sessionData.id}, 消息数 ${sessionData.messages.length}`);

    // 如果消息数量不多，直接恢复
    const SUMMARY_THRESHOLD = 20;
    if (sessionData.messages.length <= SUMMARY_THRESHOLD) {
      this.ctxMgr.setMessages(sessionData.messages);
      log.info("APP", `直接恢复 ${sessionData.messages.length} 条消息`);
      return;
    }

    // 消息太多，尝试加载摘要
    const store = new SessionStore();
    const summary = await store.loadSummary(sessionData.id);

    if (summary) {
      // 有摘要，注入摘要 + 最近消息
      const recentMessages = sessionData.messages.slice(-10);
      const resumeMsg = SessionStore.buildResumeMessage(summary.summary);
      this.ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: resumeMsg }],
      });
      this.ctxMgr.addMessage({
        role: "assistant",
        content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
      });
      for (const msg of recentMessages) {
        this.ctxMgr.addMessage(msg);
      }
      log.info("APP", `恢复会话：摘要 + 最近 ${recentMessages.length} 条消息`);
    } else {
      // 无摘要，简单截断
      const recentMessages = sessionData.messages.slice(-15);
      this.ctxMgr.setMessages(recentMessages);
      log.warn("APP", `无摘要，仅恢复最近 ${recentMessages.length} 条消息`);
    }
  }

  /** 处理流式响应，累积内容块（含心跳检测） */
  async processStream(
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
  ): Promise<AccumulatedResponse> {
    const log = getLogger();
    const response: AccumulatedResponse = {
      role: "assistant",
      content: [],
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    // 用于累积工具调用的 JSON 分片
    const jsonAccumulators = new Map<number, string>();

    // 心跳检测：30 秒无数据则认为流挂死
    const HEARTBEAT_TIMEOUT = 30_000;
    const HEARTBEAT_CHECK_INTERVAL = 5_000;
    let lastActivityTime = Date.now();
    let heartbeatError: Error | null = null;

    const heartbeatTimer = setInterval(() => {
      if (Date.now() - lastActivityTime > HEARTBEAT_TIMEOUT) {
        heartbeatError = new Error("Stream heartbeat timeout: 30 秒无数据");
        log.warn("STREAM", "心跳超时，30 秒未收到任何事件");
        // 通过 abort 中断流
        this.abortController?.abort();
      }
    }, HEARTBEAT_CHECK_INTERVAL);

    try {
    for await (const event of stream) {
      lastActivityTime = Date.now();
      switch (event.type) {
        case "message_start":
          response.usage.inputTokens += event.message.usage.inputTokens;
          response.usage.outputTokens += event.message.usage.outputTokens;
          break;

        case "content_block_start":
          if (event.content_block.type === "text") {
            response.content[event.index] = { type: "text", text: "" };
          } else if (event.content_block.type === "tool_use") {
            response.content[event.index] = {
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            };
            jsonAccumulators.set(event.index, "");
          }
          break;

        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            const block = response.content[event.index];
            if (block?.type === "text") {
              block.text += delta.text;
              onText?.(delta.text);
            }
          } else if (delta.type === "input_json_delta") {
            const acc = jsonAccumulators.get(event.index) ?? "";
            jsonAccumulators.set(event.index, acc + delta.partial_json);
          }
          break;
        }

        case "content_block_stop": {
          // 解析累积的 JSON
          const jsonStr = jsonAccumulators.get(event.index);
          if (jsonStr !== undefined) {
            const block = response.content[event.index];
            if (block?.type === "tool_use") {
              try {
                block.input = jsonStr ? JSON.parse(jsonStr) : {};
              } catch {
                block.input = {};
              }
            }
            jsonAccumulators.delete(event.index);
          }
          break;
        }

        case "message_delta":
          response.stopReason = event.delta.stop_reason;
          response.usage.outputTokens += event.usage.outputTokens;
          break;

        case "error":
          throw new Error(`LLM 错误: ${event.error.message}`);
      }
    }
    } finally {
      clearInterval(heartbeatTimer);
    }

    // 如果是心跳超时导致的中断，抛出心跳错误（触发重试）
    if (heartbeatError) {
      throw heartbeatError;
    }

    return response;
  }

  /** Agentic 主循环：发送消息 → 处理响应 → 执行工具 → 循环 */
  async agentLoop(userInput: string): Promise<void> {
    const log = getLogger();
    log.info("AGENT", `用户输入: ${userInput.slice(0, 200)}${userInput.length > 200 ? '...' : ''}`);

    // 解析 thinking hint（如 "think", "think hard", "ultrathink"）
    const { cleaned: cleanedInput, config: thinkingConfig } = this.thinkingMgr.parseThinkingHint(userInput);
    // 如果没有显式 hint，根据输入自动推断
    const thinking = thinkingConfig ?? this.thinkingMgr.getThinkingConfig(cleanedInput);

    // 添加用户消息（使用清理后的输入）
    this.ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: cleanedInput }],
    });

    let turns = 0;
    const maxTurns = this.config.maxTurns || 50;

    while (turns < maxTurns) {
      turns++;
      log.debug("AGENT", `轮次 ${turns}/${maxTurns}，消息数 ${this.ctxMgr.getMessages().length}`);

      // 上下文溢出检测：接近上限时自动压缩
      const toolCount = this.toolRegistry.size();
      if (this.ctxMgr.needsCompaction(toolCount)) {
        log.warn("AGENT", `上下文接近上限 (${this.ctxMgr.estimateTokens(toolCount)} tokens)，触发自动压缩`);
        await this.autoCompact();
      }

      // 发送消息给 LLM（使用清理后的消息，旧的大输出会被替换，带重试和回退）
      const cleanedMessages = this.ctxMgr.getCleanedMessages();
      const toolDefs = toolCount > 0 ? this.toolRegistry.definitions() : undefined;
      log.llmRequest(this.config.provider, this.config.model, cleanedMessages.length, toolDefs?.length ?? 0);

      // 构建请求参数（maxTokens 可能被上下文溢出自动调整）
      const sendParams: SendParams = {
        model: this.config.model,
        messages: cleanedMessages,
        system: this.ctxMgr.getSystemPrompt(),
        maxTokens: this.config.maxTokens,
        tools: toolDefs,
        // Extended Thinking（仅首轮传入，后续工具循环不需要）
        thinking: turns === 1 ? thinking : undefined,
      };

      let stream: AsyncIterable<StreamEvent>;
      try {
        stream = this.sendWithRetry(sendParams, this.abortController?.signal);
      } catch (err: any) {
        // 上下文溢出自动调整 max_tokens
        const adjusted = this.handleContextOverflow(err, sendParams.maxTokens);
        if (adjusted !== null) {
          log.info("AGENT", `上下文溢出，自动调整 maxTokens: ${sendParams.maxTokens} → ${adjusted}`);
          sendParams.maxTokens = adjusted;
          stream = this.sendWithRetry(sendParams, this.abortController?.signal);
        } else {
          // 无法调整，触发自动压缩后重试
          log.warn("AGENT", "上下文溢出且无法调整 maxTokens，触发自动压缩");
          await this.autoCompact();
          continue;
        }
      }

      // 处理流式响应（记录 API 耗时）
      const apiStart = Date.now();
      const response = await this.processStream(stream, (text) => {
        process.stdout.write(text);
      });
      const apiDuration = Date.now() - apiStart;

      // 更新 SessionState（按模型分开统计 + 成本计算 + 耗时追踪）
      this.sessionState.updateUsage(this.config.model, response.usage, apiDuration);

      log.llmResponse(response.stopReason || "unknown", response.usage);
      const totalUsage = this.sessionState.getTotalUsage();
      log.debug("AGENT", `累计用量: input=${totalUsage.inputTokens}, output=${totalUsage.outputTokens}, 费用=$${this.sessionState.totalCostUSD.toFixed(4)}`);

      // 添加助手消息到历史
      this.ctxMgr.addMessage({
        role: "assistant",
        content: response.content,
      });

      // 检查停止原因
      if (response.stopReason === "end_turn" || response.stopReason === "stop") {
        log.info("AGENT", `对话结束 (${response.stopReason})，共 ${turns} 轮`);
        process.stdout.write("\n");
        break;
      }

      // 处理工具调用
      if (response.stopReason === "tool_use") {
        const toolBlocks = response.content.filter(b => b.type === "tool_use");
        log.info("AGENT", `工具调用: ${toolBlocks.map(b => b.type === "tool_use" ? b.name : "").join(", ")}`);

        const toolResults = await this.executeTools(response.content);
        // 添加工具结果到历史
        this.ctxMgr.addMessage({
          role: "user",
          content: toolResults,
        });
        // 继续循环
        continue;
      }

      // max_tokens 续写：模型输出撞上 token 上限，自动继续
      if (response.stopReason === "max_tokens" || response.stopReason === "length") {
        log.info("AGENT", `输出达到 token 上限，自动续写 (轮次 ${turns})`);
        // 不需要添加额外消息，模型会自动接着上次的内容继续
        continue;
      }

      // 其他停止原因
      log.warn("AGENT", `未知停止原因: ${response.stopReason}`);
      process.stdout.write("\n");
      break;
    }

    if (turns >= maxTurns) {
      log.warn("AGENT", `达到最大轮次限制: ${maxTurns}`);
      console.log(`\n[达到最大轮次限制: ${maxTurns}]`);
    }
  }

  /** 设置 TUI 模式下的权限确认回调 */
  setTUIConfirmCallback(cb: (desc: string) => Promise<boolean>): void {
    this.tuiConfirmCallback = cb;
  }

  /** 请求用户确认（根据运行模式选择不同方式） */
  private async requestUserConfirmation(description: string): Promise<boolean> {
    // TUI 模式：使用注入的回调
    if (this.isTUIMode && this.tuiConfirmCallback) {
      return this.tuiConfirmCallback(description);
    }

    // REPL 模式：使用 readline
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(`\n[权限请求] ${description}\n允许执行？(y/n) `, (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
      });
    });
  }

  /** 执行工具调用（含权限检查，只读工具并行、写入工具串行） */
  async executeTools(content: ContentBlock[]): Promise<ContentBlock[]> {
    const log = getLogger();

    // 提取所有 tool_use 块，保留原始顺序索引
    const toolBlocks = content
      .map((block, idx) => ({ block, idx }))
      .filter((item): item is { block: ToolUseBlock; idx: number } => item.block.type === "tool_use");

    if (toolBlocks.length === 0) return [];

    // 权限预检：先对所有工具做权限检查，收集通过/拒绝结果
    const checkedTools: { block: ToolUseBlock; tool: import("./tool/types.ts").Tool; idx: number }[] = [];
    const rejectedResults: Map<number, ContentBlock> = new Map();

    for (const { block, idx } of toolBlocks) {
      const tool = this.toolRegistry.get(block.name);
      if (!tool) {
        log.error("TOOL", `工具未找到: ${block.name}`);
        rejectedResults.set(idx, {
          type: "tool_result",
          tool_use_id: block.id,
          content: `工具 "${block.name}" 未找到`,
          is_error: true,
        });
        continue;
      }

      // 权限检查
      if (this.permissionChecker) {
        const decision = await this.permissionChecker.check({
          toolName: block.name,
          input: block.input,
          description: (block.input as any)?.description
            ? `${block.name}: ${(block.input as any).description}`
            : `${block.name}: ${JSON.stringify(block.input).slice(0, 120)}`,
        });

        if (!decision.allowed) {
          if (decision.needsConfirmation) {
            const desc = decision.reason || `工具 "${block.name}" 需要用户确认`;
            log.info("PERMISSION", `请求用户确认: ${desc}`);
            const confirmed = await this.requestUserConfirmation(desc);
            if (!confirmed) {
              log.info("PERMISSION", `用户拒绝: ${block.name}`);
              rejectedResults.set(idx, {
                type: "tool_result",
                tool_use_id: block.id,
                content: `用户拒绝执行工具 "${block.name}"`,
                is_error: true,
              });
              continue;
            }
            log.info("PERMISSION", `用户批准: ${block.name}`);
          } else {
            log.warn("PERMISSION", `权限拒绝: ${block.name} - ${decision.reason}`);
            if (!this.isTUIMode) {
              console.log(`\n[权限拒绝] ${decision.reason}`);
            }
            rejectedResults.set(idx, {
              type: "tool_result",
              tool_use_id: block.id,
              content: `权限拒绝: ${decision.reason}`,
              is_error: true,
            });
            continue;
          }
        }
      }

      checkedTools.push({ block, tool, idx });
    }

    // 分离只读和写入工具
    const readOnlyTools = checkedTools.filter(({ tool }) => tool.readOnly?.() === true);
    const writingTools = checkedTools.filter(({ tool }) => tool.readOnly?.() !== true);

    log.debug("TOOL", `工具分类: 只读 ${readOnlyTools.length} 个并行执行, 写入 ${writingTools.length} 个串行执行`);

    // 结果收集（按原始顺序索引存储）
    const resultMap: Map<number, ContentBlock> = new Map(rejectedResults);

    // 只读工具并行执行
    if (readOnlyTools.length > 0) {
      const readResults = await Promise.all(
        readOnlyTools.map(({ block, tool, idx }) => this.executeSingleTool(block, tool).then(r => ({ idx, result: r })))
      );
      for (const { idx, result } of readResults) {
        resultMap.set(idx, result);
      }
    }

    // 写入工具串行执行
    for (const { block, tool, idx } of writingTools) {
      const result = await this.executeSingleTool(block, tool);
      resultMap.set(idx, result);
    }

    // 按原始顺序组装结果
    const results: ContentBlock[] = [];
    for (const { idx } of toolBlocks) {
      const result = resultMap.get(idx);
      if (result) results.push(result);
    }

    return results;
  }

  /** 执行单个工具 */
  private async executeSingleTool(block: ToolUseBlock, tool: import("./tool/types.ts").Tool): Promise<ContentBlock> {
    const log = getLogger();

    if (!this.isTUIMode) {
      console.log(`\n[工具调用: ${block.name}]`);
    }

    log.debug("TOOL", `开始执行: ${block.name}`, block.input);
    const startTime = Date.now();

    try {
      const result = await tool.execute(block.input, this.abortController?.signal);
      const elapsed = Date.now() - startTime;

      // 记录工具耗时到 SessionState
      this.sessionState.addToolDuration(elapsed);

      // 截断超大输出，防止上下文爆炸
      const truncatedOutput = ContextManager.truncateToolOutput(result.output);

      log.toolExecution(block.name, block.input, {
        success: !result.isError,
        error: result.isError ? result.output.slice(0, 500) : undefined,
      });
      log.debug("TOOL", `执行完成: ${block.name} (${elapsed}ms)，输出 ${result.output.length} 字符${truncatedOutput.length < result.output.length ? `，截断为 ${truncatedOutput.length} 字符` : ""}`);

      if (!this.isTUIMode) {
        if (result.isError) {
          const maskedError = maskSensitiveData(result.output.slice(0, 100));
          console.log(`[工具错误: ${maskedError}]`);
        } else {
          const preview = result.output.length > 200
            ? result.output.slice(0, 200) + "..."
            : result.output;
          const maskedPreview = maskSensitiveData(preview);
          console.log(`[工具结果: ${maskedPreview}]`);
        }
      }

      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: truncatedOutput,
        is_error: result.isError,
      };
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      // 异常时也记录工具耗时
      this.sessionState.addToolDuration(elapsed);
      log.error("TOOL", `执行异常: ${block.name} (${elapsed}ms)`, {
        error: err.message,
        stack: err.stack,
      });

      if (!this.isTUIMode) {
        console.log(`[工具异常: ${err.message}]`);
      }

      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `工具执行异常: ${err.message}`,
        is_error: true,
      };
    }
  }

  /** 纯文本 REPL 模式 */
  async runREPL(initialPrompt?: string): Promise<void> {
    await this.init();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log("sid-code v0.1.0 (TypeScript)");
    console.log(`模型: ${this.config.model} | 提供商: ${this.config.provider}`);
    console.log("输入 /help 查看命令，Ctrl+C 退出\n");

    // 处理初始提示词
    if (initialPrompt) {
      console.log(`> ${initialPrompt}\n`);
      await this.agentLoop(initialPrompt);
      // 非交互式环境下直接退出
      if (!process.stdin.isTTY) {
        rl.close();
        return;
      }
    }

    const prompt = (): void => {
      rl.question("> ", async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          prompt();
          return;
        }

        // 处理斜杠命令
        if (trimmed.startsWith("/")) {
          const [cmdName, ...rest] = trimmed.slice(1).split(" ");
          const args = rest.join(" ");

          // 特殊处理 exit（需要关闭 readline）
          if (cmdName === "exit" || cmdName === "quit") {
            console.log("再见！");
            rl.close();
            return;
          }

          // 尝试从命令注册表查找
          const cmd = this.commandRegistry.get(cmdName);
          if (cmd) {
            try {
              await cmd.execute(args, {
                ctxMgr: this.ctxMgr,
                registry: this.toolRegistry,
                config: this.config,
                sessionId: "",
                provider: this.provider,
                setModel: (m) => { this.config.model = m; },
                exitRequested: false,
                sessionState: this.sessionState,
              });
            } catch (err: any) {
              console.error(`命令执行失败: ${err.message}`);
            }
            prompt();
            return;
          }

          console.log(`未知命令: /${cmdName}，输入 /help 查看可用命令`);
          prompt();
          return;
        }

        // 发送给 LLM
        try {
          this.abortController = new AbortController();
          await this.agentLoop(trimmed);
        } catch (err: any) {
          console.error(`\n错误: ${err.message}`);
        } finally {
          this.abortController = null;
        }

        prompt();
      });
    };

    // 处理 Ctrl+C
    rl.on("close", () => {
      console.log("\n再见！");
      process.exit(0);
    });

    prompt();
  }

  /** 无头模式 */
  async runHeadless(input: string): Promise<string> {
    await this.init();

    // 捕获输出
    const origWrite = process.stdout.write.bind(process.stdout);

    if (this.config.outputFormat === "json") {
      // JSON 模式下静默输出
      process.stdout.write = (() => true) as any;
    }

    try {
      this.abortController = new AbortController();
      await this.agentLoop(input);
    } finally {
      this.abortController = null;
      if (this.config.outputFormat === "json") {
        process.stdout.write = origWrite;
      }
    }

    // JSON 输出
    if (this.config.outputFormat === "json") {
      const messages = this.ctxMgr.getMessages();
      const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
      const result = {
        role: "assistant",
        content: lastAssistant?.content || [],
        usage: this.sessionState.getTotalUsage(),
      };
      console.log(JSON.stringify(result, null, 2));
    }

    return "";
  }

  /** TUI 模式 */
  async runTUI(initialPrompt?: string): Promise<void> {
    const log = getLogger();
    // TUI 模式下切换为仅文件输出，避免干扰 Ink 渲染
    log.setFileOnly(true);
    log.info("TUI", "进入 TUI 模式");

    this.isTUIMode = true;
    await this.init();

    const React = await import("react");
    const { render } = await import("ink");
    const { TUIApp } = await import("./ui/App.tsx");

    // 共享状态引用（TUI 通过轮询读取）
    const stateRef: { current: import("./ui/App.tsx").TUIState } = {
      current: {
        messages: [],
        streamingText: "",
        isLoading: false,
        toolName: null,
        isToolExecuting: false,
        model: this.config.model,
        provider: this.config.provider,
        usage: { ...this.sessionState.getTotalUsage() },
      },
    };

    const updateState = (patch: Partial<import("./ui/App.tsx").TUIState>) => {
      const keys = Object.keys(patch);
      log.debug("TUI:STATE", `updateState: ${keys.join(", ")}`, {
        streamingTextLen: patch.streamingText !== undefined ? patch.streamingText.length : undefined,
        messagesLen: patch.messages !== undefined ? patch.messages.length : undefined,
        isLoading: patch.isLoading,
        toolName: patch.toolName,
        isToolExecuting: patch.isToolExecuting,
      });
      stateRef.current = { ...stateRef.current, ...patch };
    };

    // TUI 版本的 agentLoop
    const tuiAgentLoop = async (userInput: string) => {
      log.info("TUI:AGENT", `用户输入: ${userInput.slice(0, 200)}${userInput.length > 200 ? '...' : ''}`);

      // 清空上一次的流式文本
      updateState({ streamingText: "" });

      this.ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: userInput }],
      });

      updateState({
        messages: this.ctxMgr.getMessages(),
        isLoading: true,
      });

      let turns = 0;
      const maxTurns = this.config.maxTurns || 50;

      while (turns < maxTurns) {
        turns++;
        log.debug("TUI:AGENT", `轮次 ${turns}/${maxTurns}，消息数 ${this.ctxMgr.getMessages().length}`);

        // 上下文溢出检测：接近上限时自动压缩
        const toolCount = this.toolRegistry.size();
        if (this.ctxMgr.needsCompaction(toolCount)) {
          log.warn("TUI:AGENT", `上下文接近上限 (${this.ctxMgr.estimateTokens(toolCount)} tokens)，触发自动压缩`);
          await this.autoCompact();
          updateState({ messages: this.ctxMgr.getMessages() });
        }

        // 发送消息给 LLM（使用清理后的消息，带重试和回退）
        const cleanedMessages = this.ctxMgr.getCleanedMessages();
        const toolDefs = toolCount > 0 ? this.toolRegistry.definitions() : undefined;
        log.llmRequest(this.config.provider, this.config.model, cleanedMessages.length, toolDefs?.length ?? 0);

        const stream = this.sendWithRetry(
          {
            model: this.config.model,
            messages: cleanedMessages,
            system: this.ctxMgr.getSystemPrompt(),
            maxTokens: this.config.maxTokens,
            tools: toolDefs,
          },
          this.abortController?.signal,
        );

        // 处理流式响应，更新 TUI 状态（记录 API 耗时）
        let streamingText = "";
        let streamChunks = 0;
        const tuiApiStart = Date.now();
        const response = await this.processStream(stream, (text) => {
          streamingText += text;
          streamChunks++;
          updateState({ streamingText });
        });
        const tuiApiDuration = Date.now() - tuiApiStart;

        log.debug("TUI:AGENT", `流式响应完成，共 ${streamChunks} 个文本块，总长 ${streamingText.length} 字符`);
        log.llmResponse(response.stopReason || "unknown", response.usage);

        // 更新 SessionState
        this.sessionState.updateUsage(this.config.model, response.usage, tuiApiDuration);

        this.ctxMgr.addMessage({
          role: "assistant",
          content: response.content,
        });

        // 不清空 streamingText，让完整内容保持显示
        // 下一次用户输入时会清空
        updateState({
          messages: this.ctxMgr.getMessages(),
          usage: { ...this.sessionState.getTotalUsage() },
        });

        if (response.stopReason === "end_turn" || response.stopReason === "stop") {
          log.info("TUI:AGENT", `对话结束 (${response.stopReason})，共 ${turns} 轮`);
          break;
        }

        if (response.stopReason === "tool_use") {
          // 工具调用时清空流式文本，避免和工具状态重叠
          updateState({ streamingText: "" });

          // 显示工具执行状态
          const toolBlocks = response.content.filter((b) => b.type === "tool_use");
          const toolNames = toolBlocks.map(b => b.type === "tool_use" ? b.name : "").filter(Boolean);
          log.info("TUI:AGENT", `工具调用: ${toolNames.join(", ")}`);

          for (const block of toolBlocks) {
            if (block.type !== "tool_use") continue;
            log.debug("TUI:STATE", `设置工具状态: toolName=${block.name}, isToolExecuting=true`);
            updateState({ toolName: block.name, isToolExecuting: true });
          }

          const toolResults = await this.executeTools(response.content);
          this.ctxMgr.addMessage({ role: "user", content: toolResults });

          log.debug("TUI:STATE", `工具执行完成，清除工具状态`);
          updateState({
            messages: this.ctxMgr.getMessages(),
            toolName: null,
            isToolExecuting: false,
          });
          continue;
        }

        // max_tokens 续写：模型输出撞上 token 上限，自动继续
        if (response.stopReason === "max_tokens" || response.stopReason === "length") {
          log.info("TUI:AGENT", `输出达到 token 上限，自动续写 (轮次 ${turns})`);
          // 不需要添加额外消息，模型会自动接着上次的内容继续
          continue;
        }

        log.warn("TUI:AGENT", `未知停止原因: ${response.stopReason}`);
        break;
      }

      log.debug("TUI:STATE", `设置 isLoading=false`);
      updateState({ isLoading: false });
    };

    // 回调
    const callbacks: import("./ui/App.tsx").TUICallbacks = {
      onUserInput: async (text) => {
        log.debug("TUI:CB", `onUserInput 被调用: "${text.slice(0, 100)}"`);
        try {
          this.abortController = new AbortController();
          await tuiAgentLoop(text);
        } catch (err: any) {
          log.error("TUI:CB", `onUserInput 异常`, { error: err.message, stack: err.stack });
          updateState({ isLoading: false, streamingText: "" });
        } finally {
          this.abortController = null;
        }
      },
      onSlashCommand: async (cmd, args) => {
        log.info("TUI:CMD", `斜杠命令: /${cmd} ${args}`);

        // 构建命令上下文
        const cmdCtx: import("./command/types.ts").AppContext = {
          ctxMgr: this.ctxMgr,
          registry: this.toolRegistry,
          config: this.config,
          sessionId: "",
          provider: this.provider,
          setModel: (m) => {
            log.info("TUI:CMD", `切换模型: ${this.config.model} → ${m}`);
            this.config.model = m;
            updateState({ model: m });
          },
          exitRequested: false,
          sessionState: this.sessionState,
        };

        // 特殊处理 clear（需要更新 TUI 状态）
        if (cmd === "clear") {
          log.info("TUI:CMD", "清空消息历史");
          this.ctxMgr.clear();
          updateState({ messages: [] });
          return;
        }

        // 捕获命令输出
        const outputs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: any[]) => {
          outputs.push(args.map(String).join(" "));
        };

        try {
          // 从命令注册表查找并执行
          const command = this.commandRegistry.get(cmd);
          if (command) {
            log.debug("TUI:CMD", `执行命令: /${cmd}`);
            await command.execute(args, cmdCtx);
            // 同步模型状态到 TUI
            updateState({ model: this.config.model, provider: this.config.provider });
            log.debug("TUI:CMD", `命令执行完成，输出 ${outputs.length} 行`);
          } else {
            log.warn("TUI:CMD", `未知命令: /${cmd}`);
            outputs.push(`未知命令: /${cmd}，输入 /help 查看可用命令`);
          }
        } catch (err: any) {
          log.error("TUI:CMD", `命令执行失败: /${cmd}`, { error: err.message, stack: err.stack });
          outputs.push(`命令执行失败: ${err.message}`);
        } finally {
          console.log = originalLog;
        }

        // 将命令输出添加到消息历史（作为系统消息）
        if (outputs.length > 0) {
          this.ctxMgr.addMessage({
            role: "user",
            content: [{ type: "text", text: `[系统] /${cmd} ${args}\n${outputs.join("\n")}` }],
          });
          updateState({ messages: this.ctxMgr.getMessages() });
        }
      },
    };

    // 渲染 TUI
    log.info("TUI", "开始渲染 TUI 组件");
    const app = render(
      React.createElement(TUIApp, {
        initialState: stateRef.current,
        callbacks,
        stateRef,
      }),
    );

    // 处理初始提示词
    if (initialPrompt) {
      log.info("TUI", `处理初始提示词: ${initialPrompt.slice(0, 100)}`);
      await callbacks.onUserInput(initialPrompt);
    }

    await app.waitUntilExit();
    log.info("TUI", "TUI 退出");
  }
}
