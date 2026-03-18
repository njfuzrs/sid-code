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
import type { MCPManager } from "./mcp/manager.ts";
import { Manager as ContextManager } from "./context/manager.ts";
import { Registry as ToolRegistry } from "./tool/registry.ts";
import { Registry as CommandRegistry } from "./command/registry.ts";
import { ModelFallback } from "./llm/fallback.ts";
import { ThinkingManager } from "./llm/thinking.ts";
import { SessionState } from "./session/state.ts";
import { QuotaManager } from "./llm/quota.ts";
import { loadAllCLAUDEmd, watchCLAUDEmd, unwatchCLAUDEmd } from "./config/rules.ts";
import type { ProjectRules } from "./config/rules.ts";
import { clearPromptCache } from "./config/system-prompt.ts";
import { getLogger } from "./debug/logger.ts";
import { AgentLoopRunner } from "./agent/loop.ts";
import type { AgentLoopCallbacks } from "./agent/loop.ts";
import { HookRunner } from "./hook/runner.ts";
import { execSync } from "child_process";


/** App 配置 */
export interface AppOptions {
  config: Config;
  provider: Provider;
  providerRegistry?: ProviderRegistry;
  toolRegistry?: ToolRegistry;
  commandRegistry?: CommandRegistry;
  permissionChecker?: Checker;
  initialPrompt?: string;
  mcpManager?: MCPManager;
}

export class App {
  private config: Config;
  private provider: Provider;
  private providerRegistry?: ProviderRegistry;
  private mcpManager?: MCPManager;
  private ctxMgr: ContextManager;
  private toolRegistry: ToolRegistry;
  private commandRegistry: CommandRegistry;
  private permissionChecker: Checker | null;
  private fallback: ModelFallback;
  private thinkingMgr: ThinkingManager;
  private sessionState: SessionState;
  private quotaManager?: QuotaManager;
  private abortController: AbortController | null = null;
  private loopRunner: AgentLoopRunner;
  private hookRunner!: HookRunner;
  /** TUI 模式下的权限确认回调（由 TUI 注入），返回 "yes" | "no" | "always" */
  private tuiConfirmCallback: ((toolName: string, toolInput: unknown, desc: string) => Promise<"yes" | "no" | "always">) | null = null;

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.provider = opts.provider;
    this.providerRegistry = opts.providerRegistry;
    this.mcpManager = opts.mcpManager;
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
      },
      onFallback: (reason, model) => {
        const log = getLogger();
        log.warn("FALLBACK", `降级到 ${model}，原因: ${reason}`);
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
        return;
      }
    } catch (err: any) {
      log.warn("AGENT", `LLM 摘要失败，使用简单截断: ${err.message}`);
    }

    // 降级：简单截断（保留最近消息，丢弃旧消息）
    const simpleSummary = `[自动截断] 之前有 ${messages.length - 4} 条消息被截断以释放上下文空间。`;
    this.ctxMgr.compactWithSummary(simpleSummary);
    log.info("AGENT", `简单截断完成，剩余 ${this.ctxMgr.messageCount()} 条消息`);
  }

  /** 初始化：加载系统提示词 */
  async init(): Promise<void> {
    const log = getLogger();
    log.info("APP", "开始初始化...");

    let systemPrompt = this.config.systemPrompt;

    if (!systemPrompt) {
      // 加载并解析 CLAUDE.md 规则（全局 + 项目合并）
      const projectRules = await loadAllCLAUDEmd(process.cwd());
      if (projectRules) {
        log.debug("APP", `加载 CLAUDE.md 规则 (${projectRules.rawContent.length} 字符, 来源: ${projectRules.sourcePath})`);

        // 应用结构化规则到配置（CLAUDE.md 中的规则覆盖默认配置）
        this.applyProjectRules(projectRules);
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
        projectRules: projectRules?.rawContent || undefined,
        projectRulesPath: projectRules?.sourcePath,
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

    // 启动 CLAUDE.md 文件变化监听（变更时重新加载规则 + 重建系统提示词）
    watchCLAUDEmd(process.cwd(), async (changedPath) => {
      log.info("APP", `CLAUDE.md 已变更: ${changedPath}`);
      // 1. clearPromptCache 已在 watchCLAUDEmd 内部调用
      // 2. 重新加载并应用规则
      const newRules = await loadAllCLAUDEmd(process.cwd());
      if (newRules) {
        this.applyProjectRules(newRules);
        // 3. 重建系统提示词
        const { buildSystemPrompt } = await import("./config/system-prompt.ts");
        let memorySummary: string | undefined;
        try {
          const { MemoryStore } = await import("./memory/store.ts");
          const memStore = new MemoryStore(process.cwd());
          memorySummary = await memStore.generateSummary() || undefined;
        } catch { /* 忽略 */ }

        const newPrompt = buildSystemPrompt({
          tools: this.toolRegistry.all(),
          projectRules: newRules.rawContent,
          projectRulesPath: newRules.sourcePath,
          appendPrompt: this.config.appendSystemPrompt || undefined,
          workingDir: process.cwd(),
          permissionMode: this.config.permissionMode,
          gitStatus: true,
          memorySummary,
          maxTokens: 180000,
        });
        this.ctxMgr.setSystemPrompt(newPrompt);
        log.info("APP", `系统提示词已重建: ${newPrompt.length} 字符`);
      }
    });

    // session_start hook（非阻塞）
    this.hookRunner.run("session_start", {
      sessionId: this.sessionState.sessionId,
    }).catch(err => log.error("HOOK", `session_start hook 失败: ${err.message}`));
  }

  /**
   * 应用 CLAUDE.md 中解析出的结构化规则到运行时配置
   * 只覆盖 CLAUDE.md 中明确指定的字段，不影响命令行参数和配置文件的设置
   */
  private applyProjectRules(rules: ProjectRules): void {
    const log = getLogger();

    // 工具白名单（合并，不覆盖命令行配置）
    if (rules.allowedTools?.length) {
      this.config.allowedTools = [
        ...this.config.allowedTools,
        ...rules.allowedTools,
      ];
      log.info("APP", `CLAUDE.md 工具白名单: ${rules.allowedTools.join(", ")}`);
    }

    // 工具黑名单（合并）
    if (rules.disallowedTools?.length) {
      this.config.disallowedTools = [
        ...this.config.disallowedTools,
        ...rules.disallowedTools,
      ];
      log.info("APP", `CLAUDE.md 工具黑名单: ${rules.disallowedTools.join(", ")}`);
    }

    // 权限模式（仅当命令行未指定时才覆盖）
    if (rules.permissionMode && this.config.permissionMode === "default") {
      this.config.permissionMode = rules.permissionMode;
      log.info("APP", `CLAUDE.md 权限模式: ${rules.permissionMode}`);
    }

    // 模型选择（仅当命令行未指定时才覆盖）
    if (rules.model && !process.argv.includes("--model")) {
      this.config.model = rules.model;
      log.info("APP", `CLAUDE.md 模型: ${rules.model}`);
    }

    // systemPromptAddition → appendSystemPrompt（仅当 CLI 未指定 --append-system-prompt 时）
    if (rules.systemPromptAddition && !this.config.appendSystemPrompt) {
      this.config.appendSystemPrompt = rules.systemPromptAddition;
      log.info("APP", `CLAUDE.md 系统提示词追加: ${rules.systemPromptAddition.length} 字符`);
    }

    // instructions → 拼接到 rawContent 前面（作为高优先级指令）
    if (rules.instructions) {
      rules.rawContent = `# Instructions\n${rules.instructions}\n\n---\n\n${rules.rawContent}`;
      log.info("APP", `CLAUDE.md 指令已注入 rawContent 前部: ${rules.instructions.length} 字符`);
    }

    // memory → 异步写入 MemoryStore（不阻塞初始化）
    if (rules.memory && Object.keys(rules.memory).length > 0) {
      this.applyProjectMemory(rules.memory);
    }
  }

  /**
   * 将 CLAUDE.md 中的 memory 键值对写入 MemoryStore
   * 异步执行，不阻塞主流程
   */
  private async applyProjectMemory(memory: Record<string, string>): Promise<void> {
    const log = getLogger();
    try {
      const { MemoryStore } = await import("./memory/store.ts");
      const memStore = new MemoryStore(process.cwd());
      await memStore.load();
      for (const [key, value] of Object.entries(memory)) {
        await memStore.set(key, value, "project");
        log.info("APP", `CLAUDE.md 记忆写入: ${key} = ${value.slice(0, 50)}${value.length > 50 ? "..." : ""}`);
      }
    } catch (err: any) {
      log.warn("APP", `CLAUDE.md 记忆写入失败: ${err.message}`);
    }
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

    // 流结束日志：统计文本长度和工具调用数
    const totalTextLen = response.content
      .filter(b => b.type === "text")
      .reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
    const toolCallCount = response.content.filter(b => b.type === "tool_use").length;
    log.info("STREAM", `流结束: 文本${totalTextLen}字符, 工具调用${toolCallCount}个, stop=${response.stopReason}, in=${response.usage.inputTokens} out=${response.usage.outputTokens}`);

    return response;
  }

  /** 设置 TUI 模式下的权限确认回调 */
  setTUIConfirmCallback(cb: (toolName: string, toolInput: unknown, desc: string) => Promise<"yes" | "no" | "always">): void {
    this.tuiConfirmCallback = cb;
  }

  /** 请求用户确认（TUI 回调 或 headless 自动决策） */
  private async requestUserConfirmation(
    description: string,
    req?: import("./permission/types.ts").PermissionRequest,
    toolName?: string,
    toolInput?: unknown,
  ): Promise<boolean> {
    // TUI 模式：使用注入的回调
    if (this.tuiConfirmCallback) {
      const answer = await this.tuiConfirmCallback(toolName || "", toolInput, description);
      if (answer === "always") {
        if (req && this.permissionChecker?.rememberDecision) {
          this.permissionChecker.rememberDecision(req, true);
        }
        return true;
      }
      return answer === "yes";
    }

    // headless 模式：根据权限模式自动决策
    return this.config.permissionMode === "always-allow";
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
            const confirmed = await this.requestUserConfirmation(desc, permReq, block.name, block.input);
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

    log.toolStart(block.name, block.input);

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

      log.toolEnd(block.name, result.output, !!result.isError, elapsed);

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

  /** 无头模式：直接用 AgentLoopRunner + 最小回调，不依赖任何 renderer */
  async runHeadless(input: string): Promise<string> {
    await this.init();

    let streamBuffer = "";
    const callbacks: AgentLoopCallbacks = {
      onStreamText: (text) => { streamBuffer += text; },
      onToolStart: () => {},
      onToolEnd: () => {},
      onCompact: () => {},
      onComplete: () => {},
    };

    this.abortController = new AbortController();
    try {
      await this.loopRunner.run(input, callbacks);
    } finally {
      this.abortController = null;
    }

    // 输出结果
    if (this.config.outputFormat === "json") {
      const messages = this.ctxMgr.getMessages();
      const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
      const result = {
        role: "assistant",
        content: lastAssistant?.content || [],
        usage: this.sessionState.getTotalUsage(),
      };
      console.log(JSON.stringify(result, null, 2));
    } else {
      process.stdout.write(streamBuffer);
    }

    // session_end hook + 清理
    await this.hookRunner.run("session_end", { sessionId: this.sessionState.sessionId });
    unwatchCLAUDEmd();
    this.mcpManager?.closeAll();

    return "";
  }

  /** TUI 模式 */
  async runTUI(initialPrompt?: string): Promise<void> {
    const log = getLogger();
    // TUI 模式下切换为仅文件输出，避免干扰 Ink 渲染
    log.setFileOnly(true);
    log.info("TUI", "进入 TUI 模式");

    await this.init();

    const React = await import("react");
    const { createFullScreen } = await import("./ui/fullscreen.ts");
    const { TUIApp } = await import("./ui/App.tsx");
    const { StreamWriter } = await import("./ui/stream-writer.ts");

    const { StateBridge } = await import("./ui/state-bridge.ts");

    // ink 的 writeToStdout 函数（app 创建后赋值）
    // 通过此函数写入的内容，ink 会自动清除/恢复 Live 区域，输入栏始终在底部
    let inkWriteToStdout: ((data: string) => void) | null = null;

    // 流式输出器：已完成段落通过 ink writeToStdout 输出，未完成行通过 bridge 更新到 Live 区域
    const streamWriter = new StreamWriter({
      writeFn: (data) => {
        // ink 已 patch console.log，会自动调用 writeToStdout
        // 这样 ink 会自动清除/恢复 Live 区域
        if (inkWriteToStdout) {
          inkWriteToStdout(data);
        } else {
          // 回退：直接写 stdout（TUI 启动前）
          process.stdout.write(data);
        }
      },
      onCurrentLine: (line) => {
        bridge.update({ streamingLine: line });
      },
    });

    // 事件驱动状态桥接（替代 50ms 轮询）
    const bridge = new StateBridge({
      messages: [],
      displayItems: [],
      isLoading: false,
      toolName: null,
      toolInput: null,
      isToolExecuting: false,
      model: this.config.model,
      provider: this.config.provider,
      usage: { ...this.sessionState.getTotalUsage() },
      costUSD: 0,
      costLimit: this.config.costLimit ?? 0,
      contextPercent: 0,
      permissionMode: this.config.permissionMode || "default",
      gitBranch: (() => { try { return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return ""; } })(),
      statusMessage: "",
      permissionRequest: null,
      debug: !!this.config.debug,
      lastToolResult: null,
      streamingLine: "",
    });

    const updateState = (patch: Partial<import("./ui/App.tsx").TUIState>) => {
      const keys = Object.keys(patch);
      log.debug("TUI:STATE", `updateState: ${keys.join(", ")}`, {
        messagesLen: patch.messages !== undefined ? patch.messages.length : undefined,
        isLoading: patch.isLoading,
        toolName: patch.toolName,
        isToolExecuting: patch.isToolExecuting,
      });
      bridge.update(patch);
    };

    // DisplayItem 增量同步：追踪上次同步的 ctxMgr 消息数
    const { messagesToDisplayItems, isPlaceholderMessage } = await import("./ui/App.tsx");
    let lastSyncedCount = 0;

    // 会话恢复：如果 ctxMgr 已有消息（restoreSession 在 runTUI 之前调用），初始化 displayItems
    {
      const existingMsgs = this.ctxMgr.getMessages();
      if (existingMsgs.length > 0) {
        lastSyncedCount = existingMsgs.length;
        const items = messagesToDisplayItems(existingMsgs);
        bridge.update({ messages: existingMsgs, displayItems: items });
      }
    }

    /** 从 ctxMgr 增量同步新消息到 displayItems */
    const syncDisplay = (extraPatch?: Partial<import("./ui/App.tsx").TUIState>) => {
      const allMsgs = this.ctxMgr.getMessages();
      const newMsgs = allMsgs.slice(lastSyncedCount);
      lastSyncedCount = allMsgs.length;

      const newItems = newMsgs
        .filter(m => !isPlaceholderMessage(m))
        .map(m => ({ kind: "message" as const, message: m }));

      const items = [...bridge.current.displayItems, ...newItems];
      updateState({ messages: allMsgs, displayItems: items, ...extraPatch });
    };

    /** 重建 displayItems（/compact 后消息被压缩，需要完整重建） */
    const rebuildDisplay = (extraPatch?: Partial<import("./ui/App.tsx").TUIState>) => {
      const allMsgs = this.ctxMgr.getMessages();
      lastSyncedCount = allMsgs.length;
      const items = messagesToDisplayItems(allMsgs);
      updateState({ messages: allMsgs, displayItems: items, ...extraPatch });
    };

    /** 追加系统消息（命令输出，不进 ctxMgr） */
    const appendSystemOutput = (text: string) => {
      const items = [...bridge.current.displayItems, { kind: "system" as const, text }];
      updateState({ displayItems: items });
    };

    /** 追加命令消息（输入+输出分离，不进 ctxMgr） */
    const appendCommandOutput = (input: string, output: string | null) => {
      const items = [...bridge.current.displayItems, { kind: "command" as const, input, output }];
      updateState({ displayItems: items });
    };

    // 设置 TUI 权限确认回调
    this.setTUIConfirmCallback(async (toolName, toolInput, desc) => {
      return new Promise<"yes" | "no" | "always">((resolve) => {
        log.info("TUI:PERM", `显示权限对话框: ${toolName} - ${desc}`);
        const wrappedResolve = (answer: "yes" | "no" | "always") => {
          log.info("TUI:PERM", `权限对话框响应: ${answer}`);
          updateState({ permissionRequest: null });
          resolve(answer);
        };
        updateState({
          permissionRequest: { toolName, toolInput, description: desc, resolve: wrappedResolve },
        });
      });
    });

    // TUI 版本的 agentLoop（使用统一 Runner）
    const tuiAgentLoop = async (userInput: string) => {
      updateState({
        isLoading: true,
      });

      let streamSynced = false;

      const tuiCallbacks: AgentLoopCallbacks = {
        onUserMessageAdded: () => {
          syncDisplay();
        },
        onStreamText: (text) => {
          // 首次收到流式文本时启动 StreamWriter
          if (!streamSynced) {
            streamSynced = true;
            syncDisplay(); // 先同步，确保用户消息已在 Static 区域
            streamWriter.start();
          }
          streamWriter.write(text);
        },
        onToolStart: (name, input) => {
          // 工具开始前，结束当前流式输出
          streamWriter.finish();
          // 跳过已被 StreamWriter 输出的助手消息，避免 Static 重复渲染
          if (streamSynced) {
            lastSyncedCount = this.ctxMgr.getMessages().length;
          }
          streamSynced = false;
          syncDisplay({ toolName: name, toolInput: input ?? null, isToolExecuting: true, streamingLine: "" });
        },
        onToolEnd: (name, result) => {
          syncDisplay({
            toolName: null,
            toolInput: null,
            isToolExecuting: false,
            lastToolResult: result ? { toolName: name, isError: !!result.isError, elapsedMs: result.elapsedMs ?? 0 } : null,
          });
        },
        onCompact: () => {
          rebuildDisplay({ statusMessage: "上下文已自动压缩" });
          // 3 秒后清除状态消息
          setTimeout(() => updateState({ statusMessage: "" }), 3000);
        },
        onComplete: () => {
          const ctxUsed = this.ctxMgr.estimateTokens(this.toolRegistry.size());
          const ctxPct = Math.round((ctxUsed / 200000) * 100);
          streamWriter.finish();
          // 跳过已被 StreamWriter 输出的助手消息，避免 Static 重复渲染
          if (streamSynced) {
            lastSyncedCount = this.ctxMgr.getMessages().length;
          }
          streamSynced = false;
          syncDisplay({
            usage: { ...this.sessionState.getTotalUsage() },
            costUSD: this.sessionState.totalCostUSD,
            contextPercent: ctxPct,
            statusMessage: "",
            streamingLine: "",
          });
        },
        onContextWarning: (remaining) => {
          updateState({ statusMessage: `⚠ 上下文剩余 ${remaining.toFixed(0)}%，即将自动压缩` });
        },
        onMaxTurns: (max) => {
          updateState({ statusMessage: `达到最大轮次限制: ${max}` });
        },
      };

      try {
        await this.loopRunner.run(userInput, tuiCallbacks);
      } finally {
        // 兜底：确保异常路径也能正确清理
        streamWriter.finish();
        if (streamSynced) {
          lastSyncedCount = this.ctxMgr.getMessages().length;
          streamSynced = false;
        }
      }

      syncDisplay({
        isLoading: false,
        usage: { ...this.sessionState.getTotalUsage() },
        costUSD: this.sessionState.totalCostUSD,
        contextPercent: Math.round((this.ctxMgr.estimateTokens(this.toolRegistry.size()) / 200000) * 100),
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
          updateState({ isLoading: false });
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
            // 同步模型级 maxOutputTokens
            const { resolveModelMaxOutputTokens } = require("./config/config.ts");
            const modelMaxOutput = resolveModelMaxOutputTokens(this.config);
            if (modelMaxOutput) {
              this.config.maxTokens = modelMaxOutput;
              log.info("TUI:CMD", `maxTokens 已更新: ${modelMaxOutput}`);
            }
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
          mcpManager: this.mcpManager,
          sendToLLM: async (text) => {
            // TUI 模式下通过 onUserInput 触发 agentLoop
            await callbacks.onUserInput(text);
          },
          customCommands: this.getCustomCommandsSummary(),
        };

        // 特殊处理 clear（需要更新 TUI 状态 + 重置相关运行时状态）
        if (cmd === "clear") {
          log.info("TUI:CMD", "清空消息历史，重置上下文");
          this.ctxMgr.clear();
          clearPromptCache();
          this.quotaManager?.resetAlertLevel();
          this.fallback.reset();
          lastSyncedCount = 0;
          // Static 组件已写入终端滚动缓冲区的内容无法通过 React 状态清除，
          // 必须用 ANSI 转义序列清屏，然后 Ink 会在干净画布上重新渲染 Live 区域
          // \x1b[H 光标归位 + \x1b[2J 清屏 + \x1b[3J 清除滚动缓冲区
          process.stdout.write("\x1b[H\x1b[2J\x1b[3J");
          updateState({
            messages: [],
            displayItems: [],
            contextPercent: 0,
            statusMessage: "",
            lastToolResult: null,
          });
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

        // 将命令输出显示为命令消息（输入+输出分离，不进 ctxMgr，不发给 LLM）
        const commandInput = `/${cmd}${args ? " " + args : ""}`;
        const commandOutput = outputs.length > 0 ? outputs.join("\n") : null;
        appendCommandOutput(commandInput, commandOutput);
      },
    };

    // 渲染 TUI（主缓冲区模式，不使用 alternate screen buffer）
    log.info("TUI", "开始渲染 TUI 组件（全屏模式）");

    const app = createFullScreen(
      React.createElement(TUIApp, {
        initialState: bridge.current,
        callbacks,
        bridge,
        onWidthIncrease: () => app.clear(),
      }),
    );
    await app.start();

    // app 创建后，使用 console.log 作为 writeToStdout
    // ink 已 patch console.log，会自动调用内部的 writeToStdout
    inkWriteToStdout = (data: string) => {
      // 去掉末尾换行，因为 console.log 会自动加
      const trimmed = data.endsWith("\n") ? data.slice(0, -1) : data;
      if (trimmed) {
        console.log(trimmed);
      }
    };

    // 处理初始提示词
    if (initialPrompt) {
      log.info("TUI", `处理初始提示词: ${initialPrompt.slice(0, 100)}`);
      await callbacks.onUserInput(initialPrompt);
    }

    await app.waitUntilExit();
    await this.hookRunner.run("session_end", { sessionId: this.sessionState.sessionId });
    unwatchCLAUDEmd();
    this.mcpManager?.closeAll();
    log.info("TUI", "TUI 退出");
  }
}
