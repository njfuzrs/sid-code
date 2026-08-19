/**
 * EnterWorktreeTool（Spec 18 §3.4.2）
 * 创建一个隔离的 Git Worktree 工作区并切换当前 CWD 进入。
 * 支持 name（新建/进入同名）与 path（进入已存在的 worktree 目录）两种模式。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import {
  WorktreeManager,
  findGitRoot,
  getCurrentWorktreeSession,
  setCurrentWorktreeSession,
} from "../worktree/manager.ts";
import { findCanonicalGitRoot, enterWorktreeCwd } from "../worktree/canonical.ts";
import { validateWorktreeSlug, branchNameForSlug } from "../worktree/slug.ts";
import { saveWorktreeState } from "../worktree/persistence.ts";
import { logWorktreeEvent } from "../worktree/analytics.ts";
import { generateTmuxSessionName, createTmuxSessionForWorktree } from "../worktree/tmux.ts";
import type { WorktreeSession } from "../worktree/types.ts";
import { generateWordSlug } from "../plan/slug.ts";
import { getCwd } from "../bootstrap/state.ts";
import { formatPathNotFoundError } from "./path-utils.ts";
import { getLogger } from "../debug/logger.ts";
import { existsSync, readFileSync } from "fs";
import { join, basename, resolve } from "path";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const enterWorktreeSchema = lazySchema(() =>
  z.object({
    name: z
      .string()
      .optional()
      .describe("Worktree 名称（可选，默认自动生成词汇 slug；与 path 互斥）"),
    path: z.string().optional().describe("进入已存在的 Worktree 目录路径（与 name 互斥）"),
    pr: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("PR 编号：fetch pull/<n>/head 后创建 worktree review"),
    tmux: z.boolean().optional().describe("同时创建关联的 tmux session（便于独立终端接入）"),
  }),
);

export class EnterWorktreeTool implements Tool {
  readonly zodSchema = enterWorktreeSchema();
  // ⚠️ 刻意**不声明** shouldDefer（2026-08-17 事故后从 true 改掉，不要改回去）。
  //
  // 全仓 38 个内置工具两两算公共前缀，「always-live × deferred 且前缀 ≥4」的组合只有两对：
  //   enter_plan_mode / enter_worktree (prefix=6)、exit_plan_mode / exit_worktree (prefix=5)
  // 而这正是生成期坍缩的必要条件：延迟工具不在本轮 schema 里，模型"想调"它时会坍缩成
  // 当轮唯一共享前缀的真实工具 —— 实测 enter_worktree → enter_plan_mode 误触 5 次、
  // 产出 4 份无用 plan 文件、任务卡死到用户手动打断。去掉这两个 shouldDefer 后
  // 当前碰撞面直接归零。
  //
  // 成本实测可忽略：两个 description 合计约 450 字符，对照首轮 25 个工具 schema
  // 共 29596 字节 ≈ 1.5%。且 CLAUDE.md 把 worktree 并行开发写成常规工作流，
  // 它本不属于 cron_*/team_* 那种真正的长尾（延迟机制服务的是"单个 MCP server
  // 动辄几十个工具"那种规模）。
  //
  // 注意这只是**即时止血**，不替代系统提示词侧的分区修复
  // （config/deferred-tool-view.ts）：下一个新增的延迟工具只要凑巧与某个 always-live
  // 工具共享前缀，同样的故障会复发。防回退断言见
  // packages/core/tests/tool/worktree-tools-not-deferred.test.ts。
  readonly searchHint = "git worktree isolation branch 隔离 工作树 分支";

  name(): string {
    return "enter_worktree";
  }

  description(): string {
    return `创建一个隔离的 Git Worktree 工作区并进入。
用于需要在独立环境中工作的场景，如并行实验、多方案对比、PR review。
Worktree 共享 Git 对象库，创建速度快，磁盘开销小。
进入后当前会话的工作目录会切换到该 Worktree，使用 exit_worktree 返回主工作区。
- name: 新建或进入同名 worktree
- path: 进入一个已存在的 worktree 目录
- pr: fetch 指定 PR 分支并在 worktree 中 checkout
- tmux: 同时创建关联 tmux session`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(enterWorktreeSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = (input ?? {}) as {
      name?: string;
      path?: string;
      pr?: number;
      tmux?: boolean;
    };

    // 1. 防止嵌套 worktree
    if (getCurrentWorktreeSession()) {
      return { output: "已经在 Worktree 中，不支持嵌套。请先 exit_worktree。", isError: true };
    }

    // name / path 互斥
    if (params.name && params.path) {
      return { output: "name 与 path 互斥，只能指定其一", isError: true };
    }

    // path 模式：进入已存在的 worktree（P2-6）
    if (params.path) {
      return this.enterExisting(params.path, params.tmux);
    }

    // 2. 检测 Git 仓库（用 canonical root 防嵌套，B1/P0-2）
    const gitRoot = findCanonicalGitRoot(getCwd()) ?? findGitRoot(getCwd());
    if (!gitRoot) {
      return { output: "当前目录不在 Git 仓库中，无法创建 Worktree", isError: true };
    }

    // 3. slug 校验（用户传入的 name 必须校验，P0-4/B5）
    const worktreesDir = join(gitRoot, ".sid-code", "worktrees");
    const slug = params.name || generateWordSlug(worktreesDir);
    if (params.name) {
      const v = validateWorktreeSlug(params.name);
      if (!v.valid) {
        return { output: `非法 Worktree 名称: ${v.error}`, isError: true };
      }
    }

    try {
      const manager = new WorktreeManager(gitRoot);
      const session = await manager.create(slug, { prNumber: params.pr });

      // 4. tmux（可选，P2-1）
      if (params.tmux) {
        const tmuxName = generateTmuxSessionName(basename(gitRoot), session.worktreeName);
        const created = createTmuxSessionForWorktree(session.worktreePath, tmuxName);
        if (created) session.tmuxSession = created;
      }

      // 5. 原子切换 CWD + 清缓存（B2）
      await enterWorktreeCwd(session.worktreePath);
      setCurrentWorktreeSession(session);

      // 6. 持久化（P0-1）
      saveWorktreeState(session);

      // 7. analytics（P2-10）
      logWorktreeEvent("worktree_created", {
        slug: session.worktreeName,
        hookBased: !!session.hookBased,
        prNumber: params.pr,
        durationMs: session.creationDurationMs,
        usedSparsePaths: session.usedSparsePaths,
      });

      log.info("WORKTREE", `进入 Worktree: ${session.worktreePath}`);
      const tmuxLine = session.tmuxSession
        ? `\ntmux: ${session.tmuxSession}（可用 tmux attach -t ${session.tmuxSession} 接入）`
        : "";
      // 创建期告警（依赖不一致 / DB migration）：条件真实成立才有内容
      const warnLines = (session.setupWarnings ?? []).length
        ? "\n\n" + session.setupWarnings!.map((w) => `⚠️ ${w}`).join("\n")
        : "";
      return {
        output: `已创建并进入 Worktree。\n路径: ${session.worktreePath}\n分支: ${session.worktreeBranch}${tmuxLine}${warnLines}`,
      };
    } catch (err: any) {
      log.error("WORKTREE", `创建 Worktree 失败: ${err.message}`);
      return { output: `创建 Worktree 失败: ${err.message}`, isError: true };
    }
  }

  /** 进入一个已存在的 worktree 目录（P2-6） */
  private async enterExisting(rawPath: string, tmux?: boolean): Promise<ToolResult> {
    const log = getLogger();
    const worktreePath = resolve(rawPath);

    // 1. 验证目录存在且是 worktree（.git 是 pointer file）
    //
    // 两种失败**必须分开报**：原实现把它们合成一句"路径不存在或不是 Git worktree"，
    // 于是既不告诉模型当前工作目录（相对路径按会跟随 bash cd 的全局 cwd 解析），
    // 也分不清"路径打错了"和"路径对但不是 worktree"这两件需要不同下一步的事。
    // 反过来也不能一律套通用函数：目录确实存在时报一段"目录中存在相似文件"是纯误导。
    const gitPointer = join(worktreePath, ".git");
    if (!existsSync(worktreePath)) {
      return { output: formatPathNotFoundError(worktreePath), isError: true };
    }
    if (!existsSync(gitPointer)) {
      return {
        output: `路径存在但不是 Git worktree（缺少 .git 指针文件）: ${worktreePath}`,
        isError: true,
      };
    }
    let pointerContent = "";
    try {
      pointerContent = readFileSync(gitPointer, "utf-8").trim();
    } catch {
      /* 忽略 */
    }
    if (!pointerContent.startsWith("gitdir:")) {
      return {
        output: `${worktreePath} 的 .git 不是 worktree pointer（可能是主仓或普通目录）`,
        isError: true,
      };
    }

    // 2. 验证属于当前仓库（canonical root 一致）
    const targetRoot = findCanonicalGitRoot(worktreePath);
    const currentRoot = findCanonicalGitRoot(getCwd());
    if (!targetRoot) {
      return { output: "无法定位该 worktree 所属的主仓", isError: true };
    }
    if (currentRoot && resolve(targetRoot) !== resolve(currentRoot)) {
      return { output: "目标 worktree 不属于当前仓库", isError: true };
    }

    // 3. 推导 branch / head 信息
    const name = basename(worktreePath);
    let headCommit = "";
    let branch = branchNameForSlug(name);
    try {
      const { execFileSync } = await import("child_process");
      headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const b = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (b && b !== "HEAD") branch = b;
    } catch {
      /* 忽略 */
    }

    const session: WorktreeSession = {
      originalCwd: targetRoot,
      worktreePath,
      worktreeName: name,
      sessionId: "",
      worktreeBranch: branch,
      originalHeadCommit: headCommit,
    };

    // 4. tmux（可选）
    if (tmux) {
      const tmuxName = generateTmuxSessionName(basename(targetRoot), name);
      const created = createTmuxSessionForWorktree(worktreePath, tmuxName);
      if (created) session.tmuxSession = created;
    }

    // 5. 切 cwd + 记录 + 持久化（不执行 postCreationSetup，已存在的不重复设置）
    await enterWorktreeCwd(worktreePath);
    setCurrentWorktreeSession(session);
    saveWorktreeState(session);

    logWorktreeEvent("worktree_resume", { slug: name, success: true });
    log.info("WORKTREE", `进入已存在的 Worktree: ${worktreePath}`);
    const tmuxLine = session.tmuxSession ? `\ntmux: ${session.tmuxSession}` : "";
    return {
      output: `已进入已存在的 Worktree。\n路径: ${worktreePath}\n分支: ${branch}${tmuxLine}`,
    };
  }
}
