/**
 * Swarm 团队管理器（Spec 18 §7.3.2）
 *
 * 进程内编排：leader 创建一个团队，为每个 teammate 分配独立的 Worktree（文件隔离）
 * 和 mailbox（消息通道），并发跑子代理执行各自的子任务，最后汇总结果。
 *
 * 与单纯的 sub_agent 并发不同：team 成员之间能通过 mailbox 通信、共享 leader 的
 * 权限裁决（permission-sync），且各自在独立 worktree 中改文件互不冲突。
 */

import { join } from "path";
import { randomBytes } from "crypto";
import { Mailbox } from "./mailbox.ts";
import { PermissionSync } from "./permission-sync.ts";
import { assignAgentColor, type AgentColor } from "../agent/color.ts";
import { getLogger } from "../debug/logger.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
/** 团队成员定义 */
export interface TeammateSpec {
  /** 成员名（团队内唯一） */
  name: string;
  /** 子代理类型（开放字符串，可用类型由 getActiveAgentTypes() 运行时派生） */
  type: string;
  /** 分配给该成员的任务 */
  task: string;
  /** 是否需要独立 Worktree（默认 true，会改文件的成员需要） */
  isolated?: boolean;
}

/** 成员执行结果 */
export interface TeammateResult {
  name: string;
  success: boolean;
  output: string;
  color: AgentColor;
  worktreePath?: string;
}

export interface TeamOptions {
  teamName: string;
  members: TeammateSpec[];
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  /** 团队根目录基准（默认 cwd） */
  baseDir?: string;
}

export class TeamManager {
  readonly teamName: string;
  readonly mailbox: Mailbox;
  readonly permissionSync: PermissionSync;
  private readonly teamDir: string;

  constructor(private opts: TeamOptions) {
    this.teamName = opts.teamName;
    const base = opts.baseDir ?? process.cwd();
    this.teamDir = join(base, ".sid-code", "swarm", this.safeName(opts.teamName));
    this.mailbox = new Mailbox(this.teamDir);
    this.permissionSync = new PermissionSync();
  }

  private safeName(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /**
   * 执行所有成员任务，返回汇总结果。
   *
   * 隔离模型说明：process.chdir 是进程级全局状态，并发成员无法各自持有独立 cwd。
   * 因此：
   * - 隔离成员（isolated，会改文件）→ 串行执行（chdir 进 worktree → 跑 → 切回），互不踩 cwd
   * - 非隔离成员（只读/不依赖 cwd）→ 并发执行
   * 结束后清理无改动的 worktree（fail-closed，有改动则保留）。
   *
   * @param stampMs 时间戳（由调用方传入，避免内部依赖 Date.now 便于测试）
   */
  async run(signal?: AbortSignal, stampMs?: number): Promise<TeammateResult[]> {
    const { findGitRootForAgent } = await import("../worktree/manager.ts");
    // canonical root 防嵌套（P0-2/B1）
    const gitRoot = findGitRootForAgent(process.cwd());
    const ts = stampMs ?? 0;

    // B7：隔离成员经 SubAgentTask.cwd 走 withAgentCwd（AsyncLocalStorage），
    // 不再用 process.chdir，因此隔离成员也可与非隔离成员一起并发执行（无 chdir 竞态）。
    const results = await Promise.all(
      this.opts.members.map((m) => this.runMember(m, gitRoot, ts, signal)),
    );

    // 保持成员定义顺序
    const byName = new Map<string, TeammateResult>();
    for (const r of results) byName.set(r.name, r);
    return this.opts.members.map((m) => byName.get(m.name)!);
  }

  /** 执行单个成员任务 */
  private async runMember(
    member: TeammateSpec,
    gitRoot: string | null,
    ts: number,
    signal?: AbortSignal,
  ): Promise<TeammateResult> {
    const log = getLogger();
    const { SubAgent } = await import("../agent/sub-agent.ts");
    const { WorktreeManager } = await import("../worktree/manager.ts");

    const color = assignAgentColor(`${this.teamName}:${member.name}`);
    const result: TeammateResult = {
      name: member.name,
      success: false,
      output: "",
      color,
    };

    // 投递初始任务到成员邮箱（可回放）
    this.mailbox.send({
      from: "leader",
      to: member.name,
      content: member.task,
      kind: "task",
      timestamp: ts,
    });

    const needsIsolation = member.isolated !== false && !!gitRoot;
    let worktreeSession: import("../worktree/manager.ts").WorktreeSession | null = null;
    let manager: import("../worktree/manager.ts").WorktreeManager | null = null;
    let isolatedCwd: string | undefined;

    try {
      if (needsIsolation && gitRoot) {
        manager = new WorktreeManager(gitRoot);
        const wtName = `swarm-${this.safeName(this.teamName)}-${member.name}-${randomBytes(3).toString("hex")}`;
        worktreeSession = await manager.create(wtName);
        result.worktreePath = worktreeSession.worktreePath;
        isolatedCwd = worktreeSession.worktreePath;
      }

      const sub = SubAgent.fromRegistry(
        this.opts.providerRegistry,
        this.opts.toolRegistry,
      );
      const exec = await sub.execute(
        {
          type: member.type,
          description: `[${this.teamName}] ${member.name}`,
          prompt: member.task,
          cwd: isolatedCwd, // B7: withAgentCwd 隔离，并发安全
        },
        signal,
      );
      result.success = exec.success;
      result.output = exec.output;

      // 结果回写到 leader 邮箱
      this.mailbox.send({
        from: member.name,
        to: "leader",
        content: exec.output,
        kind: "result",
        timestamp: ts,
      });
    } catch (err: any) {
      result.output = `成员 ${member.name} 执行失败: ${err.message}`;
      log.error("SWARM", result.output);
    } finally {
      if (manager && worktreeSession) {
        try {
          await manager.remove(worktreeSession, false); // 无改动才删
        } catch {
          log.info("SWARM", `保留有改动的成员 Worktree: ${worktreeSession.worktreePath}`);
        }
      }
    }

    return result;
  }
}
