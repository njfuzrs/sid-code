/**
 * 团队记忆运行时配置共享单例。
 *
 * write / edit 工具的 secret 守卫需要知道「团队记忆是否启用 + 共享目录」，
 * 但工具构造时拿不到 config。沿用 secret-redact hook 的单例套路：app 启动时
 * setTeamMemoryOptions 注入，工具与 watcher 通过 getTeamMemoryOptions 读取。
 */

import type { TeamMemoryOptions } from "./paths.ts";

let _opts: TeamMemoryOptions | null = null;

/** app 启动时注入团队记忆配置（来自 config.teamMemory） */
export function setTeamMemoryOptions(opts: TeamMemoryOptions | undefined): void {
  _opts = opts ?? null;
}

/** 读取团队记忆配置（未注入返回 undefined，等价未启用） */
export function getTeamMemoryOptions(): TeamMemoryOptions | undefined {
  return _opts ?? undefined;
}
