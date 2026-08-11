/**
 * CLAUDE.md 记忆文件发现（/memory 面板用）
 *
 * 扫描项目级与用户级的 CLAUDE.md 候选路径，返回存在的文件 + 元信息（大小/修改时间）。
 * 与 config/rules.ts 的加载逻辑解耦：那边负责「合并注入系统提示词」，这里只做「面板展示」。
 */

import { statSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { sidHomePath } from "@sid-code/core/config/paths.ts";

export type MemoryScope = "project" | "user";

export interface MemoryFileInfo {
  /** 绝对路径 */
  path: string;
  /** 展示用相对/简短路径 */
  displayPath: string;
  /** 作用域 */
  scope: MemoryScope;
  /** 文件字节数 */
  size: number;
  /** 最后修改时间（ms） */
  mtimeMs: number;
}

/** 项目级候选（相对 cwd） */
const PROJECT_CANDIDATES = [
  "CLAUDE.md",
  ".claude.md",
  "claude.md",
  ".claude/CLAUDE.md",
  ".claude/instructions.md",
  "CLAUDE.local.md",
  ".claude/CLAUDE.local.md",
  ".sid-code/CLAUDE.md",
];

/** 格式化文件大小为可读字符串（B/KB/MB）。 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 格式化修改时间为 YYYY-MM-DD（本地时区）。 */
export function formatMtime(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 探测单个路径，存在则返回信息，否则 null。 */
function probe(absPath: string, displayPath: string, scope: MemoryScope): MemoryFileInfo | null {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    return { path: absPath, displayPath, scope, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 发现所有存在的 CLAUDE.md 记忆文件。
 * 项目级在前、用户级在后；同一路径去重（绝对路径）。
 */
export function discoverMemoryFiles(cwd: string): MemoryFileInfo[] {
  const found: MemoryFileInfo[] = [];
  const seen = new Set<string>();

  const add = (info: MemoryFileInfo | null) => {
    if (info && !seen.has(info.path)) {
      seen.add(info.path);
      found.push(info);
    }
  };

  // 项目级
  for (const rel of PROJECT_CANDIDATES) {
    add(probe(join(cwd, rel), rel, "project"));
  }

  // 用户级：~/.claude/CLAUDE.md 与 sid-code home 下的 CLAUDE.md
  add(probe(join(homedir(), ".claude", "CLAUDE.md"), "~/.claude/CLAUDE.md", "user"));
  add(probe(sidHomePath("CLAUDE.md"), "~/.sid-code/CLAUDE.md", "user"));

  return found;
}

/** 读取记忆文件内容（失败返回错误提示文本）。 */
export function readMemoryContent(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err: any) {
    return `（读取失败：${err?.message ?? String(err)}）`;
  }
}
