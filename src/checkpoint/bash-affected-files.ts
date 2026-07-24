/**
 * 从破坏性 bash 命令提取受影响文件（P2-1）
 *
 * 背景：checkpoint 原本只对 write/edit 工具快照，通过 bash 跑的 `git reset --hard`、
 * `git checkout .`、`rm file`、`git clean -fd` 造成的破坏无法被 /undo 回退——而这恰恰是
 * 最需要回退保护的操作。这里为破坏性 bash 命令做执行前快照的文件集提取。
 *
 * 分层：
 *   - 精确可提取：rm <file> / git checkout <file> / mv <src> <dst>——从 AST 提取显式路径。
 *   - 范围性破坏（无法逐文件提取）：git reset --hard / checkout . / clean -fd——
 *     改用「工作区级轻量快照」：git diff --name-only + git diff --cached --name-only 的文件集。
 *
 * 触发条件收敛：只对破坏性命令（matchGitDanger 命中，或 rm/mv 等文件破坏命令）做提取，
 * 不是所有 bash 都快照，避免每条命令都 IO。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { parseBashCommand, extractSimpleCommands } from "../tool/bash/parser.ts";
import { matchGitDanger } from "../permission/git-danger-patterns.ts";
import { getLogger } from "../debug/logger.ts";

const execFileAsync = promisify(execFile);

/** 判断命令是否为「范围性破坏」——影响整个工作区、无法逐文件静态提取 */
function isWorkspaceWideDestruction(command: string): boolean {
  return (
    /\bgit\s+reset\s+(--\S+\s+)*--hard\b/.test(command) ||
    /\bgit\s+(checkout|restore)\s+(--\s+)?\.[ \t]*($|[;&|\n])/.test(command) ||
    /\bgit\s+clean\b[^;&|\n]*-[a-zA-Z]*f/.test(command)
  );
}

/** 从工作区 git diff 提取「已修改 + 已暂存」文件集（范围性破坏的快照对象） */
async function getGitWorkingSetFiles(cwd: string): Promise<string[]> {
  const files = new Set<string>();
  const collect = async (args: string[]) => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8" });
      for (const line of stdout.split("\n")) {
        const rel = line.trim();
        if (rel) files.add(path.isAbsolute(rel) ? rel : path.resolve(cwd, rel));
      }
    } catch {
      /* 非 git 仓库 / git 不可用 → 空集，不阻断 */
    }
  };
  await collect(["diff", "--name-only"]);
  await collect(["diff", "--cached", "--name-only"]);
  return [...files];
}

/**
 * 从单条 bash 命令的 AST 提取精确的受影响文件路径。
 * 只处理 rm / git checkout <file> / git restore <file> / mv 等显式路径命令。
 */
function extractExplicitPaths(command: string, cwd: string): string[] {
  const files: string[] = [];
  let simpleCommands: Array<{ command: string; args: string[] }>;
  try {
    simpleCommands = extractSimpleCommands(parseBashCommand(command));
  } catch {
    return files;
  }

  const resolve = (tok: string) => (path.isAbsolute(tok) ? tok : path.resolve(cwd, tok));

  for (const { command: cmd, args } of simpleCommands) {
    if (cmd === "rm") {
      // rm [-flags] file...：取所有非 flag 参数
      for (const a of args) {
        if (!a || a.startsWith("-")) continue;
        files.push(resolve(a));
      }
    } else if (cmd === "mv" || cmd === "cp") {
      // mv src... dst：源与目标都可能被破坏/覆盖，全收
      for (const a of args) {
        if (!a || a.startsWith("-")) continue;
        files.push(resolve(a));
      }
    } else if (cmd === "git") {
      const sub = args[0];
      if (sub === "checkout" || sub === "restore") {
        // git checkout/restore <file>（非 "." —— "." 走范围性快照）
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (!a || a.startsWith("-") || a === ".") continue;
          // 跳过 <commit>/<branch>：checkout 的第一个非 flag 参数可能是分支名。
          // 保守起见：只收看起来像路径的（含 / 或 . 或存在后缀）——难精确，
          // 但范围性破坏已由 workspace-wide 兜底，这里只做尽力而为。
          files.push(resolve(a));
        }
      }
    }
  }
  return files;
}

/**
 * 判断命令是否需要执行前快照，并返回受影响文件集。
 *
 * @param command bash 命令字符串
 * @param cwd 命令执行目录（相对路径解析基准）
 * @returns 受影响文件绝对路径数组；不需要快照时返回空数组
 */
export async function getBashAffectedFiles(command: string, cwd: string): Promise<string[]> {
  if (!command?.trim()) return [];

  const isDestructiveGit = matchGitDanger(command) !== null;
  const isFileDestruction = /\b(rm|mv)\b/.test(command);

  // 触发条件收敛：非破坏性命令不快照
  if (!isDestructiveGit && !isFileDestruction) return [];

  try {
    // 范围性破坏 → 工作区级快照
    if (isWorkspaceWideDestruction(command)) {
      return await getGitWorkingSetFiles(cwd);
    }
    // 精确路径提取
    return extractExplicitPaths(command, cwd);
  } catch (err: any) {
    getLogger().warn("CHECKPOINT", `bash 受影响文件提取失败（不阻断）: ${err?.message}`);
    return [];
  }
}
