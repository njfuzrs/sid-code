/**
 * 团队记忆路径解析与开关（对标 claude-code memdir/teamMemPaths.ts）
 *
 * sid 没有 Anthropic 后端，团队记忆采用「共享目录同步」模型：
 *
 *   本地团队记忆目录（每个项目一份，纳入 git 或本地缓存）：
 *     ~/.sid-code/projects/<project-key>/team-memory/
 *       ├── MEMORY.md          (团队共享索引)
 *       └── *.md               (团队共享记忆条目)
 *
 *   共享「远端」目录（teamMemory.dir 配置，指向网络盘 / 同步盘 / git 工作树
 *   里的共享路径）：所有协作者指向同一物理目录，sync 引擎在本地目录与共享
 *   目录之间做 checksum 增量双向同步。
 *
 * 与单机 auto-memory（memory/paths.ts）的区别：
 *   - auto-memory 是「我自己的」记忆，不共享、不扫 secret push。
 *   - team-memory 是「团队共享的」记忆，写入与同步前都过 secret 扫描。
 *
 * 安全设计沿用 memory/paths.ts：canonical git root 作为项目键、拒绝危险路径、
 * 共享目录覆盖路径必须是绝对路径且不落在 ~/.sid-code 之外的危险位置。
 */

import { join, resolve, sep } from "path";
import { existsSync, mkdirSync } from "fs";
import { getSidHome } from "../../config/paths.ts";
import { resolveProjectRoot, sanitizeProjectKey, validateMemoryPath } from "../paths.ts";

/** 本地团队记忆目录名 */
export const TEAM_MEMORY_DIRNAME = "team-memory";

/** 团队记忆开关 + 共享目录配置（从 config.teamMemory 读取） */
export interface TeamMemoryOptions {
  /** 是否启用团队记忆同步（默认 false） */
  enabled?: boolean;
  /**
   * 共享「远端」目录绝对路径（网络盘 / 同步盘 / git 共享路径）。
   * 未配置时团队记忆仍可本地使用，但不会发生跨成员同步。
   */
  dir?: string;
  /** debounce 推送等待毫秒（默认 2000，最后一次写入后等待再 push） */
  debounceMs?: number;
}

/**
 * 获取本地团队记忆目录路径（不自动创建）。
 * 与 auto-memory 同级：~/.sid-code/projects/<project-key>/team-memory/
 */
export function getTeamMemPath(cwd: string = process.cwd()): string {
  const root = resolveProjectRoot(cwd);
  const key = sanitizeProjectKey(root);
  return join(getSidHome(), "projects", key, TEAM_MEMORY_DIRNAME);
}

/** 获取本地团队记忆目录并确保存在 */
export function ensureTeamMemPath(cwd: string = process.cwd()): string {
  const dir = getTeamMemPath(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 判断绝对路径是否位于本地团队记忆目录内。
 * 供 write/edit 工具的 secret 守卫判定「这是不是一次团队记忆写入」。
 * 两端规范化，防止 ../ 逃逸。
 */
export function isTeamMemPath(absolutePath: string, cwd: string = process.cwd()): boolean {
  const teamDir = resolve(getTeamMemPath(cwd));
  const target = resolve(absolutePath);
  return target === teamDir || target.startsWith(teamDir + sep);
}

/**
 * 解析共享远端目录（teamMemory.dir）。
 * 必须是合法绝对路径；非法或未配置返回 undefined。
 */
export function resolveSharedTeamDir(opts?: TeamMemoryOptions): string | undefined {
  if (!opts?.dir) return undefined;
  return validateMemoryPath(opts.dir);
}

/**
 * 团队记忆是否「可同步」：开关开启 + 共享目录合法。
 * 仅本地使用（无共享目录）时返回 false——可写本地，但 watcher 不做跨成员同步。
 */
export function isTeamMemorySyncAvailable(opts?: TeamMemoryOptions): boolean {
  return Boolean(opts?.enabled) && resolveSharedTeamDir(opts) !== undefined;
}

/** 团队记忆功能是否启用（写守卫据此判断是否扫描团队记忆写入） */
export function isTeamMemoryEnabled(opts?: TeamMemoryOptions): boolean {
  return Boolean(opts?.enabled);
}
