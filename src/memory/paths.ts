/**
 * 记忆路径管理 + 安全验证（对齐 Claude Code memdir/paths.ts）
 *
 * 目录结构：
 *   ~/.sid-code/projects/<sanitized-project-root>/memory/
 *     ├── MEMORY.md          (索引)
 *     ├── user_*.md          (用户画像)
 *     ├── feedback_*.md      (行为反馈)
 *     ├── project_*.md       (项目上下文)
 *     └── reference_*.md     (外部引用)
 *
 * 安全设计：
 * - 使用 canonical git root（而非 cwd）作为路径键，确保同一仓库的所有
 *   工作树共享记忆。
 * - 拒绝相对路径、根路径、UNC 路径、null 字节。
 * - autoMemoryDirectory 覆盖配置不允许来自 projectSettings（防止恶意仓库
 *   把记忆目录指向 ~/.ssh）—— 此约束由调用方保证，本模块只提供校验函数。
 */

import { homedir } from "os";
import { join, isAbsolute, resolve, sep } from "path";
import { existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { getSidHome, isInsideSidHome } from "../config/paths.ts";

/** 记忆根目录：~/.sid-code/projects/ */
function projectsRoot(): string {
  return join(getSidHome(), "projects");
}

/**
 * 把项目根路径转成文件系统安全的目录名。
 * 用 git canonical root 派生，去掉分隔符与特殊字符。
 */
export function sanitizeProjectKey(raw: string): string {
  // 去掉首尾分隔符，把路径分隔符与不安全字符替换为 -
  const cleaned = raw
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

/**
 * 解析项目的 canonical root。
 * 优先取 git 顶层目录（同仓库多 worktree 共享记忆），失败时回退传入路径。
 *
 * 防御（P0-2）：若解析结果落在配置根 ~/.sid-code 之内（典型场景：进程 cwd
 * 恰为 ~/.sid-code，git 顶层或 resolve(cwd) 都会指向配置目录），则拒绝该根，
 * 改回退到 homedir()，避免项目级 ".sid-code/" 叠加出 ~/.sid-code/.sid-code/ 自嵌套。
 */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  let root: string;
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
      .toString()
      .trim();
    root = top || resolve(cwd);
  } catch {
    // 非 git 仓库或 git 不可用，回退
    root = resolve(cwd);
  }

  // 防御：项目根不得落在配置目录内，否则叠加出自嵌套
  if (isInsideSidHome(root)) {
    return homedir();
  }
  return root;
}

/**
 * 获取记忆目录路径（不自动创建）。
 * @param cwd 工作目录（默认 process.cwd()）
 * @param override 显式覆盖目录（来自非 projectSettings 的可信配置）
 */
export function getAutoMemPath(cwd: string = process.cwd(), override?: string): string {
  if (override) {
    const validated = validateMemoryPath(override);
    if (validated) return validated;
  }
  const root = resolveProjectRoot(cwd);
  const key = sanitizeProjectKey(root);
  return join(projectsRoot(), key, "memory");
}

/** 获取记忆目录路径并确保存在 */
export function ensureAutoMemPath(cwd: string = process.cwd(), override?: string): string {
  const dir = getAutoMemPath(cwd, override);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** MEMORY.md 索引文件路径 */
export function getMemoryIndexPath(cwd: string = process.cwd(), override?: string): string {
  return join(getAutoMemPath(cwd, override), "MEMORY.md");
}

/** Session Memory 文件路径：~/.sid-code/projects/<hash>/.session_memory.md */
export function getSessionMemoryPath(cwd: string = process.cwd()): string {
  const root = resolveProjectRoot(cwd);
  const key = sanitizeProjectKey(root);
  return join(projectsRoot(), key, ".session_memory.md");
}

/**
 * 判断绝对路径是否位于某个记忆目录内（用于提取代理工具权限校验）。
 * 同时规范化两端，防止 ../ 逃逸。
 */
export function isAutoMemPath(absolutePath: string, memoryDir: string): boolean {
  const normalizedTarget = resolve(absolutePath);
  const normalizedDir = resolve(memoryDir);
  return (
    normalizedTarget === normalizedDir ||
    normalizedTarget.startsWith(normalizedDir + sep)
  );
}

/**
 * 校验显式记忆目录覆盖路径的合法性。
 * 拒绝：相对路径、根路径、null 字节、UNC 路径。
 * 合法时返回规范化绝对路径，非法时返回 undefined。
 */
export function validateMemoryPath(raw: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  // null 字节
  if (raw.includes("\0")) return undefined;
  // UNC 路径（\\server\share）
  if (raw.startsWith("\\\\")) return undefined;
  // 必须是绝对路径
  if (!isAbsolute(raw)) return undefined;
  const normalized = resolve(raw);
  // 拒绝根路径
  if (normalized === sep || /^[a-zA-Z]:\\?$/.test(normalized)) return undefined;
  return normalized;
}

/**
 * 生成记忆文件名：<type>_<slug>.md
 * slug 由 name 派生为 kebab-case，截断到 60 字符。
 */
export function memoryFilename(type: string, name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
  return `${type}_${slug}.md`;
}
