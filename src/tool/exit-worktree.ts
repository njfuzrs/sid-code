/**
 * ExitWorktreeTool（Spec 18 §3.4.2）
 * 退出当前 Worktree 并返回主工作区。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  WorktreeManager,
  getCurrentWorktreeSession,
  clearWorktreeSession,
  clearCwdDependentCaches,
} from "../worktree/manager.ts";
import { getLogger } from "../debug/logger.ts";

export class ExitWorktreeTool implements Tool {
  name(): string {
    return "exit_worktree";
  }

  description(): string {
    return `退出当前 Worktree 并返回主工作区。
action 为 "keep" 保留 Worktree（默认），"remove" 删除。
删除时如有未提交的工作，需设置 discard_changes: true 确认（否则拒绝删除以防丢失工作）。`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["keep", "remove"],
          description: "keep 保留 Worktree，remove 删除（默认 keep）",
        },
        discard_changes: {
          type: "boolean",
          description: "remove 且存在未提交工作时，设为 true 强制删除",
        },
      },
    };
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
      const manager = new WorktreeManager(session.originalCwd);
      // 必须先切回主工作区，否则无法删除当前所在的 worktree
      try {
        process.chdir(session.originalCwd);
      } catch (err: any) {
        return { output: `无法切回主工作区: ${err.message}`, isError: true };
      }
      try {
        await manager.remove(session, discard_changes ?? false);
      } catch (err: any) {
        // 删除失败：恢复到 worktree（保持一致性）
        try {
          process.chdir(session.worktreePath);
        } catch {
          /* worktree 可能已部分删除，保持在主工作区 */
        }
        return { output: err.message, isError: true };
      }
      clearWorktreeSession();
      await clearCwdDependentCaches();
      log.info("WORKTREE", `退出并删除 Worktree: ${session.worktreePath}`);
      return { output: `已退出并删除 Worktree（${session.worktreeName}）` };
    }

    // keep：仅切回 CWD
    try {
      process.chdir(session.originalCwd);
    } catch (err: any) {
      return { output: `无法切回主工作区: ${err.message}`, isError: true };
    }
    clearWorktreeSession();
    await clearCwdDependentCaches();
    log.info("WORKTREE", `退出 Worktree（保留）: ${session.worktreePath}`);
    return {
      output: `已退出 Worktree（保留在 ${session.worktreePath}，分支 ${session.worktreeBranch}）`,
    };
  }
}
