/**
 * 子代理系统
 * 每个子代理有独立的短上下文，干完活只返回结果
 * 主代理当协调者，spawn 子代理执行子任务，汇总结果
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, StreamEvent, Usage, ToolDefinition } from "../llm/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/logger.ts";
import type { HookSystem } from "../hook/system.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT } from "./loop-detection.ts";
import { filterToolsForAgent } from "./tool-filter.ts";
import {
  type ParentInitMessage,
  type ChildMessage,
  writeParentMsg,
} from "./sub-agent-protocol.ts";

/** 子代理类型 */
export type SubAgentType = "explore" | "task" | "summarize" | "plan" | "verify";

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

  verify: `你是一个对抗式验证代理。你的任务是验证给定的结论/修复/发现是否真实成立。
规则：
- 默认持怀疑态度，主动寻找反例和漏洞
- 用 read/grep/bash 等只读手段核实，不要修改文件
- 不确定时倾向于判定"未通过验证"
- 输出明确结论：通过 / 未通过 + 关键证据`,
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
  private hookSystem?: HookSystem;
  /** ProviderRegistry 引用（fromRegistry 创建时设置） */
  private registry?: ProviderRegistry;
  /** 模型覆盖（自定义 Agent/Skill 指定模型时使用） */
  private modelOverride?: string;

  /** Spawn 模式配置（子进程启动所需的 Provider 信息） */
  private spawnConfig?: { providerName: string; apiKey: string; baseURL?: string };

  /** 嵌套深度计数器（不允许子代理再 spawn 子代理） */
  static depth = 0;
  static readonly MAX_DEPTH = 1;

  constructor(provider: Provider, model: string, toolRegistry: ToolRegistry, hookSystem?: HookSystem) {
    this.provider = provider;
    this.model = model;
    this.toolRegistry = toolRegistry;
    this.hookSystem = hookSystem;
  }

  /** 从 ProviderRegistry 创建（子代理类型决定 model/provider） */
  static fromRegistry(
    registry: ProviderRegistry,
    toolRegistry: ToolRegistry,
    hookSystem?: HookSystem,
    modelOverride?: string,
  ): SubAgent {
    // 用主 provider/model 初始化（executeInner 中会动态替换）
    const provider = registry.getProvider();
    const model = modelOverride || registry.getCurrentModel();
    const agent = new SubAgent(provider, model, toolRegistry, hookSystem);
    agent.registry = registry;
    agent.modelOverride = modelOverride;
    // 保存 spawn 配置（用于子进程启动，兼容未实现 getSpawnConfig 的 registry）
    try { agent.spawnConfig = registry.getSpawnConfig?.(); } catch { /* registry 未实现 getSpawnConfig，spawn 模式自动回退 */ }
    return agent;
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
      // SubagentStart hook
      this.hookSystem?.fireSubagentStartEvent(
        `subagent-${task.type}-${Date.now()}`,
        task.type,
      ).catch(err => log.error("HOOK", `subagent_start hook 失败: ${err.message}`));

      // 尝试 spawn 模式（独立进程，避免 V8 OOM）
      if (this.shouldUseSpawn()) {
        try {
          result = await this.executeSpawned(task, signal);
          log.info("SUBAGENT", `[${task.type}] spawn 模式完成`);
        } catch (err: any) {
          log.warn("SUBAGENT", `spawn 模式失败，回退到进程内模式: ${err.message}`);
          result = await this.executeInner(task, signal);
        }
      } else {
        result = await this.executeInner(task, signal);
      }
    } finally {
      SubAgent.depth--;
      // subagent_stop hook（非阻塞）
      this.hookSystem?.fireSubagentStopEvent({
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
      // SubagentStart hook
      this.hookSystem?.fireSubagentStartEvent(
        `subagent-custom-${Date.now()}`,
        "custom",
      ).catch(err => log.error("HOOK", `subagent_start hook 失败: ${err.message}`));

      // 尝试 spawn 模式
      if (this.shouldUseSpawn()) {
        try {
          result = await this.executeSpawnedCustom(task, signal);
          log.info("SUBAGENT", `[custom] spawn 模式完成`);
        } catch (err: any) {
          log.warn("SUBAGENT", `spawn 模式失败，回退到进程内模式: ${err.message}`);
          result = await this.executeCustomInner(task, signal);
        }
      } else {
        result = await this.executeCustomInner(task, signal);
      }
    } finally {
      SubAgent.depth--;
      // subagent_stop hook（非阻塞）
      this.hookSystem?.fireSubagentStopEvent({
        toolName: "subagent:custom",
      }).catch(err => log.error("HOOK", `subagent_stop hook 失败: ${err.message}`));
    }
    return result;
  }

  // ============================================================
  // Spawn 模式（Wave 2：进程隔离）
  // ============================================================

  /** 判断是否使用 spawn 模式（可通过环境变量 SIDCODE_NO_SPAWN=1 禁用） */
  private shouldUseSpawn(): boolean {
    if (process.env.SIDCODE_NO_SPAWN === "1") return false;
    if (!this.spawnConfig) return false;
    // 需要 Bun.spawn 可用（Bun 运行时）
    return typeof Bun !== "undefined" && typeof Bun.spawn === "function";
  }

  /** 从工具注册表获取工具定义列表（用于 spawn init 消息） */
  private getToolDefs(task: SubAgentTask): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const sourceRegistry = task.tools ?? this.toolRegistry;
    const allTools = sourceRegistry.all();
    const filteredTools = filterToolsForAgent(allTools, {
      isBuiltIn: true,
      builtInType: task.type,
    });
    return filteredTools.map(t => ({
      name: t.name(),
      description: t.description(),
      inputSchema: t.inputSchema(),
    }));
  }

  /** 获取自定义子代理的工具定义 */
  private getCustomToolDefs(allowedTools: string[]): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const filtered = this.toolRegistry.filter(allowedTools);
    return filtered.all().map(t => ({
      name: t.name(),
      description: t.description(),
      inputSchema: t.inputSchema(),
    }));
  }

  /** Spawn 子代理（标准类型） */
  private async executeSpawned(task: SubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const systemPrompt = SYSTEM_PROMPTS[task.type];
    const toolDefs = this.getToolDefs(task);

    const initMsg: ParentInitMessage = {
      type: "init",
      session_id: `subagent-${task.type}-${Date.now()}`,
      task_type: task.type,
      system_prompt: systemPrompt,
      user_prompt: task.prompt,
      allowed_tools: toolDefs.map(t => t.name),
      tool_defs: toolDefs,
      model: this.model,
      max_turns: task.maxTurns ?? 10,
      max_tokens: task.maxTokens ?? 50000,
      timeout: task.timeout ?? 120_000,
      workdir: process.cwd(),
      provider_name: this.spawnConfig!.providerName,
      api_key: this.spawnConfig!.apiKey,
      base_url: this.spawnConfig?.baseURL,
    };

    return this.executeSpawnedInternal(initMsg, task.tools ?? this.toolRegistry, signal);
  }

  /** Spawn 自定义子代理 */
  private async executeSpawnedCustom(task: CustomSubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const tools = task.allowedTools.length > 0
      ? this.toolRegistry.filter(task.allowedTools)
      : new ToolRegistry();
    const toolDefs = this.getCustomToolDefs(task.allowedTools);

    const initMsg: ParentInitMessage = {
      type: "init",
      session_id: `subagent-custom-${Date.now()}`,
      task_type: "task", // 自定义代理按 task 类型
      system_prompt: task.systemPrompt,
      user_prompt: task.userPrompt,
      allowed_tools: task.allowedTools,
      tool_defs: toolDefs,
      model: this.model,
      max_turns: task.maxTurns ?? 10,
      max_tokens: task.maxTokens ?? 50000,
      timeout: task.timeout ?? 120_000,
      workdir: process.cwd(),
      provider_name: this.spawnConfig!.providerName,
      api_key: this.spawnConfig!.apiKey,
      base_url: this.spawnConfig?.baseURL,
    };

    return this.executeSpawnedInternal(initMsg, tools, signal);
  }

  /** 核心 spawn 逻辑：启动子进程、通信、超时控制 */
  private async executeSpawnedInternal(
    initMsg: ParentInitMessage,
    tools: ToolRegistry,
    signal?: AbortSignal,
  ): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
    const timeout = initMsg.timeout;

    // 构建启动参数
    const spawnArgs = ["run", "src/entrypoints/headless.ts"];
    // 容器环境设堆限制
    const maxOldSpace = process.env.SIDCODE_MAX_OLD_SPACE_SIZE;
    if (maxOldSpace) {
      spawnArgs.unshift(`--max-old-space-size=${maxOldSpace}`);
    }

    log.info("SUBAGENT", `spawn 子进程: bun ${spawnArgs.join(" ")}`);

    // Spawn 子进程
    const subprocess = Bun.spawn(["bun", ...spawnArgs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: process.cwd(),
      env: { ...process.env },
    });

    // 发送 init 消息
    writeParentMsg(subprocess.stdin, initMsg);

    // 超时控制
    const timeoutId = setTimeout(() => {
      log.warn("SUBAGENT", `spawn 子进程超时 (${Math.round(timeout / 1000)}秒)，kill`);
      if (!subprocess.killed) subprocess.kill();
    }, timeout);

    // 父进程 abort → kill 子进程
    const onAbort = () => {
      log.info("SUBAGENT", "父进程 abort，kill 子进程");
      if (!subprocess.killed) subprocess.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // 读取子进程 stdout 消息循环
      const stdoutReader = subprocess.stdout.getReader();
      const decoder = new TextDecoder();
      let stdoutBuffer = "";
      let result: SubAgentResult | null = null;

      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;

        stdoutBuffer += decoder.decode(value, { stream: true });
        // 按行分割
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || ""; // 保留不完整的最后一行

        for (const line of lines) {
          if (!line.trim()) continue;

          let msg: ChildMessage;
          try {
            msg = JSON.parse(line);
          } catch {
            log.warn("SUBAGENT", `子进程 stdout 非 JSON: ${line.slice(0, 100)}`);
            continue;
          }

          switch (msg.type) {
            case "ready":
              break;

            case "tool_use": {
              // 父进程执行工具并返回结果
              const toolResult = await this.executeToolForChild(
                msg.name,
                msg.input,
                tools,
                signal,
              );
              writeParentMsg(subprocess.stdin, {
                type: "tool_result",
                tool_use_id: msg.id,
                content: toolResult.content,
                is_error: toolResult.is_error,
              });
              break;
            }

            case "progress":
              break;

            case "result":
              result = {
                success: msg.success,
                output: msg.output,
                usage: msg.usage,
                turns: msg.turns,
              };
              break;

            case "crash":
              throw new Error(
                `子代理崩溃: ${msg.error}${msg.stack ? `\n${msg.stack}` : ""}`,
              );
          }
        }

        if (result) break;
      }

      // 等待子进程退出
      await subprocess.exited;

      if (!result) {
        const exitCode = subprocess.exitCode;
        return {
          success: false,
          output: `子代理意外退出 (exit code: ${exitCode})`,
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
        };
      }

      log.info("SUBAGENT", `spawn 完成，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

      return result;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      // 确保子进程被终止
      if (!subprocess.killed) {
        subprocess.kill();
      }
    }
  }

  /** 为子进程执行工具（与 executeSingleTool 类似，但输入来自 ChildToolUseMessage） */
  private async executeToolForChild(
    name: string,
    input: Record<string, unknown>,
    tools: ToolRegistry,
    signal?: AbortSignal,
  ): Promise<{ content: string; is_error: boolean }> {
    const tool = tools.get(name);

    if (!tool) {
      return { content: `工具 "${name}" 未找到`, is_error: true };
    }

    try {
      const result = await tool.execute(input, signal);
      const truncated = ContextManager.truncateToolOutput(result.output);
      return { content: truncated, is_error: result.isError ?? false };
    } catch (err: any) {
      return { content: `工具执行异常: ${err.message}`, is_error: true };
    }
  }

  /** 内部执行逻辑（含超时控制） */
  private async executeInner(task: SubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const log = getLogger();
    const startTime = Date.now();
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

      const sourceRegistry = task.tools ?? this.toolRegistry;
      const allTools = sourceRegistry.all();
      const filteredTools = filterToolsForAgent(allTools, {
        isBuiltIn: true,
        builtInType: task.type,
      });
      const tools = new ToolRegistry();
      for (const t of filteredTools) tools.register(t);
      const maxTurns = task.maxTurns ?? 10;
      const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let turns = 0;
      let lastTextOutput = "";
      const loopDetector = new LoopDetector();

      const toolNames = filteredTools.map(t => t.name());
      log.info("SUBAGENT", `[${task.type}] 可用工具: ${toolNames.join(", ") || "无"}, 超时: ${timeout / 1000}秒, 最大轮次: ${maxTurns}`);

      while (turns < maxTurns) {
        turns++;
        log.debug("SUBAGENT", `[${task.type}] 轮次 ${turns}/${maxTurns}`);

        const toolDefs = tools.size() > 0 ? tools.definitions() : undefined;

        // 动态获取 provider/model（registry 模式下按子代理类型选择）
        const activeProvider = this.registry
          ? this.registry.getProviderForSubAgent(task.type)
          : this.provider;
        const activeModel = this.registry
          ? this.registry.getModelForSubAgent(task.type)
          : this.model;

        const stream = activeProvider.sendMessageStream(
          {
            model: activeModel,
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

        // 内容循环检测
        if (lastTextOutput && loopDetector.recordContent(lastTextOutput)) {
          if (!loopDetector.tryRecover()) {
            log.warn("SUBAGENT", `[${task.type}] 内容循环恢复次数耗尽，终止`);
            break;
          }
          log.info("SUBAGENT", `[${task.type}] 检测到内容循环，注入恢复提示`);
          ctxMgr.addMessage({
            role: "user",
            content: [{ type: "text", text: LOOP_RECOVERY_PROMPT }],
          });
          continue;
        }

        // 检查停止原因
        if (response.stopReason === "end_turn" || response.stopReason === "stop") {
          log.info("SUBAGENT", `[${task.type}] 完成，共 ${turns} 轮`);
          break;
        }

        // 处理工具调用
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
              log.warn("SUBAGENT", `[${task.type}] 工具循环恢复次数耗尽，终止`);
              break;
            }
            log.info("SUBAGENT", `[${task.type}] 检测到工具循环，注入恢复提示`);
            ctxMgr.addMessage({
              role: "user",
              content: [{ type: "text", text: LOOP_RECOVERY_PROMPT }],
            });
            continue;
          }

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
      log.info("SUBAGENT", `[${task.type}] 完成，共 ${turns} 轮，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

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
    const startTime = Date.now();
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
      const loopDetector = new LoopDetector();

      log.info("SUBAGENT", `[custom] 可用工具: ${task.allowedTools.join(", ") || "无"}, 超时: ${timeout / 1000}秒, 最大轮次: ${maxTurns}`);

      while (turns < maxTurns) {
        turns++;
        log.debug("SUBAGENT", `[custom] 轮次 ${turns}/${maxTurns}`);

        const toolDefs = tools.size() > 0 ? tools.definitions() : undefined;

        // 动态获取 provider/model（registry 模式下使用 modelOverride 或主模型）
        const activeProvider = this.registry
          ? (this.modelOverride
            ? this.registry.getProviderForSubAgent("task")  // 自定义 agent 按 task 类型查找
            : this.registry.getProvider())
          : this.provider;
        const activeModel = this.modelOverride || (this.registry
          ? this.registry.getCurrentModel()
          : this.model);

        const stream = activeProvider.sendMessageStream(
          {
            model: activeModel,
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

        // 内容循环检测
        if (lastTextOutput && loopDetector.recordContent(lastTextOutput)) {
          if (!loopDetector.tryRecover()) {
            log.warn("SUBAGENT", `[custom] 内容循环恢复次数耗尽，终止`);
            break;
          }
          log.info("SUBAGENT", `[custom] 检测到内容循环，注入恢复提示`);
          ctxMgr.addMessage({
            role: "user",
            content: [{ type: "text", text: LOOP_RECOVERY_PROMPT }],
          });
          continue;
        }

        if (response.stopReason === "end_turn" || response.stopReason === "stop") {
          break;
        }

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
              log.warn("SUBAGENT", `[custom] 工具循环恢复次数耗尽，终止`);
              break;
            }
            log.info("SUBAGENT", `[custom] 检测到工具循环，注入恢复提示`);
            ctxMgr.addMessage({
              role: "user",
              content: [{ type: "text", text: LOOP_RECOVERY_PROMPT }],
            });
            continue;
          }

          const toolResults = await this.executeTools(response.content, tools, mergedSignal);
          ctxMgr.addMessage({
            role: "user",
            content: toolResults,
          });
          continue;
        }

        break;
      }

      log.info("SUBAGENT", `[custom] 完成，共 ${turns} 轮，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

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

  /** 执行工具调用（子代理版本，无权限检查，支持并行执行） */
  private async executeTools(
    content: ContentBlock[],
    tools: ToolRegistry,
    signal?: AbortSignal,
  ): Promise<ContentBlock[]> {
    const log = getLogger();

    // 提取所有 tool_use 块，保留原始顺序索引
    const toolBlocks = content
      .map((block, idx) => ({ block, idx }))
      .filter((item): item is { block: ContentBlock & { type: "tool_use" }; idx: number } =>
        item.block.type === "tool_use"
      );

    if (toolBlocks.length === 0) return [];

    // 分离只读和写入工具
    const readOnlyBlocks: typeof toolBlocks = [];
    const writingBlocks: typeof toolBlocks = [];
    const notFoundBlocks: typeof toolBlocks = [];

    for (const item of toolBlocks) {
      const tool = tools.get(item.block.name);
      if (!tool) {
        notFoundBlocks.push(item);
        continue;
      }
      if (tool.readOnly?.() === true) {
        readOnlyBlocks.push(item);
      } else {
        writingBlocks.push(item);
      }
    }

    log.debug("SUBAGENT:TOOL", `工具分类: 只读 ${readOnlyBlocks.length} 个并行, 写入 ${writingBlocks.length} 个串行`);

    // 结果收集（按原始顺序索引存储）
    const resultMap = new Map<number, ContentBlock>();

    // 未找到的工具直接返回错误
    for (const { block, idx } of notFoundBlocks) {
      resultMap.set(idx, {
        type: "tool_result",
        tool_use_id: block.id,
        content: `工具 "${block.name}" 未找到`,
        is_error: true,
      });
    }

    // 只读工具并行执行
    if (readOnlyBlocks.length > 0) {
      const readResults = await Promise.all(
        readOnlyBlocks.map(({ block, idx }) =>
          this.executeSingleTool(block, tools, signal).then(r => ({ idx, result: r }))
        )
      );
      for (const { idx, result } of readResults) {
        resultMap.set(idx, result);
      }
    }

    // 写入工具串行执行
    for (const { block, idx } of writingBlocks) {
      const result = await this.executeSingleTool(block, tools, signal);
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
  private async executeSingleTool(
    block: ContentBlock & { type: "tool_use" },
    tools: ToolRegistry,
    signal?: AbortSignal,
  ): Promise<ContentBlock> {
    const log = getLogger();
    const tool = tools.get(block.name);

    if (!tool) {
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `工具 "${block.name}" 未找到`,
        is_error: true,
      };
    }

    try {
      const result = await tool.execute(block.input, signal);
      // 截断超大输出
      const truncated = ContextManager.truncateToolOutput(result.output);
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: truncated,
        is_error: result.isError,
      };
    } catch (err: any) {
      log.error("SUBAGENT:TOOL", `工具执行异常: ${block.name}`, { error: err.message });
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `工具执行异常: ${err.message}`,
        is_error: true,
      };
    }
  }
}
