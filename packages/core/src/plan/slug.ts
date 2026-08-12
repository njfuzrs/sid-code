/**
 * 词汇 Slug 生成器 + Plan 文件命名工具
 *
 * generateWordSlug / isWordSlug — Worktree 可读命名（brave-eagle-42）
 * formatPlanTime / resolvePlanProject / sanitizeProjectName / sanitizePlanTopic — Plan 文件语义命名
 */

import { existsSync } from "fs";
import { join, basename } from "path";
import { execFileSync } from "child_process";

/** 形容词词库 */
const ADJECTIVES = [
  "brave",
  "calm",
  "clever",
  "eager",
  "gentle",
  "happy",
  "keen",
  "lively",
  "noble",
  "quick",
  "sharp",
  "steady",
  "swift",
  "warm",
  "wise",
] as const;

/** 名词词库 */
const NOUNS = [
  "bear",
  "crane",
  "deer",
  "eagle",
  "falcon",
  "hawk",
  "lion",
  "otter",
  "panda",
  "raven",
  "tiger",
  "whale",
  "wolf",
  "zebra",
  "fox",
] as const;

/** 生成词汇 Slug（如 brave-eagle-42）
 *
 * @param existingDir 若提供，会检查该目录下是否已存在同名子目录，冲突则重试（B10）。
 */
export function generateWordSlug(existingDir?: string): string {
  const pick = () => {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(Math.random() * 100);
    return `${adj}-${noun}-${num}`;
  };

  if (!existingDir) return pick();

  // 去重：最多重试 10 次，仍冲突则追加更大随机数兜底
  for (let i = 0; i < 10; i++) {
    const slug = pick();
    try {
      if (!existsSync(join(existingDir, slug))) return slug;
    } catch {
      return slug;
    }
  }
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}-${100 + Math.floor(Math.random() * 900)}`;
}

/** 判断字符串是否符合词汇 Slug 形态（adj-noun-NN）—— 用于识别用户命名 vs 临时命名 */
export function isWordSlug(s: string): boolean {
  return /^[a-z]+-[a-z]+-\d{1,2}$/.test(s);
}

// ────────────────────────────────────────────────────────────────────────────────
// Plan 文件语义命名
// ────────────────────────────────────────────────────────────────────────────────

/** 格式化为 YYYYMMDD-HHmm（本地时区） */
export function formatPlanTime(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 从 cwd 解析项目名：basename(gitRoot ?? cwd) + sanitize。
 * 自带 git rev-parse，不依赖 worktree/manager.ts 避免循环引用。
 */
export function resolvePlanProject(cwd: string): string {
  let root = cwd;
  try {
    root =
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || cwd;
  } catch {
    // 非 git 环境，用 cwd
  }
  return sanitizeProjectName(basename(root));
}

/**
 * 项目目录名 sanitize：保留中英文数字，去路径分隔符/控制字符/Windows 敌对字符，
 * 去首尾点横线（防隐藏目录），限长 50，空兜底 "default"。
 */
export function sanitizeProjectName(raw: string): string {
  const cleaned = raw
    .replace(/[/\\\x00-\x1f]/g, "") // 路径分隔符 + 控制字符
    .replace(/[:*?"<>|]/g, "") // Windows 敌对字符
    .replace(/\s+/g, "-") // 空白转连字符
    .replace(/^[.\-]+|[.\-]+$/g, "") // 去首尾点/横线
    .slice(0, 50)
    .trim();
  return cleaned || "default";
}

/**
 * 中文主题 sanitize：同 sanitizeProjectName 但限长 40 字符，空返回 null（调用方兜底为纯时间戳）。
 */
export function sanitizePlanTopic(raw?: string): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[/\\\x00-\x1f]/g, "")
    .replace(/[:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 40)
    .trim();
  return cleaned || null;
}
