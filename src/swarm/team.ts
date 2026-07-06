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
import { PermissionSync, type PermissionArbiter } from "./permission-sync.ts";
import { assignAgentColor, type AgentColor } from "../agent/color.ts";
import { getLogger } from "../debug/logger.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import type { Checker, PermissionRequest, Decision } from "../permission/types.ts";
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
  /** team 级硬超时（毫秒），默认 15 分钟。测试时可注入短值触发。 */
  timeoutMs?: number;
  /** leader 的权限裁决回调（teammate 需确认操作时转发给 leader） */
  permissionArbiter?: PermissionArbiter;
  /** 子代理 checker（dontAsk 语义基底，teammate 在其基础上加 escalate） */
  subAgentChecker?: Checker;
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
    // 接入 leader 权限裁决回调
    if (opts.permissionArbiter) {
      this.permissionSync.setArbiter(opts.permissionArbiter);
    }
  }

  private safeName(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /**
   * 为 swarm teammate 创建带 escalate 的权限 checker wrapper。
   *
   * 逻辑：底层 checker(dontAsk 语义) 判定 deny 时直接拒绝；
   * 判定 needsConfirmation(ask) 时不直接 deny，而是通过 PermissionSync 转发给 leader 裁决。
   * leader allow → 放行；leader deny → 拒绝。
   */
  private createEscalateChecker(baseChecker: Checker, teammateName: string): Checker {
    const permSync = this.permissionSync;
    return {
      async check(req: PermissionRequest, tool?: unknown, toolContext?: unknown): Promise<Decision> {
        const decision = await baseChecker.check(req, tool, toolContext);

        // 直接允许或直接拒绝(非 ask) → 照常
        if (decision.allowed) return decision;
        if (!decision.needsConfirmation) return decision;

        // needsConfirmation → 转发给 leader
        const verdict = await permSync.requestPermission({
          teammate: teammateName,
          toolName: req.toolName,
          description: req.description || `${req.toolName}: ${JSON.stringify(req.input).slice(0, 120)}`,
        });

        if (verdict === "allow" || verdict === "allow-always") {
          return { allowed: true, reason: `leader 批准 (${verdict})` };
        }
        return { allowed: false, reason: decision.reason || "leader 拒绝" };
      },
    };
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
    // D 模式兜底：team 级硬超时，防止单个成员 hang 导致整个 Promise.all 永久阻塞
    // T5-B2：支持从 opts.timeoutMs 注入（测试用短值触发），默认 15 分钟
    const TEAM_HARD_TIMEOUT_MS = this.opts.timeoutMs ?? 15 * 60 * 1000;
    // T5-B2：超时时不仅 reject，还要 abort 所有成员的执行——否则底层子代理进程/流
    // 仍在后台跑，泄漏资源。teamAbortCtl 的 signal 会合并进每个成员的 signal。
    const teamAbortCtl = new AbortController();
    let teamTimer: ReturnType<typeof setTimeout> | null = null;
    const teamTimeoutPromise = new Promise<never>((_, reject) => {
      teamTimer = setTimeout(() => {
        teamAbortCtl.abort("team-hard-timeout");
        reject(new Error(`Swarm team 整体超时 (${TEAM_HARD_TIMEOUT_MS / 1000}s)`));
      }, TEAM_HARD_TIMEOUT_MS);
      teamTimer.unref();
    });
    try {
      const results = await Promise.race([
        Promise.all(
          this.opts.members.map((m) =>
            this.runMember(m, gitRoot, ts, signal, teamAbortCtl.signal),
          ),
        ),
        teamTimeoutPromise,
      ]);

      // 保持成员定义顺序
      const byName = new Map<string, TeammateResult>();
      for (const r of results) byName.set(r.name, r);
      return this.opts.members.map((m) => byName.get(m.name)!);
    } finally {
      // 正常完成路径清掉定时器（unref 已保证不阻塞退出，这里避免多余 fire）
      if (teamTimer) clearTimeout(teamTimer);
    }
  }

  /** 执行单个成员任务 */
  private async runMember(
    member: TeammateSpec,
    gitRoot: string | null,
    ts: number,
    signal?: AbortSignal,
    teamSignal?: AbortSignal,
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
      // 注入权限检查器：基于主 checker 的 dontAsk 语义 + escalate 到 leader
      if (this.opts.subAgentChecker) {
        const escalateChecker = this.createEscalateChecker(
          this.opts.subAgentChecker,
          member.name,
        );
        sub.setPermissionChecker(escalateChecker);
      }
      // T5-B2：合并成员自身 signal 与 team 级 signal——team 超时时 teamSignal abort，
      // 成员执行随之中断，不再留后台孤儿。任一 signal 缺省则退化为另一个。
      const memberSignal =
        signal && teamSignal
          ? AbortSignal.any([signal, teamSignal])
          : (signal ?? teamSignal);
      const exec = await sub.execute(
        {
          type: member.type,
          description: `[${this.teamName}] ${member.name}`,
          prompt: member.task,
          cwd: isolatedCwd, // B7: withAgentCwd 隔离，并发安全
        },
        memberSignal,
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
