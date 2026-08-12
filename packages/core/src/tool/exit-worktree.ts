/**
 * ExitWorktreeTool（Spec 18 §3.4.2）
 * 退出当前 Worktree 并返回主工作区。
 *
 * remove 模式：删除前精确计数未提交文件 + 未合并 commit（P0-3），
 * 有变更则拒绝并列出详情，需 discard_changes: true 强制。
 * git 命令失败时 fail-closed（拒绝删除）。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  WorktreeManager,
  getCurrentWorktreeSession,
  clearWorktreeSession,
  setCurrentWorktreeSession,
} from "../worktree/manager.ts";
import { switchCwd, exitWorktreeCwd } from "../worktree/canonical.ts";
import { clearWorktreeState } from "../worktree/persistence.ts";
import { killTmuxSession } from "../worktree/tmux.ts";
import { logWorktreeEvent } from "../worktree/analytics.ts";
import type { WorktreeSession } from "../worktree/types.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const exitWorktreeSchema = lazySchema(() =>
  z.object({
    action: z
      .enum(["keep", "remove"])
      .optional()
      .describe("keep 保留 Worktree，remove 删除（默认 keep）"),
    discard_changes: z
      .boolean()
      .optional()
      .describe("remove 且存在未提交工作时，设为 true 强制删除"),
  }),
);

export class ExitWorktreeTool implements Tool {
  readonly zodSchema = exitWorktreeSchema();
  /** 长尾工具：worktree 隔离低频使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "git worktree exit cleanup 隔离 工作树 退出 清理";

  name(): string {
    return "exit_worktree";
  }

  description(): string {
    return `退出当前 Worktree 并返回主工作区。
action 为 "keep" 保留 Worktree（默认），"remove" 删除。
删除时如有未提交的工作（含未推送 commit），会拒绝并列出具体数量，需设置 discard_changes: true 确认。
无法检测状态时同样拒绝（fail-closed），以防丢失工作。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(exitWorktreeSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const session = getCurrentWorktreeSession();
    if (!session) {
      return { output: "当前不在 Worktree 中", isError: true };
    }

    const { action = "keep", discard_changes } = (input ?? {}) as {
      action?: "keep" | "remove";
      discard_changes?: boolean;
    };

    if (action === "remove") {
      return this.doRemove(session, discard_changes ?? false);
    }

    // keep：仅切回 CWD + 清状态（B2 原子切换）
    try {
      await exitWorktreeCwd(session.originalCwd);
    } catch (err: any) {
      return { output: `无法切回主工作区: ${err.message}`, isError: true };
    }
    clearWorktreeSession();
    clearWorktreeState(session.originalCwd);

    logWorktreeEvent("worktree_kept", { slug: session.worktreeName });
    log.info("WORKTREE", `退出 Worktree（保留）: ${session.worktreePath}`);
    const tmuxLine = session.tmuxSession
      ? `\ntmux session 保留: ${session.tmuxSession}（tmux attach -t ${session.tmuxSession} 接入）`
      : "";
    return {
      output: `已退出 Worktree（保留在 ${session.worktreePath}，分支 ${session.worktreeBranch}）${tmuxLine}`,
    };
  }

  /** remove 模式：精确变更报告 + fail-closed + 删除失败回滚（P0-3/B6） */
  private async doRemove(session: WorktreeSession, discard: boolean): Promise<ToolResult> {
    const log = getLogger();
    const manager = new WorktreeManager(session.originalCwd);

    // P0-3：删除前精确计数（在切回主仓前，countChanges 需在 worktree 内的 git 仓库执行）
    if (!discard) {
      const changes = manager.countChanges(session.worktreePath, session.originalHeadCommit);
      if (changes === null) {
        // fail-closed：无法检测状态
        return {
          output:
            "无法检测 Worktree 状态（git 命令失败），拒绝删除。请手动检查后使用 discard_changes: true 强制删除。",
          isError: true,
        };
      }
      if (changes.changedFiles > 0 || changes.commits > 0) {
        return {
          output:
            `检测到 ${changes.changedFiles} 个未提交文件、${changes.commits} 个未合并 commit，拒绝删除以防丢失工作。\n` +
            `如确认丢弃，请设置 discard_changes: true。`,
          isError: true,
        };
      }
    }

    // 必须先切回主工作区，否则无法删除当前所在的 worktree（B2 原子切换）
    try {
      switchCwd(session.originalCwd);
    } catch (err: any) {
      return { output: `无法切回主工作区: ${err.message}`, isError: true };
    }

    try {
      await manager.remove(session, discard);
    } catch (err: any) {
      // B6：删除失败回滚——尝试恢复到 worktree（如果还能进去）
      try {
        switchCwd(session.worktreePath);
        setCurrentWorktreeSession(session);
        return { output: `删除失败，已恢复到 Worktree: ${err.message}`, isError: true };
      } catch {
        // worktree 目录也不可达 → 强制清理状态，停在主仓
        clearWorktreeSession();
        clearWorktreeState(session.originalCwd);
        return {
          output: `删除失败且 Worktree 已不可达，已停在主工作区: ${err.message}`,
          isError: true,
        };
      }
    }

    // 删除成功：清状态 + 清缓存 + kill tmux
    clearWorktreeSession();
    clearWorktreeState(session.originalCwd);
    const { clearCwdDependentCaches } = await import("../worktree/manager.ts");
    await clearCwdDependentCaches();
    if (session.tmuxSession) {
      killTmuxSession(session.tmuxSession);
    }

    logWorktreeEvent("worktree_removed", {
      slug: session.worktreeName,
      discardedFiles: 0,
      discardedCommits: 0,
    });
    log.info("WORKTREE", `退出并删除 Worktree: ${session.worktreePath}`);
    return { output: `已退出并删除 Worktree（${session.worktreeName}）` };
  }
}
