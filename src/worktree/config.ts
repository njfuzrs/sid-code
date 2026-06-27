/**
 * Worktree 配置读取（settings.worktree.* 的统一入口 + 默认值）
 *
 * 集中处理默认值，避免散落在 manager/include-copy/tmux 各处。
 */

import { getSettings } from "../config/settings/settings.ts";

/** worktree 配置（已填充默认值） */
export interface WorktreeConfig {
  /** 额外 symlink 的目录（默认 ["node_modules"]，向后兼容硬编码行为） */
  symlinkDirectories: string[];
  /** sparse-checkout 路径（空 = 不启用） */
  sparsePaths: string[];
  /** 基准 ref（默认 fresh） */
  baseRef: "fresh" | "head";
  /** 是否安装 commit 归因 hook（默认 false） */
  commitAttribution: boolean;
  /** 是否自动复制 settings.local.json（默认 true） */
  copyLocalSettings: boolean;
}

/** 默认配置（无 settings 时的兜底） */
export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  symlinkDirectories: ["node_modules"],
  sparsePaths: [],
  baseRef: "fresh",
  commitAttribution: false,
  copyLocalSettings: true,
};

/**
 * 读取 worktree 配置，填充默认值。
 * 容错：settings 读取失败时返回全默认值（绝不因配置错误阻断 worktree 创建）。
 */
export function getWorktreeConfig(gitRoot?: string): WorktreeConfig {
  try {
    const { settings } = getSettings(gitRoot);
    const wt = (settings?.worktree ?? {}) as {
      symlinkDirectories?: string[];
      sparsePaths?: string[];
      baseRef?: string;
      commitAttribution?: boolean;
      copyLocalSettings?: boolean;
    };
    return {
      symlinkDirectories:
        Array.isArray(wt.symlinkDirectories) && wt.symlinkDirectories.length > 0
          ? wt.symlinkDirectories
          : DEFAULT_WORKTREE_CONFIG.symlinkDirectories,
      sparsePaths: Array.isArray(wt.sparsePaths) ? wt.sparsePaths : [],
      baseRef: wt.baseRef === "head" ? "head" : DEFAULT_WORKTREE_CONFIG.baseRef,
      commitAttribution: wt.commitAttribution === true,
      copyLocalSettings: wt.copyLocalSettings !== false,
    };
  } catch {
    return { ...DEFAULT_WORKTREE_CONFIG };
  }
}
