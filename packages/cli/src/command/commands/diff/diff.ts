/**
 * /diff 命令实现
 * 显示当前工作区的 git diff（对标 claude-code 看 working diff）。
 *
 * - 无参 = `git diff`（未暂存改动）
 * - `--staged` / `--cached` = `git diff --cached`（已暂存改动）
 *
 * 用 execFileSync 直接调 git（参数数组形式，天然免命令注入），非 git 仓库时给友好提示。
 */

import { execFileSync } from "child_process";
import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { SUCCESS_MARK } from "../../../ui/constants/figures.ts";

/** 单条 git 命令的执行封装：返回 stdout 文本；失败抛出携带 stderr 的错误。 */
function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
    // diff 可能很大，放宽 stdout 缓冲上限到 32MB
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** 判断 cwd 是否在 git 工作区内。 */
function isGitRepo(cwd: string): boolean {
  try {
    runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const cwd = ctx.cwd;

    if (!isGitRepo(cwd)) {
      return {
        type: "text",
        value: "当前目录不是 git 仓库，无法查看 diff。",
      };
    }

    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const staged = tokens.some((t) => t === "--staged" || t === "--cached");

    const diffArgs = staged ? ["diff", "--cached"] : ["diff"];
    const label = staged ? "已暂存改动（--staged）" : "未暂存改动";

    let output: string;
    try {
      output = runGit(diffArgs, cwd);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: "text", value: `git diff 执行失败: ${msg}` };
    }

    const trimmed = output.trimEnd();
    if (!trimmed) {
      const hint = staged
        ? "没有已暂存的改动。（无参 /diff 查看未暂存改动）"
        : "工作区没有未暂存的改动。（/diff --staged 查看已暂存改动）";
      return { type: "text", value: hint };
    }

    // 统计变更文件数（diff --stat 的末行汇总更省事，但为避免二次调用，用 diff 头行计数）
    const fileCount = (trimmed.match(/^diff --git /gm) || []).length;
    const header = `${SUCCESS_MARK} ${label}（${fileCount} 个文件）`;

    return { type: "text", value: `${header}\n\n${trimmed}` };
  },
};

export default mod;
