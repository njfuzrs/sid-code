/**
 * 「项目基准目录」的四种口径（对齐 CC，见 docs-research bugfixes/todo/20261009-MCP加载路径… §3.1）。
 *
 * ⛔ **不要合并成一个 getProjectBase()**。CC 本身就按子系统刻意使用四种基准：
 *   B1 启动 cwd            —— 共享 settings.json、hooks、skills 热更新监听、`mcp add -s project`
 *   B2 git root（项目身份） —— settings.local.json、权限规则读写、信任、MCP 审批 / 禁用 / local
 *   B3 cwd → git root 逐级  —— skills / commands / agents / output-styles
 *   B4 cwd → 文件系统根逐级 —— CLAUDE.md、rules、CLAUDE.local.md、AGENTS.md、.mcp.json
 * 统一成一个只会让某几个子系统偏离 CC：例如子目录启动时读到仓库根的共享 settings.json
 * （CC 明文不读），或者把仓库外上层目录的 skills 拉进来（CC 停在 git root）。
 *
 * 所有函数都接受显式 `cwd`：调用点当前多用 `process.cwd()`（worktree 恢复后会 chdir），
 * 不传时才退回会话启动目录 `getOriginalCwd()`。
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { getOriginalCwd } from "../bootstrap/state.ts";
import { resolveProjectRoot } from "../memory/paths.ts";

/** B1：启动目录一层 */
export function getLaunchDir(cwd: string = getOriginalCwd()): string {
  return resolve(cwd);
}

/**
 * B2：项目身份根 = git toplevel；非仓库退回 cwd；落在 ~/.sid-code 内退回家目录
 * （三条都由 resolveProjectRoot 保证，这里只是给它一个按用途命名的入口）。
 */
export function getProjectIdentityRoot(cwd: string = getOriginalCwd()): string {
  return resolveProjectRoot(resolve(cwd));
}

/** 目录本身是否是 git 仓库根（`.git` 目录或 worktree 下的 `.git` 文件；零子进程） */
function isGitRootDir(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * B3：cwd → git root 逐级的目录列表，**远者在前、近者在后**（调用方按顺序合并即「近者覆盖」）。
 *
 * 上界（对齐 CC `markdownConfigLoader.ts` 的 resolveStopBoundary）：
 * - 处理完 git root 那一层即停（仓库外上层的扩展不加载）；
 * - 家目录本身不含（`~/.sid-code/<type>` 是用户层，另有加载点，含进来会被当成项目层重复加载）；
 * - 非仓库时一路到家目录之前，或到文件系统根。
 *
 * `subdir` 给出时返回 `join(dir, subdir)`，否则返回目录本身。
 */
export function getExtensionScanDirs(subdir?: string, cwd: string = getOriginalCwd()): string[] {
  const home = resolve(homedir());
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    if (current === home) break;
    dirs.push(current);
    if (isGitRootDir(current)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  dirs.reverse();
  return subdir ? dirs.map((d) => join(d, subdir)) : dirs;
}

/**
 * B4：cwd → 文件系统根逐级，**远者在前、近者在后**。
 * 不停在 git root、也不停在家目录 —— CC 的 CLAUDE.md / `.mcp.json` 就是这么读的。
 * 文件系统根本身不含（CC `claudemd.ts` / `mcp/config.ts` 的循环条件都是 `!== root`）；
 * cwd 恰为根时返回 `[根]`，否则调用方会拿到空链。
 */
export function getAncestorChain(cwd: string = getOriginalCwd()): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    const parent = dirname(current);
    if (parent === current) break; // current 是文件系统根
    dirs.push(current);
    current = parent;
  }
  if (dirs.length === 0) dirs.push(current);
  return dirs.reverse();
}
