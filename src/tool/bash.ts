/**
 * Bash 工具 - 执行 shell 命令
 * 对标 Claude Code：description 参数、输出截断、AbortSignal 集成、跨平台适配
 */

import type { Tool, ToolResult } from "./types.ts";
import { spawn } from "bun";
import { platform } from "os";
import { getLogger } from "../debug/logger.ts";

/** Bash 输出截断阈值（对标 Claude Code 30000 字符） */
const MAX_OUTPUT_LENGTH = 30000;

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
- 避免执行长时间运行的进程（如 dev server、watch 模式）`;
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
      },
      required: ["command"],
    };
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      command: string;
      description?: string;
      timeout?: number;
      cwd?: string;
    };

    if (!params.command) {
      return { output: "错误: 缺少 command 参数", isError: true };
    }

    log.info("TOOL", `▶ 执行: ${params.command.slice(0, 200)}${params.command.length > 200 ? "..." : ""}`);

    // 超时限制：最短 1 秒，最长 10 分钟
    const timeout = Math.min(Math.max(params.timeout || 120000, 1000), 600000);
    const cwd = params.cwd || process.cwd();
    const { shell, args } = getPlatformShell();

    try {
      const proc = spawn({
        cmd: [shell, ...args, params.command],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      // 超时控制 + AbortSignal 集成
      let killed = false;
      let killReason = "";

      const timeoutId = setTimeout(() => {
        killed = true;
        killReason = `命令超时（${timeout / 1000}秒）`;
        proc.kill();
      }, timeout);

      // AbortSignal 监听
      const abortHandler = () => {
        killed = true;
        killReason = "用户取消";
        proc.kill();
      };
      signal?.addEventListener("abort", abortHandler);

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

      // 截断超长输出
      output = truncateOutput(output);

      // 被终止的情况
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
    } catch (err: any) {
      return { output: `执行命令失败: ${err.message}`, isError: true };
    }
  }
}
