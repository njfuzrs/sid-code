/**
 * .worktreeinclude 文件支持（P1-4）
 *
 * 问题：.env / .secrets 等 gitignored 文件不会被 git worktree add 带过去，
 * 但开发时往往需要它们。
 *
 * 方案：主仓根下放 .worktreeinclude（gitignore 语法），列出需要跟随 worktree 的
 * gitignored 文件 / 目录。创建 worktree 后把匹配项复制过去。
 *
 * 性能：用 `git ls-files --others --ignored --exclude-standard --directory`，
 * --directory 折叠完全 gitignored 的目录（避免列出百万文件），只对匹配 pattern 的展开。
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync, statSync, readdirSync } from "fs";
import { join, dirname, relative } from "path";
import { execFileSync } from "child_process";
import { getLogger } from "../debug/logger.ts";

const INCLUDE_FILE = ".worktreeinclude";

/** 单条 gitignore 风格 pattern → 简单匹配器 */
interface Pattern {
  /** 是否目录匹配（以 / 结尾） */
  raw: string;
  /** 规范化后的相对路径前缀 */
  normalized: string;
}

/** 解析 .worktreeinclude，返回 pattern 列表（忽略注释和空行） */
export function parseIncludeFile(gitRoot: string): Pattern[] {
  const path = join(gitRoot, INCLUDE_FILE);
  if (!existsSync(path)) return [];
  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const patterns: Pattern[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // 去掉前导 ./ 和 /
    const normalized = trimmed.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (normalized) patterns.push({ raw: trimmed, normalized });
  }
  return patterns;
}

/** 判断相对路径是否匹配某个 pattern（前缀匹配，支持目录/文件） */
function matchesPattern(relPath: string, patterns: Pattern[]): boolean {
  for (const p of patterns) {
    if (relPath === p.normalized) return true;
    // 目录前缀：pattern "config" 匹配 "config/x.json"
    if (relPath.startsWith(p.normalized + "/")) return true;
    // pattern 是某文件所在目录：pattern "config/db.env" 由 git 列出的就是该文件本身
    if (p.normalized.startsWith(relPath + "/")) return true;
  }
  return false;
}

/** 列出主仓中所有 gitignored 的文件/目录（折叠目录） */
function listIgnoredEntries(gitRoot: string): string[] {
  try {
    const out = execFileSync(
      "git",
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ],
      { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return out
      .split("\n")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 递归复制文件或目录（保持相对结构） */
function copyRecursive(src: string, dest: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(src);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(src)) {
      copyRecursive(join(src, child), join(dest, child));
    }
  } else if (st.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

/**
 * 把 .worktreeinclude 匹配的 gitignored 文件复制到 worktree。
 * 在 postCreationSetup 末尾调用。失败仅 warn，不阻断创建。
 */
export function applyWorktreeInclude(gitRoot: string, worktreePath: string): void {
  const log = getLogger();
  const patterns = parseIncludeFile(gitRoot);
  if (patterns.length === 0) return;

  const ignored = listIgnoredEntries(gitRoot);
  let copied = 0;

  for (const entry of ignored) {
    const rel = relative(gitRoot, join(gitRoot, entry));
    if (!matchesPattern(rel, patterns)) continue;
    const src = join(gitRoot, entry);
    const dest = join(worktreePath, entry);
    // 防覆盖：worktree 内已有则跳过
    if (existsSync(dest)) continue;
    try {
      copyRecursive(src, dest);
      copied++;
    } catch (err: any) {
      log.warn("WORKTREE", `复制 ${entry} 到 worktree 失败: ${err.message}`);
    }
  }

  if (copied > 0) {
    log.info("WORKTREE", `.worktreeinclude: 复制了 ${copied} 个条目到 worktree`);
  }
}
