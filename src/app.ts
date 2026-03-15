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
} from "./llm/types.ts";
import type { Config } from "./config/config.ts";
import type { Checker } from "./permission/types.ts";
import type { ProviderRegistry } from "./llm/registry.ts";
import { Manager as ContextManager } from "./context/manager.ts";
import { Registry as ToolRegistry } from "./tool/registry.ts";
import { Registry as CommandRegistry } from "./command/registry.ts";
import { ModelFallback } from "./llm/fallback.ts";
import { ThinkingManager } from "./llm/thinking.ts";
import { SessionState } from "./session/state.ts";
import { QuotaManager } from "./llm/quota.ts";
import { loadCLAUDEmd } from "./config/rules.ts";
import { getLogger } from "./debug/logger.ts";
import { maskSensitiveData } from "./permission/sensitive.ts";
import { AgentLoopRunner } from "./agent/loop.ts";
import type { AgentLoopCallbacks } from "./agent/loop.ts";
import { HookRunner } from "./hook/runner.ts";
import * as readline from "readline";

/** App 配置 */
export interface AppOptions {
  config: Config;
  provider: Provider;
  providerRegistry?: ProviderRegistry;
  toolRegistry?: ToolRegistry;
  commandRegistry?: CommandRegistry;
  permissionChecker?: Checker;
  initialPrompt?: string;
}

export class App {
  private config: Config;
  private provider: Provider;
  private providerRegistry?: ProviderRegistry;
  private ctxMgr: ContextManager;
  private toolRegistry: ToolRegistry;
  private commandRegistry: CommandRegistry;
  private permissionChecker: Checker | null;
  private fallback: ModelFallback;
  private thinkingMgr: ThinkingManager;
  private sessionState: SessionState;
  private quotaManager?: QuotaManager;
  private abortController: AbortController | null = null;
  private isTUIMode: boolean = false;
  private loopRunner: AgentLoopRunner;
  private hookRunner!: HookRunner;
  /** TUI 模式下的权限确认回调（由 TUI 注入） */
  private tuiConfirmCallback: ((desc: string) => Promise<boolean>) | null = null;

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.provider = opts.provider;
    this.providerRegistry = opts.providerRegistry;
    this.toolRegistry = opts.toolRegistry ?? new ToolRegistry();
    this.commandRegistry = opts.commandRegistry ?? new CommandRegistry();
    this.permissionChecker = opts.permissionChecker ?? null;
    this.ctxMgr = new ContextManager({ maxTokens: 200000 });
    this.sessionState = new SessionState(
      opts.config.sessionId || crypto.randomUUID().slice(0, 8),
    );
    // 成本配额管理
    if (opts.config.costLimit && opts.config.costLimit > 0) {
      this.quotaManager = new QuotaManager(opts.config.costLimit);
    }
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

    // 初始化 Hook 执行器
    this.hookRunner = new HookRunner(this.config.hooks);

    // 初始化统一循环 Runner
    this.loopRunner = new AgentLoopRunner({
      config: this.config,
      provider: this.provider,
      ctxMgr: this.ctxMgr,
      toolRegistry: this.toolRegistry,
      sessionState: this.sessionState,
      fallback: this.fallback,
      thinkingMgr: this.thinkingMgr,
      hookRunner: this.hookRunner,
      quotaManager: this.quotaManager,
      executeTools: (content) => this.executeTools(content),
      processStream: (stream, onText) => this.processStream(stream, onText),
      autoCompact: () => this.autoCompact(),
      handleContextOverflow: (err, max) => this.handleContextOverflow(err, max),
      getAbortSignal: () => this.abortController?.signal,
    });
  }

  /** 获取自定义命令摘要（供 /help 显示） */
  private getCustomCommandsSummary(): Array<{ name: string; description: string }> {
    const builtinNames = new Set([
      "help", "model", "cost", "compact", "clear", "config", "exit", "undo", "memory",
    ]);
    return this.commandRegistry.all()
      .filter(cmd => !builtinNames.has(cmd.name()))
      .map(cmd => ({ name: cmd.name(), description: cmd.description() }));
  }

  /**
   * 处理上下文溢出错误，尝试自动缩小 max_tokens
   * 返回调整后的 maxTokens，无法恢复时返回 null
   */
  private handleContextOverflow(err: any, _currentMaxTokens: number): number | null {
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

    // pre_compact hook（blocking 时可阻止压缩）
    const preResults = await this.hookRunner.run("pre_compact", {
      sessionId: this.sessionState.sessionId,
    });
    const blocked = preResults.find(r => r.blocked);
    if (blocked) {
      log.info("HOOK", `压缩被 hook 阻止: ${blocked.reason || "无原因"}`);
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

      // 加载记忆（全局/项目双层）
      let memorySummary: string | undefined;
      try {
        const { MemoryStore } = await import("./memory/store.ts");
        const memStore = new MemoryStore(process.cwd());
        memorySummary = await memStore.generateSummary() || undefined;
        if (memorySummary) {
          log.debug("APP", `加载记忆摘要 (${memorySummary.length} 字符)`);
        }
      } catch (err) {
        log.warn("APP", `加载记忆失败: ${err}`);
      }

      // 使用增强的系统提示词构建模块（动态附件 + 优先级 + 缓存）
      const { buildSystemPrompt } = await import("./config/system-prompt.ts");
      systemPrompt = buildSystemPrompt({
        // 基础
        tools: this.toolRegistry.all(),
        projectRules: rules || undefined,
        appendPrompt: this.config.appendSystemPrompt || undefined,
        filePrompt,

        // 动态上下文
        workingDir: process.cwd(),
        permissionMode: this.config.permissionMode,
        gitStatus: true,
        memorySummary,

        // 限制
        maxTokens: 180000,
      });
    }

    this.ctxMgr.setSystemPrompt(systemPrompt);
    log.info("APP", `初始化完成，系统提示词 ${systemPrompt.length} 字符，工具数 ${this.toolRegistry.size()}`);

    // session_start hook（非阻塞）
    this.hookRunner.run("session_start", {
      sessionId: this.sessionState.sessionId,
    }).catch(err => log.error("HOOK", `session_start hook 失败: ${err.message}`));
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
    const callbacks: AgentLoopCallbacks = {
      onStreamText: (text) => process.stdout.write(text),
      onToolStart: (name) => console.log(`\n[工具调用: ${name}]`),
      onToolEnd: () => {},
      onCompact: () => console.log("\n[上下文已自动压缩]"),
      onComplete: () => process.stdout.write("\n"),
      onContextWarning: (remaining) =>
        console.log(`\n[Context left until auto-compact: ${remaining.toFixed(0)}%]`),
      onMaxTurns: (max) => console.log(`\n[达到最大轮次限制: ${max}]`),
    };
    await this.loopRunner.run(userInput, callbacks);
  }

  /** 设置 TUI 模式下的权限确认回调 */
  setTUIConfirmCallback(cb: (desc: string) => Promise<boolean>): void {
    this.tuiConfirmCallback = cb;
  }

  /** 请求用户确认（根据运行模式选择不同方式，支持 a=always allow） */
  private async requestUserConfirmation(
    description: string,
    req?: import("./permission/types.ts").PermissionRequest,
  ): Promise<boolean> {
    // TUI 模式：使用注入的回调（TUI 暂不支持 always allow）
    if (this.isTUIMode && this.tuiConfirmCallback) {
      const confirmed = await this.tuiConfirmCallback(description);
      return confirmed;
    }

    // REPL 模式：使用 readline，支持 a=always allow
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(`\n[权限请求] ${description}\n允许执行？(y/n/a) [a=本次会话内始终允许] `, (answer) => {
        rl.close();
        const lower = answer.toLowerCase();
        if (lower === "a" || lower === "always") {
          // 记住决策
          if (req && this.permissionChecker?.rememberDecision) {
            this.permissionChecker.rememberDecision(req, true);
          }
          resolve(true);
        } else {
          resolve(lower === "y" || lower === "yes");
        }
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
        const permReq: import("./permission/types.ts").PermissionRequest = {
          toolName: block.name,
          input: block.input,
          description: (block.input as any)?.description
            ? `${block.name}: ${(block.input as any).description}`
            : `${block.name}: ${JSON.stringify(block.input).slice(0, 120)}`,
        };
        const decision = await this.permissionChecker.check(permReq);

        if (!decision.allowed) {
          if (decision.needsConfirmation) {
            const desc = decision.reason || `工具 "${block.name}" 需要用户确认`;
            log.info("PERMISSION", `请求用户确认: ${desc}`);
            const confirmed = await this.requestUserConfirmation(desc, permReq);
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

    // pre_tool_use hook（blocking 时可阻止工具执行）
    const preResults = await this.hookRunner.run("pre_tool_use", {
      toolName: block.name,
      toolInput: block.input,
      sessionId: this.sessionState.sessionId,
    });
    const blocked = preResults.find(r => r.blocked);
    if (blocked) {
      log.info("HOOK", `工具 ${block.name} 被 hook 阻止: ${blocked.reason || "无原因"}`);
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Hook 阻止执行: ${blocked.reason || "被 pre_tool_use hook 阻止"}`,
        is_error: true,
      };
    }

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

      // post_tool_use hook（非阻塞）
      this.hookRunner.run("post_tool_use", {
        toolName: block.name,
        toolInput: block.input,
        toolOutput: truncatedOutput,
        isError: result.isError,
        sessionId: this.sessionState.sessionId,
      }).catch(err => log.error("HOOK", `post_tool_use hook 失败: ${err.message}`));

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

      // post_tool_use_failure hook（非阻塞）
      this.hookRunner.run("post_tool_use_failure", {
        toolName: block.name,
        toolInput: block.input,
        error: err.message,
        isError: true,
        sessionId: this.sessionState.sessionId,
      }).catch(e => log.error("HOOK", `post_tool_use_failure hook 失败: ${e.message}`));

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
            await this.hookRunner.run("session_end", { sessionId: this.sessionState.sessionId });
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
                setModel: (m) => {
                  this.config.model = m;
                  // Provider 重建（registry 模式）
                  if (this.providerRegistry) {
                    this.providerRegistry.clearCache();
                    this.provider = this.providerRegistry.getProvider();
                    this.loopRunner.updateProvider(this.provider);
                  }
                },
                exitRequested: false,
                sessionState: this.sessionState,
                sendToLLM: async (text) => {
                  this.abortController = new AbortController();
                  try { await this.agentLoop(text); } finally { this.abortController = null; }
                },
                customCommands: this.getCustomCommandsSummary(),
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
      this.hookRunner.run("session_end", { sessionId: this.sessionState.sessionId })
        .catch(() => {})
        .finally(() => {
          console.log("\n再见！");
          process.exit(0);
        });
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

    // session_end hook（非阻塞）
    await this.hookRunner.run("session_end", { sessionId: this.sessionState.sessionId });

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

    // TUI 版本的 agentLoop（使用统一 Runner）
    const tuiAgentLoop = async (userInput: string) => {
      // 清空上一次的流式文本
      updateState({ streamingText: "", isLoading: true });

      const tuiCallbacks: AgentLoopCallbacks = {
        onStreamText: (text) => {
          const current = stateRef.current.streamingText || "";
          updateState({ streamingText: current + text });
        },
        onToolStart: (name) => {
          updateState({ streamingText: "", toolName: name, isToolExecuting: true });
        },
        onToolEnd: () => {
          updateState({
            messages: this.ctxMgr.getMessages(),
            toolName: null,
            isToolExecuting: false,
          });
        },
        onCompact: () => {
          updateState({ messages: this.ctxMgr.getMessages() });
        },
        onComplete: () => {
          updateState({
            messages: this.ctxMgr.getMessages(),
            usage: { ...this.sessionState.getTotalUsage() },
          });
        },
      };

      await this.loopRunner.run(userInput, tuiCallbacks);

      updateState({
        isLoading: false,
        messages: this.ctxMgr.getMessages(),
        usage: { ...this.sessionState.getTotalUsage() },
      });
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
            // Provider 重建（registry 模式）
            if (this.providerRegistry) {
              this.providerRegistry.clearCache();
              this.provider = this.providerRegistry.getProvider();
              this.loopRunner.updateProvider(this.provider);
            }
            updateState({ model: m });
          },
          exitRequested: false,
          sessionState: this.sessionState,
          sendToLLM: async (text) => {
            // TUI 模式下通过 onUserInput 触发 agentLoop
            await callbacks.onUserInput(text);
          },
          customCommands: this.getCustomCommandsSummary(),
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
    await this.hookRunner.run("session_end", { sessionId: this.sessionState.sessionId });
    log.info("TUI", "TUI 退出");
  }
}
