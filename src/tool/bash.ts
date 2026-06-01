/**
 * Bash 工具 - 执行 shell 命令
 * 对标 Claude Code：description 参数、输出截断、AbortSignal 集成、跨平台适配
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult, PermissionResult, ToolUseContext } from "./types.ts";
import { spawn } from "bun";
import { platform } from "os";
import { getLogger } from "../debug/logger.ts";
import type { Config } from "../config/config.ts";
import { isReadOnlyCommand, isDestructiveCommand } from "./bash/read-only-validation.ts";

/** Bash 输出截断阈值（对标 Claude Code 30000 字符） */
const MAX_OUTPUT_LENGTH = 30000;

/** 后台进程延迟时间（200ms 后切换到后台） */
const BACKGROUND_DELAY_MS = 200;

/** 后台进程 PID 跟踪 */
const backgroundPids = new Set<number>();

/** 全局配置（用于环境变量清理） */
let globalConfig: Config | null = null;

/** 设置全局配置 */
export function setBashToolConfig(config: Config): void {
  globalConfig = config;
}

/** 获取平台 shell 配置 */
function getPlatformShell(): { shell: string; args: string[] } {
  if (platform() === "win32") {
    return { shell: "powershell.exe", args: ["-NoProfile", "-Command"] };
  }
  const userShell = process.env.SHELL || "/bin/bash";
  return { shell: userShell, args: ["-c"] };
}

/** 截断超长输出 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output;

  const head = output.slice(0, MAX_OUTPUT_LENGTH / 2);
  const tail = output.slice(-MAX_OUTPUT_LENGTH / 4);
  const omitted = output.length - head.length - tail.length;

  return `${head}\n\n... [输出已截断: 省略了中间 ${omitted} 字符，共 ${output.length} 字符] ...\n\n${tail}`;
}

/** 检测二进制输出 */
function isBinaryOutput(data: string): boolean {
  if (data.length === 0) return false;

  // 检查是否包含 null 字节
  if (data.includes("\0")) return true;

  // 检查不可打印字符比例
  let nonPrintable = 0;
  const sampleSize = Math.min(data.length, 1000);

  for (let i = 0; i < sampleSize; i++) {
    const code = data.charCodeAt(i);
    // 不可打印字符（排除常见空白字符）
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
  }

  // 如果超过 30% 是不可打印字符，视为二进制
  return nonPrintable / sampleSize > 0.3;
}

export class BashTool implements Tool {
  name(): string {
    return "bash";
  }

  description(): string {
    return "执行 shell 命令。必须提供 description 参数用人话说明命令意图。支持超时控制和工作目录设置。";
  }

  usageGuide(): string {
    return `- 仅用于需要 shell 执行的系统命令，文件操作请用专用工具
- 不要用 bash 执行 cat/head/tail（用 read）、echo/cat 写文件（用 write）、sed/awk（用 edit）、find（用 glob）、grep（用 grep 工具）
- 必须提供 description 参数，用自然语言描述命令意图
- 设置合理的 timeout，默认 2 分钟，最长 10 分钟
- 输出超过 30000 字符会被自动截断
- 长时间运行的进程（如 dev server）可设置 is_background=true 后台运行
- 后台进程会返回 PID，可用于后续管理`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令",
        },
        description: {
          type: "string",
          description: "用自然语言描述这条命令要做什么（会显示给用户审批）",
        },
        timeout: {
          type: "number",
          description: "超时时间（毫秒），默认 120000（2 分钟），最长 600000（10 分钟）",
        },
        cwd: {
          type: "string",
          description: "工作目录，默认为当前目录",
        },
        is_background: {
          type: "boolean",
          description: "是否后台运行（不等待命令完成，立即返回 PID）",
        },
        run_in_background: {
          type: "boolean",
          description: "是否以后台任务模式运行（通过 Task 系统管理，完成后通知）",
        },
      },
      required: ["command"],
    };
  }

  /** 基于命令内容判断是否只读（输入感知） */
  readOnly(): boolean {
    return false; // 默认非只读，实际判断在 isConcurrencySafe 中
  }

  /** 工具级权限检查：只读命令直接放行，破坏性命令要求确认，其余 passthrough */
  async checkPermissions(input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    const command = (input as any)?.command;
    if (!command || typeof command !== "string") {
      return { behavior: "passthrough" };
    }
    if (isReadOnlyCommand(command)) {
      return { behavior: "allow" };
    }
    if (isDestructiveCommand(command)) {
      return { behavior: "ask", message: `破坏性命令需要确认: ${command.slice(0, 80)}` };
    }
    return { behavior: "passthrough" };
  }

  /** 基于命令内容判断是否并发安全（输入感知） */
  isConcurrencySafe(input: unknown): boolean {
    const command = (input as any)?.command;
    if (!command || typeof command !== "string") return false;
    return isReadOnlyCommand(command);
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      command: string;
      description?: string;
      timeout?: number;
      cwd?: string;
      is_background?: boolean;
      run_in_background?: boolean;
    };

    if (!params.command) {
      return { output: "错误: 缺少 command 参数", isError: true };
    }

    log.info("TOOL", `▶ 执行: ${params.command.slice(0, 200)}${params.command.length > 200 ? "..." : ""}`);

    // Task 系统后台模式（新）
    if (params.run_in_background) {
      return this.executeWithTaskSystem(params, signal);
    }

    // 旧后台模式（兼容）
    if (params.is_background) {
      return this.executeBackground(params);
    }

    // 超时限制：最短 1 秒，最长 10 分钟
    const timeout = Math.min(Math.max(params.timeout || 120000, 1000), 600000);
    const cwd = params.cwd || process.cwd();
    const { shell, args } = getPlatformShell();

    // 准备环境变量（如果启用了清理）
    let env = process.env;
    if (globalConfig && (globalConfig as any).sanitizeEnv) {
      const { sanitizeEnv } = await import("../config/env-sanitizer.ts");
      env = sanitizeEnv(process.env as Record<string, string>);
      log.debug("BASH", `环境变量已清理，保留 ${Object.keys(env).length} 个变量`);
    }

    try {
      const proc = spawn({
        cmd: [shell, ...args, params.command],
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      // 超时控制 + AbortSignal 集成
      let killed = false;
      let killReason = "";
      let backgrounded = false;

      const timeoutId = setTimeout(() => {
        // 超时自动后台化：不终止进程，而是转为后台任务
        backgrounded = true;
        killReason = `命令超时（${timeout / 1000}秒），已自动转为后台运行`;
        const pid = proc.pid;
        if (pid) backgroundPids.add(pid);
        log.info("BASH", `命令超时，PID ${pid} 自动转为后台运行`);
      }, timeout);

      // AbortSignal 监听
      const abortHandler = () => {
        killed = true;
        killReason = "用户取消";
        proc.kill();
      };
      signal?.addEventListener("abort", abortHandler);

      // 使用 Promise.race 实现超时后台化：超时时立即返回，进程继续后台运行
      const outputPromise = (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);

        const exitCode = await proc.exited;

        // 合并输出
        let output = "";
        if (stdout) output += stdout;
        if (stderr) {
          if (output && !output.endsWith("\n")) output += "\n";
          if (stderr) output += stderr;
        }
        if (!output) output = "(命令无输出)";

        // 二进制输出检测
        if (isBinaryOutput(output)) {
          const byteCount = new TextEncoder().encode(output).length;
          output = `[检测到二进制输出，共 ${byteCount} 字节]`;
        } else {
          output = truncateOutput(output);
        }

        if (killed) {
          return {
            output: `${killReason}，已终止命令。\n部分输出:\n${output}`,
            isError: true,
          };
        }

        if (exitCode !== 0) {
          log.info("TOOL", `✓ 命令完成 code=${exitCode} stdout=${stdout.length}字符 stderr=${stderr.length}字符`);
          return {
            output: `命令执行失败（退出码 ${exitCode}）:\n${output}`,
            isError: true,
          };
        }

        log.info("TOOL", `✓ 命令完成 code=0 stdout=${stdout.length}字符 stderr=${stderr.length}字符`);
        return { output };
      })();

      const timeoutPromise = new Promise<ToolResult | null>((resolve) => {
        setTimeout(() => {
          if (!killed && !backgrounded) {
            backgrounded = true;
            resolve(null); // 触发后台化
          }
        }, timeout);
      });

      // 正常完成 vs 超时后台化
      const raceResult = await Promise.race([
        outputPromise.then(r => ({ type: "done" as const, result: r })),
        timeoutPromise.then(() => ({ type: "timeout" as const, result: null })),
      ]);

      if (raceResult.type === "timeout") {
        const pid = proc.pid;
        if (pid) backgroundPids.add(pid);
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);
        log.info("BASH", `命令超时（${timeout / 1000}秒），PID ${pid} 自动转为后台运行`);
        return {
          output: `命令执行超过 ${timeout / 1000} 秒，已自动转为后台运行。PID: ${pid}\n可使用 \`kill ${pid}\` 终止进程。`,
          isError: false,
        };
      }

      return raceResult.result;
    } catch (err: any) {
      return { output: `执行命令失败: ${err.message}`, isError: true };
    }
  }

  /** 后台执行命令 */
  private async executeBackground(params: {
    command: string;
    cwd?: string;
  }): Promise<ToolResult> {
    const log = getLogger();
    const cwd = params.cwd || process.cwd();
    const { shell, args } = getPlatformShell();

    // 准备环境变量（如果启用了清理）
    let env = process.env;
    if (globalConfig && (globalConfig as any).sanitizeEnv) {
      const { sanitizeEnv } = await import("../config/env-sanitizer.ts");
      env = sanitizeEnv(process.env as Record<string, string>);
      log.debug("BASH", `环境变量已清理，保留 ${Object.keys(env).length} 个变量`);
    }

    try {
      const proc = spawn({
        cmd: [shell, ...args, params.command],
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      // 等待一小段时间收集初始输出
      await new Promise(resolve => setTimeout(resolve, BACKGROUND_DELAY_MS));

      const pid = proc.pid;
      backgroundPids.add(pid);

      // 尝试读取初始输出（非阻塞）
      let initialOutput = "";
      try {
        const stdout = await Promise.race([
          new Response(proc.stdout).text(),
          new Promise<string>(resolve => setTimeout(() => resolve(""), 100)),
        ]);
        if (stdout) initialOutput = stdout.slice(0, 500); // 只取前 500 字符
      } catch {
        // 忽略读取失败
      }

      log.info("TOOL", `✓ 命令已在后台运行 PID=${pid}`);

      let output = `命令已在后台运行 (PID: ${pid})`;
      if (initialOutput) {
        output += `\n\n初始输出:\n${initialOutput}`;
      }

      return { output };
    } catch (err: any) {
      return { output: `后台执行失败: ${err.message}`, isError: true };
    }
  }

  /** Task 系统后台执行（新模式） */
  private executeWithTaskSystem(params: {
    command: string;
    cwd?: string;
  }, signal?: AbortSignal): ToolResult {
    const { spawnShellTask } = require("../task/index.ts");
    const cwd = params.cwd || process.cwd();

    const taskState = spawnShellTask({
      command: params.command,
      cwd,
      signal,
    });

    return {
      output: JSON.stringify({
        task_id: taskState.id,
        status: taskState.status,
        output_file: taskState.outputFile,
        message: `命令已作为后台任务启动 (task_id: ${taskState.id})`,
      }),
    };
  }
}
