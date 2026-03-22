/**
 * Hook 执行引擎
 * 支持 command/url/runtime 三种类型、并行/串行执行、双阶段杀进程、退出码语义、环境变量清理
 */

import { spawn } from "bun";
import {
  HookEventName,
  HookType,
  type HookConfig,
  type CommandHookConfig,
  type UrlHookConfig,
  type RuntimeHookConfig,
  type HookInput,
  type HookOutput,
  type HookExecutionResult,
  type BeforeModelInput,
  type PreToolUseInput,
  type UserPromptSubmitInput,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 默认超时 60 秒 */
const DEFAULT_TIMEOUT = 60_000;

/** 退出码常量 */
const EXIT_SUCCESS = 0;
const EXIT_WARNING = 1;
// 2+ = 阻塞

/** 需要从环境变量中过滤的敏感 key 模式 */
const SENSITIVE_ENV_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
];

export class HookRunner {
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

    const stdinData = JSON.stringify(input);

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
      proc.stdin.write(stdinData);
      proc.stdin.end();
    } catch {
      // stdin 写入失败不影响执行
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
        body: JSON.stringify(input),
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
          () => reject(new Error(`Runtime hook 超时 (${timeout}ms)`)),
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
    }
  }

  // ============================================================
  // 私有：输出解析
  // ============================================================

  /** 解析 command hook 输出（退出码语义：0=成功, 1=警告, 2+=阻塞） */
  private parseCommandOutput(stdout: string, stderr: string, exitCode: number): HookOutput {
    const textToParse = stdout.trim() || stderr.trim();

    if (textToParse) {
      const jsonOutput = this.parseJsonOutput(textToParse);
      if (jsonOutput) return jsonOutput;
    }

    // 非 JSON，根据退出码转换
    if (exitCode === EXIT_SUCCESS) {
      return { decision: "allow", systemMessage: textToParse || undefined };
    } else if (exitCode === EXIT_WARNING) {
      return { decision: "allow", systemMessage: textToParse ? `警告: ${textToParse}` : undefined };
    } else {
      // 2+ = 阻塞
      return { decision: "deny", reason: textToParse || `Hook 退出码 ${exitCode}` };
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
    if ("prompt" in input) {
      env.SID_CODE_USER_INPUT = (input as any).prompt;
    }
    if (input.session_id) {
      env.SID_CODE_SESSION_ID = input.session_id;
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

      case HookEventName.PreToolUse:
        if ("tool_input" in hookOutput.hookSpecificOutput) {
          const newInput = hookOutput.hookSpecificOutput["tool_input"];
          if (newInput && typeof newInput === "object" && "tool_input" in modified) {
            (modified as any).tool_input = {
              ...(modified as any).tool_input,
              ...(newInput as Record<string, unknown>),
            };
          }
        }
        break;

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
}
