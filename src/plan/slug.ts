/**
 * 词汇 Slug 生成器
 * 对标 Claude Code 的可读命名（如 brave-eagle-42），替代时间戳命名。
 *
 * 用于:
 * - Plan 文件命名（src/plan/state.ts）
 * - 用户手动创建的 Worktree 命名（src/worktree/）
 */

/** 形容词词库 */
const ADJECTIVES = [
  "brave", "calm", "clever", "eager", "gentle",
  "happy", "keen", "lively", "noble", "quick",
  "sharp", "steady", "swift", "warm", "wise",
] as const;

/** 名词词库 */
const NOUNS = [
  "bear", "crane", "deer", "eagle", "falcon",
  "hawk", "lion", "otter", "panda", "raven",
  "tiger", "whale", "wolf", "zebra", "fox",
] as const;

/** 生成词汇 Slug（如 brave-eagle-42） */
export function generateWordSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}-${noun}-${num}`;
}

/** 判断字符串是否符合词汇 Slug 形态（adj-noun-NN）—— 用于识别用户命名 vs 临时命名 */
export function isWordSlug(s: string): boolean {
  return /^[a-z]+-[a-z]+-\d{1,2}$/.test(s);
}
