/**
 * Bash 工具 - 执行 shell 命令
 * 支持超时控制和工作目录设置
 */

import type { Tool, ToolResult } from "./types.ts";
import { spawn } from "bun";

export class BashTool implements Tool {
  name(): string {
    return "bash";
  }

  description(): string {
    return "执行 shell 命令。支持设置超时时间和工作目录。";
  }

  usageGuide(): string {
    return `- 仅用于需要 shell 执行的系统命令，文件操作请用专用工具
- 不要用 bash 执行 cat/head/tail（用 read）、echo/cat 写文件（用 write）、sed/awk（用 edit）、find（用 glob）、grep（用 grep 工具）
- 设置合理的 timeout，默认 2 分钟
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
        timeout: {
          type: "number",
          description: "超时时间（毫秒），默认 120000（2 分钟）",
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
    const params = input as { command: string; timeout?: number; cwd?: string };

    if (!params.command) {
      return { output: "错误: 缺少 command 参数", isError: true };
    }

    const timeout = params.timeout || 120000;
    const cwd = params.cwd || process.cwd();

    try {
      const proc = spawn({
        cmd: ["sh", "-c", params.command],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      // 超时控制
      const timeoutId = setTimeout(() => {
        proc.kill();
      }, timeout);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timeoutId);
      const exitCode = await proc.exited;

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += stderr;
      if (!output) output = "(命令无输出)";

      if (exitCode !== 0) {
        return {
          output: `命令执行失败（退出码 ${exitCode}）:\n${output}`,
          isError: true,
        };
      }

      return { output };
    } catch (err: any) {
      return { output: `执行命令失败: ${err.message}`, isError: true };
    }
  }
}
