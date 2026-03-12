/**
 * 应用主循环
 * 实现 Agentic While-Loop：用户输入 → LLM 流式响应 → 工具调用 → 循环
 */

import type { Provider } from "./llm/provider.ts";
import type {
  Message,
  ContentBlock,
  StreamEvent,
  AccumulatedResponse,
  ToolDefinition,
  Usage,
  TextDelta,
  InputJsonDelta,
} from "./llm/types.ts";
import type { Config } from "./config/config.ts";
import { Manager as ContextManager } from "./context/manager.ts";
import { Registry as ToolRegistry } from "./tool/registry.ts";
import { Registry as CommandRegistry } from "./command/registry.ts";
import { loadCLAUDEmd } from "./config/rules.ts";
import * as readline from "readline";

/** App 配置 */
export interface AppOptions {
  config: Config;
  provider: Provider;
  toolRegistry?: ToolRegistry;
  commandRegistry?: CommandRegistry;
  initialPrompt?: string;
}

export class App {
  private config: Config;
  private provider: Provider;
  private ctxMgr: ContextManager;
  private toolRegistry: ToolRegistry;
  private commandRegistry: CommandRegistry;
  private totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private abortController: AbortController | null = null;

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.provider = opts.provider;
    this.toolRegistry = opts.toolRegistry ?? new ToolRegistry();
    this.commandRegistry = opts.commandRegistry ?? new CommandRegistry();
    this.ctxMgr = new ContextManager({ maxTokens: 200000 });
  }

  /** 初始化：加载系统提示词 */
  async init(): Promise<void> {
    let systemPrompt = this.config.systemPrompt;

    if (!systemPrompt) {
      // 构建默认系统提示词
      const parts: string[] = [];
      parts.push("你是一个 AI 编程助手。你可以帮助用户编写代码、调试问题、解释概念。");

      // 加载 CLAUDE.md 规则
      const rules = await loadCLAUDEmd(process.cwd());
      if (rules) {
        parts.push(`\n<project-rules>\n${rules}\n</project-rules>`);
      }

      // 追加系统提示词
      if (this.config.appendSystemPrompt) {
        parts.push(`\n${this.config.appendSystemPrompt}`);
      }

      // 从文件加载系统提示词
      if (this.config.systemPromptFile) {
        try {
          const content = await Bun.file(this.config.systemPromptFile).text();
          parts.push(`\n${content}`);
        } catch (err) {
          console.error(`加载系统提示词文件失败: ${err}`);
        }
      }

      systemPrompt = parts.join("\n");
    }

    this.ctxMgr.setSystemPrompt(systemPrompt);
  }

  /** 处理流式响应，累积内容块 */
  async processStream(
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
  ): Promise<AccumulatedResponse> {
    const response: AccumulatedResponse = {
      role: "assistant",
      content: [],
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    // 用于累积工具调用的 JSON 分片
    const jsonAccumulators = new Map<number, string>();

    for await (const event of stream) {
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

    return response;
  }

  /** Agentic 主循环：发送消息 → 处理响应 → 执行工具 → 循环 */
  async agentLoop(userInput: string): Promise<void> {
    // 添加用户消息
    this.ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: userInput }],
    });

    let turns = 0;
    const maxTurns = this.config.maxTurns || 50;

    while (turns < maxTurns) {
      turns++;

      // 发送消息给 LLM
      const stream = this.provider.sendMessageStream(
        {
          model: this.config.model,
          messages: this.ctxMgr.getMessages(),
          system: this.ctxMgr.getSystemPrompt(),
          maxTokens: this.config.maxTokens,
          tools: this.toolRegistry.size() > 0 ? this.toolRegistry.definitions() : undefined,
        },
        this.abortController?.signal,
      );

      // 处理流式响应
      const response = await this.processStream(stream, (text) => {
        process.stdout.write(text);
      });

      // 累计 token 用量
      this.totalUsage.inputTokens += response.usage.inputTokens;
      this.totalUsage.outputTokens += response.usage.outputTokens;

      // 添加助手消息到历史
      this.ctxMgr.addMessage({
        role: "assistant",
        content: response.content,
      });

      // 检查停止原因
      if (response.stopReason === "end_turn" || response.stopReason === "stop") {
        process.stdout.write("\n");
        break;
      }

      // 处理工具调用
      if (response.stopReason === "tool_use") {
        const toolResults = await this.executeTools(response.content);
        // 添加工具结果到历史
        this.ctxMgr.addMessage({
          role: "user",
          content: toolResults,
        });
        // 继续循环
        continue;
      }

      // 其他停止原因
      process.stdout.write("\n");
      break;
    }

    if (turns >= maxTurns) {
      console.log(`\n[达到最大轮次限制: ${maxTurns}]`);
    }
  }

  /** 执行工具调用 */
  async executeTools(content: ContentBlock[]): Promise<ContentBlock[]> {
    const results: ContentBlock[] = [];

    for (const block of content) {
      if (block.type !== "tool_use") continue;

      const tool = this.toolRegistry.get(block.name);
      if (!tool) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `工具 "${block.name}" 未找到`,
          is_error: true,
        });
        continue;
      }

      console.log(`\n[工具调用: ${block.name}]`);

      try {
        const result = await tool.execute(block.input, this.abortController?.signal);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.output,
          is_error: result.isError,
        });

        if (result.isError) {
          console.log(`[工具错误: ${result.output.slice(0, 100)}]`);
        } else {
          // 截断显示
          const preview = result.output.length > 200
            ? result.output.slice(0, 200) + "..."
            : result.output;
          console.log(`[工具结果: ${preview}]`);
        }
      } catch (err: any) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `工具执行异常: ${err.message}`,
          is_error: true,
        });
        console.log(`[工具异常: ${err.message}]`);
      }
    }

    return results;
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

          if (cmdName === "exit" || cmdName === "quit") {
            console.log("再见！");
            rl.close();
            return;
          }

          if (cmdName === "cost") {
            console.log(`Token 用量: 输入 ${this.totalUsage.inputTokens}, 输出 ${this.totalUsage.outputTokens}`);
            prompt();
            return;
          }

          if (cmdName === "clear") {
            this.ctxMgr.clear();
            console.log("对话已清空");
            prompt();
            return;
          }

          if (cmdName === "help") {
            console.log("可用命令:");
            console.log("  /help    - 显示帮助");
            console.log("  /cost    - 显示 token 用量");
            console.log("  /clear   - 清空对话");
            console.log("  /model   - 显示/切换模型");
            console.log("  /exit    - 退出");
            prompt();
            return;
          }

          if (cmdName === "model") {
            if (args) {
              this.config.model = args;
              console.log(`模型已切换为: ${args}`);
            } else {
              console.log(`当前模型: ${this.config.model}`);
            }
            prompt();
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
                totalUsage: this.totalUsage,
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
    const chunks: string[] = [];
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
        usage: this.totalUsage,
      };
      console.log(JSON.stringify(result, null, 2));
    }

    return "";
  }

  /** TUI 模式 */
  async runTUI(initialPrompt?: string): Promise<void> {
    await this.init();

    const React = await import("react");
    const { render } = await import("ink");
    const { TUIApp } = await import("./ui/App.tsx");
    const type = await import("./ui/App.tsx");

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
        usage: { ...this.totalUsage },
      },
    };

    const updateState = (patch: Partial<import("./ui/App.tsx").TUIState>) => {
      stateRef.current = { ...stateRef.current, ...patch };
    };

    // TUI 版本的 agentLoop
    const tuiAgentLoop = async (userInput: string) => {
      this.ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: userInput }],
      });

      updateState({
        messages: this.ctxMgr.getMessages(),
        isLoading: true,
        streamingText: "",
      });

      let turns = 0;
      const maxTurns = this.config.maxTurns || 50;

      while (turns < maxTurns) {
        turns++;

        const stream = this.provider.sendMessageStream(
          {
            model: this.config.model,
            messages: this.ctxMgr.getMessages(),
            system: this.ctxMgr.getSystemPrompt(),
            maxTokens: this.config.maxTokens,
            tools: this.toolRegistry.size() > 0 ? this.toolRegistry.definitions() : undefined,
          },
          this.abortController?.signal,
        );

        // 处理流式响应，更新 TUI 状态
        let streamingText = "";
        const response = await this.processStream(stream, (text) => {
          streamingText += text;
          updateState({ streamingText });
        });

        this.totalUsage.inputTokens += response.usage.inputTokens;
        this.totalUsage.outputTokens += response.usage.outputTokens;

        this.ctxMgr.addMessage({
          role: "assistant",
          content: response.content,
        });

        updateState({
          messages: this.ctxMgr.getMessages(),
          streamingText: "",
          usage: { ...this.totalUsage },
        });

        if (response.stopReason === "end_turn" || response.stopReason === "stop") {
          break;
        }

        if (response.stopReason === "tool_use") {
          // 显示工具执行状态
          const toolBlocks = response.content.filter((b) => b.type === "tool_use");
          for (const block of toolBlocks) {
            if (block.type !== "tool_use") continue;
            updateState({ toolName: block.name, isToolExecuting: true });
          }

          const toolResults = await this.executeTools(response.content);
          this.ctxMgr.addMessage({ role: "user", content: toolResults });

          updateState({
            messages: this.ctxMgr.getMessages(),
            toolName: null,
            isToolExecuting: false,
          });
          continue;
        }

        break;
      }

      updateState({ isLoading: false });
    };

    // 回调
    const callbacks: import("./ui/App.tsx").TUICallbacks = {
      onUserInput: async (text) => {
        try {
          this.abortController = new AbortController();
          await tuiAgentLoop(text);
        } catch (err: any) {
          updateState({ isLoading: false, streamingText: "" });
        } finally {
          this.abortController = null;
        }
      },
      onSlashCommand: async (cmd, args) => {
        if (cmd === "cost") {
          const u = this.totalUsage;
          console.log(`Token: 输入 ${u.inputTokens}, 输出 ${u.outputTokens}`);
        } else if (cmd === "clear") {
          this.ctxMgr.clear();
          updateState({ messages: [] });
        } else if (cmd === "model") {
          if (args) {
            this.config.model = args;
            updateState({ model: args });
          }
        } else if (cmd === "help") {
          console.log("/help /cost /clear /model /exit");
        }
      },
    };

    // 渲染 TUI
    const app = render(
      React.createElement(TUIApp, {
        initialState: stateRef.current,
        callbacks,
        stateRef,
      }),
    );

    // 处理初始提示词
    if (initialPrompt) {
      await callbacks.onUserInput(initialPrompt);
    }

    await app.waitUntilExit();
  }
}
