/**
 * EnterWorktreeTool（Spec 18 §3.4.2）
 * 创建一个隔离的 Git Worktree 工作区并切换当前 CWD 进入。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  WorktreeManager,
  findGitRoot,
  getCurrentWorktreeSession,
  setCurrentWorktreeSession,
  clearCwdDependentCaches,
} from "../worktree/manager.ts";
import { generateWordSlug } from "../plan/slug.ts";
import { setCwd, getCwd } from "../bootstrap/state.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const enterWorktreeSchema = lazySchema(() =>
  z.object({
    name: z.string().optional().describe("Worktree 名称（可选，默认自动生成词汇 slug）"),
  }),
);

export class EnterWorktreeTool implements Tool {
  readonly zodSchema = enterWorktreeSchema();
  /** 长尾工具：worktree 隔离低频使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly searchHint = "git worktree isolation branch 隔离 工作树 分支";

  name(): string {
    return "enter_worktree";
  }

  description(): string {
    return `创建一个隔离的 Git Worktree 工作区并进入。
用于需要在独立环境中工作的场景，如并行实验、多方案对比。
Worktree 共享 Git 对象库，创建速度快，磁盘开销小。
进入后当前会话的工作目录会切换到该 Worktree，使用 exit_worktree 返回主工作区。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(enterWorktreeSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();

    // 1. 防止嵌套 worktree
    if (getCurrentWorktreeSession()) {
      return { output: "已经在 Worktree 中，不支持嵌套。请先 exit_worktree。", isError: true };
    }

    // 2. 检测 Git 仓库（基于逻辑 cwd，bash cd 后 getCwd() 才是真实工作目录）
    const gitRoot = findGitRoot(getCwd());
    if (!gitRoot) {
      return { output: "当前目录不在 Git 仓库中，无法创建 Worktree", isError: true };
    }

    // 3. 创建 worktree
    const slug = (input as { name?: string } | null)?.name || generateWordSlug();
    try {
      const manager = new WorktreeManager(gitRoot);
      const session = await manager.create(slug);

      // 4. 切换 CWD + 记录会话
      process.chdir(session.worktreePath);
      setCwd(session.worktreePath); // 同步全局 cwd 状态，使路径类工具 getCwd() 解析到 worktree
      setCurrentWorktreeSession(session);

      // 5. 清除依赖 CWD 的缓存
      await clearCwdDependentCaches();

      log.info("WORKTREE", `进入 Worktree: ${session.worktreePath}`);
      return {
        output: `已创建并进入 Worktree。\n路径: ${session.worktreePath}\n分支: ${session.worktreeBranch}`,
      };
    } catch (err: any) {
      log.error("WORKTREE", `创建 Worktree 失败: ${err.message}`);
      return { output: `创建 Worktree 失败: ${err.message}`, isError: true };
    }
  }
}
