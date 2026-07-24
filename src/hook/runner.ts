/**
 * Hook 执行引擎
 * 支持 command/url/runtime 三种类型、并行/串行执行、双阶段杀进程、退出码语义、环境变量清理
 */

import { spawn } from "bun";
import {
  HookEventName,
  type HookConfig,
  type CommandHookConfig,
  type UrlHookConfig,
  type RuntimeHookConfig,
  type PromptHookConfig,
  type AgentHookConfig,
  type HookInput,
  type HookOutput,
  type HookExecutionResult,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { sanitizeStrings } from "../llm/sanitize-unicode.ts";
import { recordSideCall } from "../trace/side-call-sink.ts";
import { SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import { SIDE_CALL_TIMEOUT_REASON } from "../llm/errors.ts";

/** 默认超时 60 秒 */
const DEFAULT_TIMEOUT = 60_000;

/** 延迟 JSON 序列化：只在需要时序列化一次 */
export class LazyJsonInput {
  private _json: string | undefined;
  constructor(private input: HookInput) {}

  get json(): string {
    if (this._json === undefined) {
      this._json = JSON.stringify(this.input);
    }
    return this._json;
  }

  get raw(): HookInput {
    return this.input;
  }
}

/** 退出码常量（对齐 CC utils/hooks.ts：仅 2 阻塞，其余非零非阻塞告警） */
const EXIT_SUCCESS = 0;
/** 退出码 2 = 阻塞（stderr 反馈给模型）。其余非零 = 非阻塞告警（stderr 展示给用户，继续执行）。 */
const EXIT_BLOCKING = 2;

/** 需要从环境变量中过滤的敏感 key 模式 */
const SENSITIVE_ENV_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
];

/**
 * G6：agent hook 的真子代理执行器（由 app 层注入，携带 ProviderRegistry + 工具注册表）。
 * 返回结构化 { ok, reason }，runner 据此产出 block/allow 决策。
 * 未注入（无头/子代理/测试）时 executeAgentHook 回退单轮 LLM 调用（保持可用）。
 */
export type AgentHookExecutor = (params: {
  prompt: string;
  model?: string;
  tools?: string[];
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; reason?: string; transcript?: string }>;

export class HookRunner {
  /** G6：注入的真子代理执行器（app 层设置）。 */
  private agentHookExecutor?: AgentHookExecutor;

  /** G7：异步 hook 注册表（app/system 层注入，用于后台执行 + asyncRewake 回灌）。 */
  private asyncRegistry?: import("./async-registry.ts").AsyncHookRegistry;

  /** G6：由 app 层注入真子代理执行器（携带工具注册表 / ProviderRegistry）。 */
  setAgentHookExecutor(executor: AgentHookExecutor | undefined): void {
    this.agentHookExecutor = executor;
  }

  /** G7：注入异步 hook 注册表（由 HookSystem 构造时设置）。 */
  setAsyncRegistry(registry: import("./async-registry.ts").AsyncHookRegistry | undefined): void {
    this.asyncRegistry = registry;
  }

  /** 执行单个 hook */
  async executeHook(
    hookConfig: HookConfig,
    eventName: HookEventName,
    input: HookInput,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();

    try {
      switch (hookConfig.type) {
        case "runtime":
          return await this.executeRuntimeHook(hookConfig, eventName, input, startTime);
        case "url":
          return await this.executeUrlHook(hookConfig, eventName, input, startTime);
        case "prompt":
          return await this.executePromptHook(hookConfig, eventName, input, startTime);
        case "agent":
          return await this.executeAgentHook(hookConfig, eventName, input, startTime);
        case "command":
        default:
          return await this.executeCommandHook(hookConfig, eventName, input, startTime);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const hookId = hookConfig.name || (hookConfig.type === "command" ? hookConfig.command : "") || "unknown";
      const log = getLogger();
      log.warn("HOOK", `Hook 执行异常 [${eventName}] (${hookId}): ${error}`);

      return {
        hookConfig,
        eventName,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration,
      };
    }
  }

  /** 并行执行多个 hook */
  async executeHooksParallel(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    onHookStart?: (config: HookConfig, index: number) => void,
    onHookEnd?: (config: HookConfig, result: HookExecutionResult) => void,
  ): Promise<HookExecutionResult[]> {
    const promises = hookConfigs.map(async (config, index) => {
      onHookStart?.(config, index);
      const result = await this.executeHook(config, eventName, input);
      onHookEnd?.(config, result);
      return result;
    });
    return Promise.all(promises);
  }

  /** AsyncGenerator 流式执行：任一 hook 完成立即 yield 结果 */
  async *executeHooksStreaming(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): AsyncGenerator<HookExecutionResult> {
    if (hookConfigs.length === 0) return;

    // 用 channel 模式：所有 promise 完成时 push 到队列
    const results: HookExecutionResult[] = [];
    let resolveNext: (() => void) | null = null;
    let remaining = hookConfigs.length;

    for (const config of hookConfigs) {
      if (signal?.aborted) return;
      this.executeHook(config, eventName, input).then(result => {
        results.push(result);
        remaining--;
        resolveNext?.();
      });
    }

    while (remaining > 0 || results.length > 0) {
      if (signal?.aborted) return;
      if (results.length > 0) {
        yield results.shift()!;
      } else {
        await new Promise<void>(r => { resolveNext = r; });
        resolveNext = null;
      }
    }
  }

  /** 串行执行多个 hook（链式传递：前一个输出修改后一个输入） */
  async executeHooksSequential(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    onHookStart?: (config: HookConfig, index: number) => void,
    onHookEnd?: (config: HookConfig, result: HookExecutionResult) => void,
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];
    let currentInput = input;

    for (let i = 0; i < hookConfigs.length; i++) {
      const config = hookConfigs[i];
      onHookStart?.(config, i);
      const result = await this.executeHook(config, eventName, currentInput);
      onHookEnd?.(config, result);
      results.push(result);

      // 链式传递：成功的输出修改下一个 hook 的输入
      if (result.success && result.output) {
        currentInput = this.applyHookOutputToInput(currentInput, result.output, eventName);
      }
    }

    return results;
  }

  // ============================================================
  // 私有：各类型执行
  // ============================================================

  /** 执行 command 类型 hook */
  private async executeCommandHook(
    hookConfig: CommandHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
  ): Promise<HookExecutionResult> {
    if (!hookConfig.command) {
      return {
        hookConfig, eventName, success: false,
        error: new Error("command hook 缺少 command 字段"),
        duration: Date.now() - startTime,
      };
    }

    const timeout = (hookConfig.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000;

    // 构建环境变量（清理敏感信息）
    const env: Record<string, string> = {
      ...this.sanitizeEnvironment(process.env as Record<string, string>),
      SID_CODE_HOOK_EVENT: eventName,
      SID_CODE_PROJECT_DIR: input.cwd,
      ...hookConfig.env,
    };

    // 注入事件专属环境变量
    this.injectEventEnvVars(env, input);

    // 展开命令中的变量
    const command = this.expandCommand(hookConfig.command, input);

    const lazyInput = new LazyJsonInput(input);

    const proc = spawn({
      cmd: ["sh", "-c", command],
      env,
      cwd: input.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // 写入 stdin（静默处理 EPIPE）
    try {
      proc.stdin.write(lazyInput.json);
      proc.stdin.end();
    } catch {
      // stdin 写入失败不影响执行
    }

    // G7：异步 hook——不阻塞主循环，立即返回，进程在后台跑完由 asyncRegistry 收集结果。
    // asyncRewake 模式下若后台进程 exit 2，其 stderr 会在下一轮循环开始时作为 system-reminder 回灌给模型。
    if (hookConfig.async === true && this.asyncRegistry) {
      const hookName = hookConfig.name ?? command.slice(0, 40);
      const asyncId = this.asyncRegistry.register(hookName);
      const registry = this.asyncRegistry;
      const supportsRewake = hookConfig.asyncRewake === true;

      // 后台等待进程结束 + 双阶段超时杀进程；结果写回 asyncRegistry（不 await）
      const bgTimeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* 进程可能已退出 */ }
        }, 5000);
      }, timeout);
      void (async () => {
        try {
          const exitCode = await proc.exited;
          const stderr = await new Response(proc.stderr).text();
          // 仅 asyncRewake=true 且 exit 2 才回灌（markCompleted 内部据 exitCode===2 入 rewake 队列）
          registry.markCompleted(asyncId, supportsRewake ? (exitCode ?? 0) : 0, stderr);
        } catch (e) {
          registry.markCompleted(asyncId, 0, String(e));
        } finally {
          clearTimeout(bgTimeoutId);
        }
      })();

      // 立即返回 success（异步 hook 不参与本轮阻塞决策）
      return {
        hookConfig, eventName,
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        duration: Date.now() - startTime,
        async: true,
      };
    }

    // 双阶段超时杀进程：SIGTERM → 5s → SIGKILL
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* 进程可能已退出 */ }
      }, 5000);
    }, timeout);

    try {
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const duration = Date.now() - startTime;

      if (timedOut) {
        return {
          hookConfig, eventName, success: false,
          error: new Error(`Hook 超时 (${timeout / 1000}s)`),
          stdout, stderr, duration,
        };
      }

      // 解析输出
      const output = this.parseCommandOutput(stdout, stderr, exitCode ?? 0);

      return {
        hookConfig, eventName,
        success: exitCode === EXIT_SUCCESS,
        output,
        stdout, stderr,
        exitCode: exitCode ?? 0,
        duration,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** 执行 url 类型 hook */
  private async executeUrlHook(
    hookConfig: UrlHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
  ): Promise<HookExecutionResult> {
    if (!hookConfig.url) {
      return {
        hookConfig, eventName, success: false,
        error: new Error("url hook 缺少 url 字段"),
        duration: Date.now() - startTime,
      };
    }

    const timeout = (hookConfig.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000;
    const method = hookConfig.method || "POST";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(hookConfig.url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(hookConfig.headers || {}),
        },
        body: JSON.stringify(sanitizeStrings(input)),
        signal: controller.signal,
      });

      const text = await response.text();
      const duration = Date.now() - startTime;

      if (!response.ok) {
        return {
          hookConfig, eventName,
          success: false,
          output: { decision: "deny", reason: `HTTP ${response.status}: ${text.slice(0, 200)}` },
          stdout: text,
          duration,
        };
      }

      const output = this.parseJsonOutput(text);
      return {
        hookConfig, eventName,
        success: true,
        output,
        stdout: text,
        duration,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      if (err.name === "AbortError") {
        return {
          hookConfig, eventName, success: false,
          error: new Error(`URL Hook 超时 (${timeout / 1000}s)`),
          duration,
        };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** 执行 runtime 类型 hook */
  private async executeRuntimeHook(
    hookConfig: RuntimeHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
  ): Promise<HookExecutionResult> {
    const timeout = hookConfig.timeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => {
            // 立即 abort:让 action 内部尽早收到取消信号释放资源(网络/子进程),
            // 而非等到 catch 才 abort —— 缩短孤儿 action 的存活窗口。
            controller.abort();
            reject(new Error(`Runtime hook 超时 (${timeout}ms)`));
          },
          timeout,
        );
      });

      const result = await Promise.race([
        hookConfig.action(input, { signal: controller.signal }),
        timeoutPromise,
      ]);

      return {
        hookConfig, eventName,
        success: true,
        output: result === null || result === undefined ? undefined : result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      controller.abort();
      return {
        hookConfig, eventName,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // 兜底:无论正常/异常退出都 abort,确保孤儿 action(如超时后仍运行的 Promise)
      // 收到取消信号 —— abort 幂等,已 abort 再调无副作用。
      if (!controller.signal.aborted) controller.abort();
    }
  }

  // ============================================================
  // 私有：输出解析
  // ============================================================

  /** 解析 command hook 输出（退出码语义：0=成功, 1=警告, 2+=阻塞） */
  private parseCommandOutput(stdout: string, stderr: string, exitCode: number): HookOutput {
    // JSON 输出优先（无论退出码）：结构化 decision 覆盖退出码语义。
    // stdout 优先解析（CC 约定 JSON 走 stdout），stdout 非 JSON 时再尝试 stderr。
    const stdoutText = stdout.trim();
    const stderrText = stderr.trim();
    const jsonOutput = this.parseJsonOutput(stdoutText) ?? this.parseJsonOutput(stderrText);
    if (jsonOutput) return jsonOutput;

    // 非 JSON：按 CC 退出码语义转换（仅 2 阻塞，其余非零非阻塞告警）。
    if (exitCode === EXIT_SUCCESS) {
      // 0：成功。stdout 作为 systemMessage（透明反馈，某些事件如 UserPromptSubmit/SessionStart
      // 会把它注入上下文；由事件层决定，这里只承载文本）。
      return { decision: "allow", systemMessage: stdoutText || undefined };
    } else if (exitCode === EXIT_BLOCKING) {
      // 2：阻塞。stderr 优先反馈给模型（CC 约定 exit 2 的原因写在 stderr）。
      return { decision: "deny", reason: stderrText || stdoutText || `Hook 退出码 ${exitCode}` };
    } else {
      // 其余非零（1/3/…）：非阻塞告警。stderr 展示给用户，继续执行（不 deny，对齐 CC）。
      return { decision: "allow", systemMessage: stderrText ? `警告: ${stderrText}` : (stdoutText || undefined) };
    }
  }

  /** 尝试解析 JSON 输出 */
  private parseJsonOutput(text: string): HookOutput | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;

    try {
      let parsed = JSON.parse(trimmed);
      // 双重 JSON 字符串
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
      if (parsed && typeof parsed === "object") {
        return parsed as HookOutput;
      }
    } catch {
      // 非 JSON
    }
    return undefined;
  }

  // ============================================================
  // 私有：环境变量 & 命令展开
  // ============================================================

  /** 清理环境变量（过滤敏感信息） */
  private sanitizeEnvironment(env: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      const isSensitive = SENSITIVE_ENV_PATTERNS.some(p => p.test(key));
      if (!isSensitive) {
        result[key] = value;
      }
    }
    return result;
  }

  /** 注入事件专属环境变量 */
  private injectEventEnvVars(env: Record<string, string>, input: HookInput): void {
    if ("tool_name" in input) {
      env.SID_CODE_TOOL_NAME = (input as any).tool_name;
    }
    if ("tool_input" in input) {
      env.SID_CODE_TOOL_INPUT = JSON.stringify((input as any).tool_input);
    }
    if ("tool_response" in input) {
      env.SID_CODE_TOOL_OUTPUT = JSON.stringify((input as any).tool_response);
    }
    if ("is_error" in input) {
      env.SID_CODE_TOOL_IS_ERROR = String((input as any).is_error);
    }
    if ("tool_use_id" in input && (input as any).tool_use_id) {
      env.SID_CODE_TOOL_USE_ID = (input as any).tool_use_id;
    }
    if ("prompt" in input) {
      env.SID_CODE_USER_INPUT = (input as any).prompt;
    }
    if (input.session_id) {
      env.SID_CODE_SESSION_ID = input.session_id;
    }
    // AfterModel / SessionStart: 模型名称
    if ("llm_request" in input && (input as any).llm_request?.model) {
      env.SID_CODE_MODEL = (input as any).llm_request.model;
    } else if ("model" in input && (input as any).model) {
      env.SID_CODE_MODEL = (input as any).model;
    }
    // AfterModel: stop_reason
    if ("llm_response" in input && (input as any).llm_response?.stop_reason) {
      env.SID_CODE_STOP_REASON = (input as any).llm_response.stop_reason;
    }
    // SubagentStart: agent_id / agent_type
    if ("agent_id" in input) {
      env.SID_CODE_AGENT_ID = (input as any).agent_id;
    }
    if ("agent_type" in input) {
      env.SID_CODE_AGENT_TYPE = (input as any).agent_type;
    }
  }

  /** 展开命令中的变量 */
  private expandCommand(command: string, input: HookInput): string {
    return command
      .replace(/\$SID_CODE_PROJECT_DIR/g, input.cwd)
      .replace(/\$SID_CODE_CWD/g, input.cwd);
  }

  /** 串行链式传递：将 hook 输出应用到下一个 hook 的输入 */
  private applyHookOutputToInput(
    originalInput: HookInput,
    hookOutput: HookOutput,
    eventName: HookEventName,
  ): HookInput {
    const modified = { ...originalInput };

    if (!hookOutput.hookSpecificOutput) return modified;

    switch (eventName) {
      case HookEventName.UserPromptSubmit:
        if ("additionalContext" in hookOutput.hookSpecificOutput) {
          const ctx = hookOutput.hookSpecificOutput["additionalContext"];
          if (typeof ctx === "string" && "prompt" in modified) {
            (modified as any).prompt += "\n\n" + ctx;
          }
        }
        break;

      case HookEventName.PreToolUse: {
        const so = hookOutput.hookSpecificOutput;
        // G1：updatedInput 优先，整体替换（对齐 CC 语义）
        if ("updatedInput" in so && so["updatedInput"] && typeof so["updatedInput"] === "object" && "tool_input" in modified) {
          (modified as any).tool_input = so["updatedInput"];
        } else if ("tool_input" in so && so["tool_input"] && typeof so["tool_input"] === "object" && "tool_input" in modified) {
          // 旧格式兼容：浅合并保留其他字段
          (modified as any).tool_input = {
            ...(modified as any).tool_input,
            ...(so["tool_input"] as Record<string, unknown>),
          };
        }
        break;
      }

      case HookEventName.BeforeModel:
        if ("llm_request" in hookOutput.hookSpecificOutput) {
          const req = hookOutput.hookSpecificOutput["llm_request"];
          if (req && typeof req === "object" && "llm_request" in modified) {
            (modified as any).llm_request = {
              ...(modified as any).llm_request,
              ...(req as Record<string, unknown>),
            };
          }
        }
        break;

      default:
        break;
    }

    return modified;
  }

  // ============================================================
  // Prompt Hook 执行器（LLM 验证）
  // ============================================================

  private async executePromptHook(
    hookConfig: PromptHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
  ): Promise<HookExecutionResult> {
    const log = getLogger();
    const timeout = (hookConfig.timeout ?? 30) * 1000;

    try {
      const jsonInput = JSON.stringify(input);
      const processedPrompt = hookConfig.prompt.replace(/\$ARGUMENTS/g, jsonInput);

      // 动态导入避免循环依赖
      const { ProviderRegistry } = await import("../llm/registry.ts");
      const { loadConfig } = await import("../config/config.ts");
      const config = await loadConfig();
      const registry = new ProviderRegistry(config);
      const provider = registry.getProvider();
      const model = hookConfig.model ?? config.model;

      const controller = new AbortController();
      // H10：超时用带 reason 的 abort，与主路径 reason 白名单口径统一（详见 errors.ts）。
      const timeoutId = setTimeout(() => controller.abort(SIDE_CALL_TIMEOUT_REASON), timeout);

      try {
        const text = await this.collectStreamResponse(provider, {
          model,
          messages: [{ role: "user", content: [{ type: "text", text: processedPrompt }] }],
          system: "你是一个 Hook 验证器，负责评估 AI 编程助手的操作是否合理。\n你的响应必须是一个 JSON 对象：\n- 如果操作合理：{\"ok\": true}\n- 如果操作不合理：{\"ok\": false, \"reason\": \"具体原因\"}\n只返回 JSON，不要包含其他内容。",
          maxTokens: 1024,
          // H5：Agent Hook 验证器是「出个 {ok,reason} JSON」的分类任务，关思考。
          thinking: SIDE_CALL_NO_THINK,
        }, controller.signal);

        const parsed = this.parseJsonOutput(text);

        if (parsed && (parsed as any).ok === false) {
          return {
            hookConfig, eventName, success: true,
            output: { decision: "block", reason: (parsed as any).reason ?? "Prompt Hook 拒绝" },
            duration: Date.now() - startTime,
          };
        }

        return {
          hookConfig, eventName, success: true,
          output: { decision: "allow" },
          duration: Date.now() - startTime,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      log.warn("HOOK", `Prompt Hook 执行失败: ${error}`);
      return {
        hookConfig, eventName, success: true,
        output: { decision: "allow" },
        duration: Date.now() - startTime,
      };
    }
  }

  // ============================================================
  // Agent Hook 执行器（多轮 Agent 验证）
  // ============================================================

  private async executeAgentHook(
    hookConfig: AgentHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
  ): Promise<HookExecutionResult> {
    const log = getLogger();
    const timeout = (hookConfig.timeout ?? 60) * 1000;

    const jsonInput = JSON.stringify(input);
    const processedPrompt = hookConfig.prompt.replace(/\$ARGUMENTS/g, jsonInput);

    // G6：优先走注入的真子代理执行器（可多轮、可用 read/grep/glob 等工具验证）。
    if (this.agentHookExecutor) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(SIDE_CALL_TIMEOUT_REASON), timeout);
      try {
        const res = await this.agentHookExecutor({
          prompt: processedPrompt,
          model: hookConfig.model,
          tools: hookConfig.tools,
          timeoutMs: timeout,
          signal: controller.signal,
        });
        if (res.ok === false) {
          return {
            hookConfig, eventName, success: true,
            output: {
              decision: "block",
              reason: res.reason ?? "Agent Hook 验证失败",
              hookSpecificOutput: res.transcript ? { additionalContext: res.transcript } : undefined,
            },
            duration: Date.now() - startTime,
          };
        }
        return {
          hookConfig, eventName, success: true,
          output: { decision: "allow" },
          duration: Date.now() - startTime,
        };
      } catch (error) {
        // 真子代理失败：不阻断主流程（放行），记录告警（与下方单轮回退的失败语义一致）。
        log.warn("HOOK", `Agent Hook 子代理执行失败: ${error}`);
        return {
          hookConfig, eventName, success: true,
          output: { decision: "allow" },
          duration: Date.now() - startTime,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // 回退：未注入子代理执行器（无头/测试）→ 单轮 LLM 验证（保持原可用性）。
    try {
      const { ProviderRegistry } = await import("../llm/registry.ts");
      const { loadConfig } = await import("../config/config.ts");
      const config = await loadConfig();
      const registry = new ProviderRegistry(config);
      const provider = registry.getProvider();
      const model = hookConfig.model ?? config.model;

      const controller = new AbortController();
      // H10：超时用带 reason 的 abort，与主路径 reason 白名单口径统一（详见 errors.ts）。
      const timeoutId = setTimeout(() => controller.abort(SIDE_CALL_TIMEOUT_REASON), timeout);

      try {
        const text = await this.collectStreamResponse(provider, {
          model,
          messages: [{ role: "user", content: [{ type: "text", text: processedPrompt }] }],
          system: "你是一个 Agent Hook 验证器。你的任务是验证 AI 编程助手的操作结果是否正确。\n分析完成后，返回一个 JSON 对象：\n- 如果验证通过：{\"ok\": true}\n- 如果验证失败：{\"ok\": false, \"reason\": \"失败原因和修复建议\"}\n只返回 JSON，不要包含其他内容。",
          maxTokens: 2048,
          // H5：Agent Hook 验证器是「出个 {ok,reason} JSON」的分类任务，关思考。
          thinking: SIDE_CALL_NO_THINK,
        }, controller.signal);

        const parsed = this.parseJsonOutput(text);

        if (parsed && (parsed as any).ok === false) {
          return {
            hookConfig, eventName, success: true,
            output: {
              decision: "block",
              reason: (parsed as any).reason ?? "Agent Hook 验证失败",
              hookSpecificOutput: { additionalContext: text },
            },
            duration: Date.now() - startTime,
          };
        }

        return {
          hookConfig, eventName, success: true,
          output: { decision: "allow" },
          duration: Date.now() - startTime,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      log.warn("HOOK", `Agent Hook 执行失败: ${error}`);
      return {
        hookConfig, eventName, success: true,
        output: { decision: "allow" },
        duration: Date.now() - startTime,
      };
    }
  }

  // ============================================================
  // 辅助：收集流式响应为文本
  // ============================================================

  private async collectStreamResponse(
    provider: any,
    params: any,
    signal?: AbortSignal,
  ): Promise<string> {
    let text = "";
    let streamUsage: any = null;
    for await (const event of provider.sendMessageStream(params, signal)) {
      // 纵深防御:hook-runner side-call 检查 signal,防止 provider 层超时失效时挂死
      // H10：抛出携带 abort reason 的错误，与主路径 reason 白名单口径一致。
      if (signal?.aborted) {
        throw new Error(String((signal as any).reason ?? SIDE_CALL_TIMEOUT_REASON));
      }
      if (event.type === "content_block_delta" && "text" in event.delta) {
        text += event.delta.text;
      } else if (event.type === "message_stop" && event.usage) {
        streamUsage = event.usage;
      }
    }
    // 记录辅助调用用量
    if (streamUsage) {
      recordSideCall({
        label: "hook-runner",
        model: params.model ?? "",
        inputTokens: streamUsage.inputTokens ?? 0,
        outputTokens: streamUsage.outputTokens ?? 0,
        cacheReadTokens: streamUsage.cacheReadInputTokens ?? 0,
        cacheCreationTokens: streamUsage.cacheCreationInputTokens ?? 0,
        durationMs: 0,
      });
    }
    return text;
  }
}
