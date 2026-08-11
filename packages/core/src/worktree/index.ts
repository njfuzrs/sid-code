/**
 * Worktree 隔离系统统一导出
 */

export type {
  WorktreeSession,
  WorktreeChanges,
  PersistedWorktreeSession,
  CreateWorktreeOptions,
} from "./types.ts";

export {
  WorktreeManager,
  findGitRoot,
  findGitRootForAgent,
  getCurrentWorktreeSession,
  setCurrentWorktreeSession,
  clearWorktreeSession,
  clearCwdDependentCaches,
} from "./manager.ts";

export {
  validateWorktreeSlug,
  flattenSlug,
  unflattenSlug,
  branchNameForSlug,
  MAX_SLUG_LENGTH,
} from "./slug.ts";

export {
  findCanonicalGitRoot,
  switchCwd,
  enterWorktreeCwd,
  exitWorktreeCwd,
} from "./canonical.ts";

export {
  saveWorktreeState,
  clearWorktreeState,
  restoreWorktreeSession,
  sessionConfigPath,
} from "./persistence.ts";

export { getWorktreeConfig, DEFAULT_WORKTREE_CONFIG } from "./config.ts";

export {
  hasWorktreeCreateHook,
  hasWorktreeRemoveHook,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
} from "./hooks.ts";

export { isEphemeralWorktree, cleanupStaleWorktrees } from "./cleanup.ts";

export {
  generateTmuxSessionName,
  isTmuxAvailable,
  createTmuxSessionForWorktree,
  killTmuxSession,
  tmuxSessionExists,
} from "./tmux.ts";

export { logWorktreeEvent } from "./analytics.ts";
export type { WorktreeEventName } from "./analytics.ts";
