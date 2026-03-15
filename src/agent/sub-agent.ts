/**
 * 子代理系统
 * 每个子代理有独立的短上下文，干完活只返回结果
 * 主代理当协调者，spawn 子代理执行子任务，汇总结果
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, StreamEvent, Usage } from "../llm/types.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/logger.ts";
import type { HookRunner } from "../hook/runner.ts";

/** 子代理类型 */
export type SubAgentType = "explore" | "task" | "summarize" | "plan";

/** 子代理任务定义 */
export interface SubAgentTask {
  type: SubAgentType;
  description: string;
  prompt: string;
  /** 子代理可用的工具（默认继承主代理的工具） */
  tools?: ToolRegistry;
  /** 子代理最大轮次（默认 10） */
  maxTurns?: number;
  /** 子代理上下文窗口大小（默认 50000） */
  maxTokens?: number;
  /** 超时时间（毫秒，默认 120000） */
  timeout?: number;
}

/** 子代理执行结果 */
export interface SubAgentResult {
  success: boolean;
  output: string;
  usage: Usage;
  turns: number;
}

/** 子代理系统提示词 */
const SYSTEM_PROMPTS: Record<SubAgentType, string> = {
  explore: `你是一个代码库探索代理。你的任务是搜索和分析代码，只返回关键发现。
规则：
- 使用 grep、glob、read 工具搜索代码
- 只返回文件路径、行号和关键代码片段
- 保持输出简洁，不要冗长解释`,

  task: `你是一个任务执行代理。你的任务是完成指定的子任务并返回结果。
规则：
- 专注于完成指定任务
- 完成后简洁地报告结果
- 如果遇到问题，说明原因`,

  summarize: `你是一个摘要代理。你的任务是总结对话内容。
规则：
- 保留关键信息：文件路径、代码修改、决策、待办事项
- 使用中文
- 保持简洁`,

  plan: `你是一个代码分析和规划代理。分析代码库并输出结构化的实现方案。
规则：
- 使用 grep、glob、read 工具搜索和阅读代码
- 输出包含：问题分析、方案设计、涉及文件、实现步骤
- 不要修改任何文件，保持输出简洁可操作`,
};

/** 子代理工具白名单：null 表示不需要工具 */
const ALLOWED_TOOLS: Record<SubAgentType, string[] | null> = {
  explore: ["read", "grep", "glob"],
  task: ["read", "write", "edit", "bash", "grep", "glob"],
  plan: ["read", "grep", "glob"],
  summarize: null,
};

/** 自定义子代理任务（Skills/Agents 用） */
export interface CustomSubAgentTask {
  systemPrompt: string;
  userPrompt: string;
  allowedTools: string[];
  maxTurns?: number;
  maxTokens?: number;
  timeout?: number;
}

export class SubAgent {
  private provider: Provider;
  private model: string;
  private toolRegistry: ToolRegistry;
  private hookRunner?: HookRunner;

  /** 嵌套深度计数器（不允许子代理再 spawn 子代理） */
  static depth = 0;
  static readonly MAX_DEPTH = 1;

  constructor(provider: Provider, model: string, toolRegistry: ToolRegistry, hookRunner?: HookRunner) {
    this.provider = provider;
    this.model = model;
    this.toolRegistry = toolRegistry;
    this.hookRunner = hookRunner;
  }

  /** 执行子代理任务 */
  async execute(task: SubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();

    // 嵌套防护
    if (SubAgent.depth >= SubAgent.MAX_DEPTH) {
      log.warn("SUBAGENT", `嵌套深度超限 (${SubAgent.depth}/${SubAgent.MAX_DEPTH})，拒绝执行`);
      return {
        success: false,
        output: "子代理不允许嵌套调用",
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
      };
    }

    SubAgent.depth++;
    let result: SubAgentResult;
    try {
      result = await this.executeInner(task, signal);
    } finally {
      SubAgent.depth--;
      // subagent_stop hook（非阻塞）
      this.hookRunner?.run("subagent_stop", {
        toolName: `subagent:${task.type}`,
      }).catch(err => log.error("HOOK", `subagent_stop hook 失败: ${err.message}`));
    }
    return result;
  }

  /** 执行自定义子代理任务（Skills/Agents 用） */
  async executeCustom(task: CustomSubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();

    // 嵌套防护
    if (SubAgent.depth >= SubAgent.MAX_DEPTH) {
      log.warn("SUBAGENT", `嵌套深度超限，拒绝执行自定义子代理`);
      return {
        success: false,
        output: "子代理不允许嵌套调用",
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
      };
    }

    SubAgent.depth++;
    let result: SubAgentResult;
    try {
      result = await this.executeCustomInner(task, signal);
    } finally {
      SubAgent.depth--;
      // subagent_stop hook（非阻塞）
      this.hookRunner?.run("subagent_stop", {
        toolName: "subagent:custom",
      }).catch(err => log.error("HOOK", `subagent_stop hook 失败: ${err.message}`));
    }
    return result;
  }

  /** 内部执行逻辑（含超时控制） */
  private async executeInner(task: SubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();
    log.info("SUBAGENT", `启动子代理 [${task.type}]: ${task.description}`);

    // 超时控制（默认 120 秒）
    const timeout = task.timeout ?? 120_000;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    try {
      // 独立的上下文
      const ctxMgr = new ContextManager({
        maxTokens: task.maxTokens ?? 50000,
      });

      const systemPrompt = SYSTEM_PROMPTS[task.type];
      ctxMgr.setSystemPrompt(systemPrompt);

      // 添加任务提示
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: task.prompt }],
      });

      const allowedNames = ALLOWED_TOOLS[task.type];
      const tools = allowedNames
        ? (task.tools ?? this.toolRegistry).filter(allowedNames)
        : new ToolRegistry();
      const maxTurns = task.maxTurns ?? 10;
      const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let turns = 0;
      let lastTextOutput = "";

      while (turns < maxTurns) {
        turns++;
        log.debug("SUBAGENT", `[${task.type}] 轮次 ${turns}/${maxTurns}`);

        const toolDefs = tools.size() > 0 ? tools.definitions() : undefined;

        const stream = this.provider.sendMessageStream(
          {
            model: this.model,
            messages: ctxMgr.getMessages(),
            system: ctxMgr.getSystemPrompt(),
            maxTokens: 4096,
            tools: toolDefs,
          },
          mergedSignal,
        );

        // 处理流式响应
        const response = await this.processStream(stream);

        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;

        // 提取文本输出
        const textBlocks = response.content.filter(b => b.type === "text");
        if (textBlocks.length > 0) {
          lastTextOutput = textBlocks
            .map(b => b.type === "text" ? b.text : "")
            .join("\n");
        }

        ctxMgr.addMessage({
          role: "assistant",
          content: response.content,
        });

        // 检查停止原因
        if (response.stopReason === "end_turn" || response.stopReason === "stop") {
          log.info("SUBAGENT", `[${task.type}] 完成，共 ${turns} 轮`);
          break;
        }

        // 处理工具调用
        if (response.stopReason === "tool_use") {
          const toolResults = await this.executeTools(response.content, tools, mergedSignal);
          ctxMgr.addMessage({
            role: "user",
            content: toolResults,
          });
          continue;
        }

        break;
      }

      log.info("SUBAGENT", `[${task.type}] 结果: ${lastTextOutput.slice(0, 200)}`);

      return {
        success: true,
        output: lastTextOutput,
        usage: totalUsage,
        turns,
      };
    } catch (err: any) {
      // 超时中断时返回友好提示
      if (timeoutCtrl.signal.aborted) {
        log.warn("SUBAGENT", `[${task.type}] 超时 (${timeout}ms)`);
        return {
          success: false,
          output: `子代理执行超时 (${Math.round(timeout / 1000)}秒)`,
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
        };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 自定义子代理内部执行逻辑（复用流式处理和工具执行） */
  private async executeCustomInner(task: CustomSubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();
    log.info("SUBAGENT", `启动自定义子代理`);

    const timeout = task.timeout ?? 120_000;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeout);
    const mergedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    try {
      const ctxMgr = new ContextManager({
        maxTokens: task.maxTokens ?? 50000,
      });

      ctxMgr.setSystemPrompt(task.systemPrompt);
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: task.userPrompt }],
      });

      const tools = task.allowedTools.length > 0
        ? this.toolRegistry.filter(task.allowedTools)
        : new ToolRegistry();
      const maxTurns = task.maxTurns ?? 10;
      const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let turns = 0;
      let lastTextOutput = "";

      while (turns < maxTurns) {
        turns++;
        log.debug("SUBAGENT", `[custom] 轮次 ${turns}/${maxTurns}`);

        const toolDefs = tools.size() > 0 ? tools.definitions() : undefined;

        const stream = this.provider.sendMessageStream(
          {
            model: this.model,
            messages: ctxMgr.getMessages(),
            system: ctxMgr.getSystemPrompt(),
            maxTokens: 4096,
            tools: toolDefs,
          },
          mergedSignal,
        );

        const response = await this.processStream(stream);

        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;

        const textBlocks = response.content.filter(b => b.type === "text");
        if (textBlocks.length > 0) {
          lastTextOutput = textBlocks
            .map(b => b.type === "text" ? b.text : "")
            .join("\n");
        }

        ctxMgr.addMessage({
          role: "assistant",
          content: response.content,
        });

        if (response.stopReason === "end_turn" || response.stopReason === "stop") {
          break;
        }

        if (response.stopReason === "tool_use") {
          const toolResults = await this.executeTools(response.content, tools, mergedSignal);
          ctxMgr.addMessage({
            role: "user",
            content: toolResults,
          });
          continue;
        }

        break;
      }

      log.info("SUBAGENT", `[custom] 完成，共 ${turns} 轮`);

      return {
        success: true,
        output: lastTextOutput,
        usage: totalUsage,
        turns,
      };
    } catch (err: any) {
      if (timeoutCtrl.signal.aborted) {
        log.warn("SUBAGENT", `[custom] 超时 (${timeout}ms)`);
        return {
          success: false,
          output: `子代理执行超时 (${Math.round(timeout / 1000)}秒)`,
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
        };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  private async processStream(stream: AsyncIterable<StreamEvent>): Promise<{
    content: ContentBlock[];
    stopReason: string | null;
    usage: Usage;
  }> {
    const content: ContentBlock[] = [];
    let stopReason: string | null = null;
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const jsonAccumulators = new Map<number, string>();

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          usage.inputTokens += event.message.usage.inputTokens;
          usage.outputTokens += event.message.usage.outputTokens;
          break;

        case "content_block_start":
          if (event.content_block.type === "text") {
            content[event.index] = { type: "text", text: "" };
          } else if (event.content_block.type === "tool_use") {
            content[event.index] = {
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
            const block = content[event.index];
            if (block?.type === "text") {
              block.text += delta.text;
            }
          } else if (delta.type === "input_json_delta") {
            const acc = jsonAccumulators.get(event.index) ?? "";
            jsonAccumulators.set(event.index, acc + delta.partial_json);
          }
          break;
        }

        case "content_block_stop": {
          const jsonStr = jsonAccumulators.get(event.index);
          if (jsonStr !== undefined) {
            const block = content[event.index];
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
          stopReason = event.delta.stop_reason;
          usage.outputTokens += event.usage.outputTokens;
          break;

        case "error":
          throw new Error(`子代理 LLM 错误: ${event.error.message}`);
      }
    }

    return { content, stopReason, usage };
  }

  /** 执行工具调用（子代理版本，无权限检查） */
  private async executeTools(
    content: ContentBlock[],
    tools: ToolRegistry,
    signal?: AbortSignal,
  ): Promise<ContentBlock[]> {
    const log = getLogger();
    const results: ContentBlock[] = [];

    for (const block of content) {
      if (block.type !== "tool_use") continue;

      const tool = tools.get(block.name);
      if (!tool) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `工具 "${block.name}" 未找到`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await tool.execute(block.input, signal);
        // 截断超大输出
        const truncated = ContextManager.truncateToolOutput(result.output);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: truncated,
          is_error: result.isError,
        });
      } catch (err: any) {
        log.error("SUBAGENT:TOOL", `工具执行异常: ${block.name}`, { error: err.message });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `工具执行异常: ${err.message}`,
          is_error: true,
        });
      }
    }

    return results;
  }
}
