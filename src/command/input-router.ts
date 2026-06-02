/**
 * 输入路由器
 *
 * 当用户提交输入时，决定如何处理：
 * 1. 检测 immediate 斜杠命令（模型运行时）→ 即时执行（不入队）
 * 2. 模型运行中 → 入队等待
 * 3. 模型空闲 → 直接执行
 */

import type { UnifiedCommand } from "./types.ts";
import type { CommandQueue } from "./queue.ts";
import type { CommandExecutor } from "./executor.ts";
import { parseSlashCommand } from "./parser.ts";

export interface InputRouterDeps {
  queue: CommandQueue;
  executor: CommandExecutor;
  /** 直接执行用户输入（模型空闲时），由应用层提供 */
  runInput: (input: string) => Promise<void>;
  /** 处理 immediate 命令的执行结果 */
  onImmediateResult?: (
    result: import("./types.ts").CommandExecutionResult,
  ) => void;
}

export class InputRouter {
  constructor(private deps: InputRouterDeps) {}

  /**
   * 处理一条用户输入
   * @returns "immediate" | "enqueued" | "executed"
   */
  async handleInput(
    input: string,
    isModelActive: boolean,
    commands: UnifiedCommand[],
  ): Promise<"immediate" | "enqueued" | "executed"> {
    // Step 1: 模型运行时，检测 immediate 斜杠命令
    if (isModelActive && input.trim().startsWith("/")) {
      const parsed = parseSlashCommand(input);
      if (parsed) {
        const cmd = this.deps.executor.findCommand(parsed.commandName, commands);
        if (cmd?.immediate && cmd.userInvocable !== false) {
          const result = await this.deps.executor.executeImmediate(
            cmd,
            parsed.args,
          );
          this.deps.onImmediateResult?.(result);
          return "immediate";
        }
      }
    }

    // Step 2: 模型运行中 → 入队
    if (isModelActive) {
      this.deps.queue.enqueue({
        value: input,
        mode: this.detectMode(input),
      });
      return "enqueued";
    }

    // Step 3: 模型空闲 → 直接执行
    await this.deps.runInput(input);
    return "executed";
  }

  detectMode(input: string): "prompt" | "bash" | "slash" {
    const t = input.trimStart();
    if (t.startsWith("/")) return "slash";
    if (t.startsWith("!")) return "bash";
    return "prompt";
  }
}
