/**
 * Hook 执行器
 * 在工具调用前后执行配置的 shell 命令
 */

import type { HookConfig } from "../config/config.ts";
import { spawn } from "bun";

/** Hook 事件类型 */
export type HookEvent = "pre_tool_use" | "post_tool_use";

/** Hook 执行上下文 */
export interface HookContext {
  toolName: string;
  toolInput: unknown;
  toolOutput?: string;
  isError?: boolean;
}

export class HookRunner {
  private hooks: HookConfig[];

  constructor(hooks: HookConfig[]) {
    this.hooks = hooks;
  }

  /** 执行指定事件的所有 Hook */
  async run(event: HookEvent, ctx: HookContext): Promise<void> {
    const matchingHooks = this.hooks.filter((h) => h.event === event);

    for (const hook of matchingHooks) {
      try {
        await this.executeHook(hook, ctx);
      } catch (err: any) {
        console.error(`[Hook 错误] ${hook.command}: ${err.message}`);
      }
    }
  }

  /** 执行单个 Hook */
  private async executeHook(hook: HookConfig, ctx: HookContext): Promise<void> {
    const timeout = (hook.timeout || 30) * 1000;

    // 设置环境变量
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SID_CODE_TOOL_NAME: ctx.toolName,
      SID_CODE_TOOL_INPUT: JSON.stringify(ctx.toolInput),
    };

    if (ctx.toolOutput !== undefined) {
      env.SID_CODE_TOOL_OUTPUT = ctx.toolOutput;
    }
    if (ctx.isError !== undefined) {
      env.SID_CODE_TOOL_IS_ERROR = String(ctx.isError);
    }

    const proc = spawn({
      cmd: ["sh", "-c", hook.command],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
    }, timeout);

    try {
      await proc.exited;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
