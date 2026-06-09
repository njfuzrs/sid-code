/**
 * 子代理系统
 * 每个子代理有独立的短上下文，干完活只返回结果
 * 主代理当协调者，spawn 子代理执行子任务，汇总结果
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, Usage } from "../llm/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/logger.ts";
import type { HookSystem } from "../hook/system.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT } from "./loop-detection.ts";
import { filterToolsForAgent } from "./tool-filter.ts";
import {
  createAgentTask,
  completeAgentTask,
  failAgentTask,
  appendAgentOutput,
  updateAgentProgress,
  updateTask,
} from "../task/index.ts";
import type { AgentTaskResult, LocalAgentTaskState } from "../task/types.ts";
import {
  type ParentInitMessage,
  type ChildMessage,
  writeParentMsg,
} from "./sub-agent-protocol.ts";
import { drainAgentMessages } from "./message-queue.ts";
import { getAgentSystemPrompt, getAgentWhenToUse, type AgentDefinition } from "./agent-definition.ts";
import { processStream } from "./stream-processor.ts";
import { executeTools } from "./tool-executor.ts";

/** 子代理类型 */
export type SubAgentType = "explore" | "task" | "summarize" | "plan" | "verify";

/** 子代理任务定义 */
export interface SubAgentTask {
  type: string;
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
  /** 外部预创建的 task ID（后台执行时由 runAsync 预先创建，内部使用） */
  _taskId?: string;
  /** 外部预创建的 AbortController（后台执行时使用） */
  _abortController?: AbortController;
}

/** 子代理执行结果 */
export interface SubAgentResult {
  success: boolean;
  output: string;
  usage: Usage;
  turns: number;
  /** 工具调用次数（用于构造结构化 AgentTaskResult） */
  toolUseCount: number;
}

/** 子代理系统提示词（从 AgentDefinition 注册表获取，兼容内置 + 自定义类型） */
function getSystemPrompt(type: string): string {
  return getAgentSystemPrompt(type) ?? `你是一个 ${type} 代理。完成指定任务并返回结果。\n规则：\n- 专注于完成指定任务\n- 完成后简洁地报告完成状态和关键输出`;
}

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

    // 创建或获取 task 状态（后台执行时由 runAsync 预先创建）
    let taskId: string;
    let abortController: AbortController;
    if (task._taskId && task._abortController) {
      taskId = task._taskId;
      abortController = task._abortController;
    } else {
      const created = createAgentTask({
        agentType: task.type,
        prompt: task.prompt,
        description: task.description,
      });
      taskId = created.taskState.id;
      abortController = created.abortController;
    }

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
          result = await this.executeInner(task, signal, taskId);
        }
      } else {
        result = await this.executeInner(task, signal, taskId);
      }

      // 成功：标记任务完成并发送通知（结构化结果）
      if (result.success) {
        const agentResult: AgentTaskResult = {
          output: result.output,
          totalToolUseCount: result.toolUseCount,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          usage: result.usage,
        };
        await completeAgentTask(taskId, agentResult);
      } else {
        await failAgentTask(taskId, result.output);
      }
    } catch (err: any) {
      // 顶层异常兜底
      log.error("SUBAGENT", `[${task.type}] 顶层异常`, { error: err.message });
      await failAgentTask(taskId, err.message).catch(() => {});
      result = {
        success: false,
        output: `子代理执行异常: ${err.message}`,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
        toolUseCount: 0,
      };
    } finally {
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
    const systemPrompt = getSystemPrompt(task.type);
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
                toolUseCount: msg.toolUseCount ?? 0,
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
          toolUseCount: 0,
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
      // 注入 _agentId 标记，防止子代理调用 enter_plan_mode 形成套娃
      const result = await tool.execute({ ...input, _agentId: "sub-agent" }, signal);
      const truncated = ContextManager.truncateToolOutput(result.output);
      return { content: truncated, is_error: result.isError ?? false };
    } catch (err: any) {
      return { content: `工具执行异常: ${err.message}`, is_error: true };
    }
  }

  /** 内部执行逻辑（含超时控制） */
  private async executeInner(task: SubAgentTask, signal?: AbortSignal, taskId?: string): Promise<SubAgentResult> {
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

      const systemPrompt = getSystemPrompt(task.type);
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
      let toolUseCount = 0;
      let lastTextOutput = "";
      const loopDetector = new LoopDetector();

      const toolNames = filteredTools.map(t => t.name());
      log.info("SUBAGENT", `[${task.type}] 可用工具: ${toolNames.join(", ") || "无"}, 超时: ${timeout / 1000}秒, 最大轮次: ${maxTurns}`);

      while (turns < maxTurns) {
        turns++;
        log.debug("SUBAGENT", `[${task.type}] 轮次 ${turns}/${maxTurns}`);

        // 消费 SendMessage 注入的消息（对标 claude-code pendingMessages 机制）
        // 从第 2 轮开始检查（第 1 轮刚启动，通常还没有消息）
        if (taskId && turns > 1) {
          const injected = drainAgentMessages(taskId);
          for (const msg of injected) {
            log.info("SUBAGENT", `[${task.type}] 收到主代理消息: ${msg.slice(0, 100)}`);
            ctxMgr.addMessage({
              role: "user",
              content: [{ type: "text", text: `[主代理消息] ${msg}` }],
            });
          }
        }

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
        const response = await processStream(stream);

        // LLM API 错误处理：不再穿透，转为失败结果
        if (response.stopReason === "error") {
          log.error("SUBAGENT", `[${task.type}] LLM 错误: ${response.errorMessage}`);
          return {
            success: false,
            output: response.errorMessage || "子代理 LLM 错误",
            usage: totalUsage,
            turns,
            toolUseCount,
          };
        }

        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;

        // 提取文本输出
        const textBlocks = response.content.filter(b => b.type === "text");
        if (textBlocks.length > 0) {
          lastTextOutput = textBlocks
            .map(b => b.type === "text" ? b.text : "")
            .join("\n");
        }

        // 实时写输出到磁盘（支持 task_output 增量读取）
        if (taskId && lastTextOutput) {
          appendAgentOutput(taskId, `[轮次 ${turns}] ${lastTextOutput}\n`);
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

          // 统计工具调用次数
          const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
          toolUseCount += toolUseBlocks.length;

          const toolResults = await executeTools(response.content, tools, mergedSignal);
          ctxMgr.addMessage({
            role: "user",
            content: toolResults,
          });

          // 更新任务进度（供 pollTasks 读取实时状态）
          if (taskId) {
            const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
            updateAgentProgress(taskId, {
              toolUseCount,
              tokenCount: totalUsage.inputTokens + totalUsage.outputTokens,
              lastActivity: lastTool ? {
                toolName: lastTool.name,
                input: lastTool.input as Record<string, unknown>,
                activityDescription: `${lastTool.name}: ${JSON.stringify(lastTool.input).slice(0, 80)}`,
              } : undefined,
              recentActivities: [],
            });

            // M5 opt-in: 周期性进度摘要（每 5 轮生成一次）
            if (process.env.SIDCODE_AGENT_PROGRESS_SUMMARY === "1" && turns % 5 === 0) {
              const toolNames = toolUseBlocks.map(b => b.name).join(", ");
              const textPreview = lastTextOutput.slice(0, 100);
              const summary = `[轮次 ${turns}] 工具: ${toolNames || "(无)"} | 输出预览: ${textPreview || "(无文本)"}`;
              updateTask<LocalAgentTaskState>(taskId, (t) => ({
                ...t,
                progressSummary: summary,
              }));
            }
          }
          continue;
        }

        break;
      }

      // 提取最终结果：从所有 assistant 消息中回溯查找最后一条有文本内容的
      // 参考 claude-code finalizeAgentTool 回退逻辑：优先最后一条有 text 的 assistant
      const finalOutput = this.extractFinalText(ctxMgr.getMessages(), lastTextOutput);
      log.info("SUBAGENT", `[${task.type}] 结果: ${finalOutput.slice(0, 200)}`);
      log.info("SUBAGENT", `[${task.type}] 完成，共 ${turns} 轮，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

      return {
        success: true,
        output: finalOutput,
        usage: totalUsage,
        turns,
        toolUseCount,
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
          toolUseCount: 0,
        };
      }
      // 其他异常也不穿透，转为失败结果
      log.error("SUBAGENT", `[${task.type}] 执行异常`, { error: err.message });
      return {
        success: false,
        output: `子代理执行异常: ${err.message}`,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
        toolUseCount: 0,
      };
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
      let toolUseCount = 0;
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

        const response = await processStream(stream);

        // LLM API 错误处理：不再穿透，转为失败结果
        if (response.stopReason === "error") {
          log.error("SUBAGENT", `[custom] LLM 错误: ${response.errorMessage}`);
          return {
            success: false,
            output: response.errorMessage || "子代理 LLM 错误",
            usage: totalUsage,
            turns,
            toolUseCount,
          };
        }

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

          // 统计工具调用次数
          const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
          toolUseCount += toolUseBlocks.length;

          const toolResults = await executeTools(response.content, tools, mergedSignal);
          ctxMgr.addMessage({
            role: "user",
            content: toolResults,
          });
          continue;
        }

        break;
      }

      // 提取最终结果：从所有 assistant 消息中回溯查找最后一条有文本内容的
      const finalOutput = this.extractFinalText(ctxMgr.getMessages(), lastTextOutput);
      log.info("SUBAGENT", `[custom] 完成，共 ${turns} 轮，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

      return {
        success: true,
        output: finalOutput,
        usage: totalUsage,
        turns,
        toolUseCount,
      };
    } catch (err: any) {
      if (timeoutCtrl.signal.aborted) {
        log.warn("SUBAGENT", `[custom] 超时 (${timeout}ms)`);
        return {
          success: false,
          output: `子代理执行超时 (${Math.round(timeout / 1000)}秒)`,
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          toolUseCount: 0,
        };
      }
      // 其他异常也不穿透，转为失败结果
      log.error("SUBAGENT", `[custom] 执行异常`, { error: err.message });
      return {
        success: false,
        output: `子代理执行异常: ${err.message}`,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 0,
        toolUseCount: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  }

  /** 从所有 assistant 消息中回溯提取最终文本输出
   *  参考 claude-code finalizeAgentTool 回退逻辑：
   *  优先取最后一条有 text content 的 assistant 消息，
   *  如果最后一条 assistant 是纯 tool_use block（无文本），向前查找最近的有文本的，
   *  只有在完全没有文本时才回退到 lastTextOutput */
  private extractFinalText(messages: Array<{ role: string; content: ContentBlock[] }>, fallback: string): string {
    // 倒序遍历所有消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      const texts = (msg.content as ContentBlock[])
        .filter(b => b.type === "text")
        .map(b => b.type === "text" ? b.text : "")
        .join("\n")
        .trim();
      if (texts) return texts;
    }
    return fallback;
  }
}
