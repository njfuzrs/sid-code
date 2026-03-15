/**
 * Hook 执行器
 * 支持 command/url 两种钩子类型、blocking 机制、matcher 匹配、stdin JSON 传递、返回值解析
 */

import type { HookConfig, HooksConfig } from "../config/config.ts";
import { spawn } from "bun";
import { getLogger } from "../debug/logger.ts";

/** Hook 事件类型（10 种） */
export type HookEvent =
  | "pre_tool_use"           // 工具执行前（可阻止）
  | "post_tool_use"          // 工具执行后
  | "post_tool_use_failure"  // 工具执行失败后
  | "permission_request"     // 权限请求时
  | "user_prompt_submit"     // 用户提交输入时（可拦截/修改）
  | "session_start"          // 会话开始
  | "session_end"            // 会话结束
  | "pre_compact"            // 上下文压缩前（可阻止）
  | "subagent_stop"          // 子代理停止
  | "notification";          // 通知事件

/** Hook 执行上下文 */
export interface HookContext {
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  isError?: boolean;
  userInput?: string;
  permissionRequest?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** Hook 执行结果 */
export interface HookResult {
  success: boolean;
  blocked?: boolean;
  reason?: string;
  output?: string;
  modifiedInput?: string;
}

export class HookRunner {
  private hooks: HooksConfig;

  constructor(hooks: HooksConfig) {
    this.hooks = hooks;
  }

  /** 执行指定事件的所有 Hook，返回结果数组 */
  async run(event: HookEvent, ctx: HookContext): Promise<HookResult[]> {
    const hookList = this.hooks[event];
    if (!hookList || hookList.length === 0) return [];

    const log = getLogger();
    const results: HookResult[] = [];

    for (const hook of hookList) {
      // matcher 匹配检查
      if (!this.matchesHook(hook, ctx)) continue;

      try {
        const type = hook.type || "command";
        let result: HookResult;

        if (type === "url") {
          result = await this.executeUrlHook(hook, event, ctx);
        } else {
          result = await this.executeCommandHook(hook, event, ctx);
        }

        results.push(result);

        // blocking 链：遇到 blocked 立即停止后续 hook
        if (hook.blocking && result.blocked) {
          log.info("HOOK", `Hook 阻止了 ${event}: ${result.reason || "无原因"}`);
          break;
        }
      } catch (err: any) {
        log.error("HOOK", `Hook 执行失败 [${event}]: ${err.message}`);
        // 错误隔离：单个 hook 失败不影响其他
        results.push({ success: false, output: err.message });
      }
    }

    return results;
  }

  /** 检查 hook 的 matcher 是否匹配当前上下文 */
  private matchesHook(hook: HookConfig, ctx: HookContext): boolean {
    if (!hook.matcher) return true; // 无 matcher 通配
    if (!ctx.toolName) return true; // 无工具名时通配

    const matcher = hook.matcher;

    // 正则匹配：/pattern/
    if (matcher.startsWith("/") && matcher.endsWith("/") && matcher.length > 2) {
      try {
        const regex = new RegExp(matcher.slice(1, -1));
        return regex.test(ctx.toolName);
      } catch {
        return false;
      }
    }

    // 精确匹配（不区分大小写）
    return ctx.toolName.toLowerCase() === matcher.toLowerCase();
  }

  /** 执行 command 类型 Hook */
  private async executeCommandHook(
    hook: HookConfig,
    event: HookEvent,
    ctx: HookContext,
  ): Promise<HookResult> {
    if (!hook.command) {
      return { success: false, output: "缺少 command 字段" };
    }

    const timeout = (hook.timeout || 30) * 1000;

    // 环境变量
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SID_CODE_HOOK_EVENT: event,
    };

    if (ctx.toolName) env.SID_CODE_TOOL_NAME = ctx.toolName;
    if (ctx.toolInput !== undefined) env.SID_CODE_TOOL_INPUT = JSON.stringify(ctx.toolInput);
    if (ctx.toolOutput !== undefined) env.SID_CODE_TOOL_OUTPUT = ctx.toolOutput;
    if (ctx.isError !== undefined) env.SID_CODE_TOOL_IS_ERROR = String(ctx.isError);
    if (ctx.sessionId) env.SID_CODE_SESSION_ID = ctx.sessionId;
    if (ctx.userInput) env.SID_CODE_USER_INPUT = ctx.userInput;
    if (ctx.error) env.SID_CODE_ERROR = ctx.error;

    // 通过 stdin 传完整 JSON
    const stdinData = JSON.stringify({ event, ...ctx });

    const proc = spawn({
      cmd: ["sh", "-c", hook.command],
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // 写入 stdin
    try {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    } catch {
      // stdin 写入失败不影响执行
    }

    const timeoutId = setTimeout(() => {
      proc.kill();
    }, timeout);

    try {
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      // 解析 stdout JSON 返回值
      const result = this.parseHookOutput(stdout, hook.blocking || false);

      // 非零退出码 + blocking = 阻止
      if (hook.blocking && exitCode !== 0) {
        return {
          success: false,
          blocked: true,
          reason: stderr.trim() || stdout.trim() || `Hook 退出码 ${exitCode}`,
          output: stdout,
        };
      }

      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** 执行 url 类型 Hook */
  private async executeUrlHook(
    hook: HookConfig,
    event: HookEvent,
    ctx: HookContext,
  ): Promise<HookResult> {
    if (!hook.url) {
      return { success: false, output: "缺少 url 字段" };
    }

    const timeout = (hook.timeout || 30) * 1000;
    const method = hook.method || "POST";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(hook.url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(hook.headers || {}),
        },
        body: JSON.stringify({ event, ...ctx }),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        if (hook.blocking) {
          return {
            success: false,
            blocked: true,
            reason: `HTTP ${response.status}: ${text.slice(0, 200)}`,
            output: text,
          };
        }
        return { success: false, output: text };
      }

      return this.parseHookOutput(text, hook.blocking || false);
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { success: false, output: `URL Hook 超时 (${hook.timeout || 30}s)` };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** 解析 hook 输出（尝试 JSON，否则纯文本） */
  private parseHookOutput(output: string, isBlocking: boolean): HookResult {
    const trimmed = output.trim();
    if (!trimmed) {
      return { success: true, output: "" };
    }

    try {
      const parsed = JSON.parse(trimmed);
      return {
        success: parsed.success !== false,
        blocked: isBlocking ? (parsed.blocked === true) : undefined,
        reason: parsed.reason || parsed.message,
        output: trimmed,
        modifiedInput: parsed.modifiedInput,
      };
    } catch {
      // 非 JSON，作为纯文本
      return { success: true, output: trimmed };
    }
  }
}
