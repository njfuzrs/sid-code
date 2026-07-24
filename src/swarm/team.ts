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
import { assignAgentColor, getAgentColor, type AgentColor } from "../agent/color.ts";
import {
  createStructuredTask,
  updateStructuredTask,
  getStructuredTask,
  getAllStructuredTasks,
  isTaskUnblocked,
  __clearStructuredTasks,
} from "../task/structured-task-store.ts";
import { persistTeamTasks, loadTeamTasks } from "../task/team-task-store.ts";
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
  /** P2-2：本成员依赖的其他成员名（这些成员完成后本成员才开始执行）。
   *  用于「B 依赖 A」的有序编排——A 未完成前 B 不启动。空/未设 = 无依赖，可立即并发。 */
  dependsOn?: string[];
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
  /** G11：Hook 系统（teammate 完成/空闲时触发 TeammateIdle 事件） */
  hookSystem?: import("../hook/system.ts").HookSystem;
}

export class TeamManager {
  readonly teamName: string;
  readonly mailbox: Mailbox;
  readonly permissionSync: PermissionSync;
  private readonly teamDir: string;
  /** P1-3：leader 收件箱 drain 出的成员回写消息（run() 结束时填充，供观测/回放）。 */
  leaderMessages: import("./mailbox.ts").MailMessage[] = [];
  /** P2-2：成员名 → 共享任务列表中的任务 ID 映射（seedTaskList 建立）。 */
  private memberTaskIds = new Map<string, string>();

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

  // ============================================================
  // P2-2：共享任务列表调度（seed → 依赖等待 → 完成解锁 + 持久化）
  // ============================================================

  /**
   * 把成员任务建成结构化共享任务列表：每个成员一个任务，dependsOn 建成 blockedBy 依赖边。
   * 建完落盘一次（`.sid-code/tasks/{team}/tasks.json`）。
   * 依赖引用不存在的成员名时 warn 跳过该边（不阻断建列表）。
   */
  private seedTaskList(): void {
    const log = getLogger();
    this.memberTaskIds.clear();

    // P2-2：若该团队有历史任务文件，先恢复（进程重启/团队接续场景），并尝试按
    // metadata.member 复原成员→任务映射，让已完成的上游依赖在重启后依然生效。
    try {
      if (loadTeamTasks(this.teamName, this.opts.baseDir)) {
        for (const t of getAllStructuredTasks()) {
          const member = (t.metadata as { member?: string })?.member;
          if (typeof member === "string" && this.opts.members.some((m) => m.name === member)) {
            this.memberTaskIds.set(member, t.id);
          }
        }
        // 已完整复原全部成员映射时直接复用（不重建），保留历史完成态与依赖。
        if (this.memberTaskIds.size === this.opts.members.length) {
          log.info("TEAM_TASKS", `团队 "${this.teamName}" 从历史任务文件恢复 ${this.memberTaskIds.size} 个任务`);
          return;
        }
        // 映射不完整（成员集变更）→ 放弃复用，清空重建，避免半吊子状态。
        this.memberTaskIds.clear();
        __clearStructuredTasks();
      }
    } catch (err: any) {
      log.warn("TEAM_TASKS", `团队任务恢复失败（降级为全新）: ${err?.message ?? err}`);
      this.memberTaskIds.clear();
    }

    // 先建全部任务节点，拿到 ID
    for (const m of this.opts.members) {
      const task = createStructuredTask({
        subject: `[${this.teamName}] ${m.name}`,
        description: m.task,
        metadata: { team: this.teamName, member: m.name, agentType: m.type },
      });
      this.memberTaskIds.set(m.name, task.id);
    }
    // 再建依赖边：dependsOn 的上游成员完成后，本成员任务才解锁
    for (const m of this.opts.members) {
      if (!m.dependsOn || m.dependsOn.length === 0) continue;
      const selfId = this.memberTaskIds.get(m.name)!;
      const upstreamIds: string[] = [];
      for (const dep of m.dependsOn) {
        const depId = this.memberTaskIds.get(dep);
        if (!depId) {
          log.warn("TEAM_TASKS", `成员 "${m.name}" 依赖的成员 "${dep}" 不存在，已忽略该依赖`);
          continue;
        }
        upstreamIds.push(depId);
      }
      if (upstreamIds.length > 0) {
        const res = updateStructuredTask(selfId, { addBlockedBy: upstreamIds });
        if (!res.ok) log.warn("TEAM_TASKS", `成员 "${m.name}" 依赖建边失败: ${res.error}`);
      }
    }
    persistTeamTasks(this.teamName, this.opts.baseDir);
  }

  /** 某成员的所有依赖是否都已完成（据共享任务列表判断）。无任务映射时视为无依赖。 */
  private isMemberUnblocked(memberName: string): boolean {
    const taskId = this.memberTaskIds.get(memberName);
    if (!taskId) return true;
    const task = getStructuredTask(taskId);
    if (!task) return true;
    return isTaskUnblocked(task);
  }

  /** 标记成员任务进入执行态（认领），落盘。 */
  private markMemberRunning(memberName: string): void {
    const taskId = this.memberTaskIds.get(memberName);
    if (!taskId) return;
    updateStructuredTask(taskId, { status: "in_progress", owner: memberName });
    persistTeamTasks(this.teamName, this.opts.baseDir);
  }

  /** 标记成员任务终态（成功=completed / 失败保持 in_progress→仍标 completed 释放依赖，但记 metadata.failed），落盘。 */
  private markMemberDone(memberName: string, success: boolean): void {
    const taskId = this.memberTaskIds.get(memberName);
    if (!taskId) return;
    // 完成（含失败）都置 completed 以解锁下游——失败细节记入 metadata，避免整图死锁。
    updateStructuredTask(taskId, { status: "completed", metadata: { failed: !success } });
    persistTeamTasks(this.teamName, this.opts.baseDir);
  }

  /**
   * 等待某成员的依赖全部完成（轮询共享任务列表）。
   * 已解锁立即返回；否则每 200ms 检查一次，直到解锁或 signal abort。
   */
  private async waitForMemberUnblocked(memberName: string, signal?: AbortSignal): Promise<void> {
    if (this.isMemberUnblocked(memberName)) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(timer);
          reject(new Error("等待依赖时被中止"));
          return;
        }
        if (this.isMemberUnblocked(memberName)) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
      timer.unref?.();
    });
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

    // P2-2：把成员任务建成共享任务列表（结构化任务图），落盘 + 依赖建边。
    // 成员完成时 markTaskCompleted 触发依赖解锁，dependsOn 的成员据此等待上游。
    this.seedTaskList();

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

      // P1-3：leader drain 自己的收件箱，消费成员回写的 result 消息（真正闭合通信环——
      // 成员 send(to:"leader") 至此有了确定的消费方，不再是只写不读的伪通信）。
      // 结果本身已通过返回值收集，此处 drain 用于：① 让 mailbox 状态归零（标记已读）；
      // ② 供 leaderMessages 观测/回放（如后续 P3-2 三态显示模式消费）。
      this.leaderMessages = this.mailbox.drain("leader");

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

    // P1-2：优先用 agent 类型的 frontmatter 显式声明色（getAgentColor 内部回退哈希分配）；
    // 未声明色的 agent 仍按「团队名:成员名」哈希分配，保证同一成员颜色稳定。
    const color = member.type
      ? getAgentColor(member.type)
      : assignAgentColor(`${this.teamName}:${member.name}`);
    const result: TeammateResult = {
      name: member.name,
      success: false,
      output: "",
      color,
    };

    // P2-2：若本成员依赖其他成员，先等上游全部完成再启动（据共享任务列表判断）。
    // 无依赖成员立即通过，与原并发行为一致。等待期间 signal abort 则抛出，由外层捕获。
    if (member.dependsOn && member.dependsOn.length > 0) {
      try {
        await this.waitForMemberUnblocked(member.name, signal ?? teamSignal);
      } catch (err: any) {
        result.output = `成员 ${member.name} 等待依赖时被中止: ${err.message}`;
        this.markMemberDone(member.name, false);
        return result;
      }
    }

    // P2-2：认领任务（置 in_progress + owner），落盘。
    this.markMemberRunning(member.name);

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
          // P1-3：双向通信——每轮开始时 drain 本成员收件箱里的未读消息
          //（来自 leader 或其他 peer 成员），格式化后由子代理注入上下文。
          drainInbox: () => {
            const msgs = this.mailbox.drain(member.name);
            return msgs.map((m) => {
              const kind = m.kind ? `(${m.kind})` : "";
              return `来自 ${m.from}${kind}：${m.content}`;
            });
          },
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
      // P2-2：标记成员任务终态（completed 解锁下游依赖），落盘。放在最前——
      // 让等待本成员的 dependsOn 成员尽早解锁，不必等 worktree 清理/hook 触发完成。
      this.markMemberDone(member.name, result.success);

      if (manager && worktreeSession) {
        try {
          await manager.remove(worktreeSession, false); // 无改动才删
        } catch {
          log.info("SWARM", `保留有改动的成员 Worktree: ${worktreeSession.worktreePath}`);
        }
      }

      // G11：teammate 任务结束 → 进入空闲，触发 TeammateIdle hook（可 block，用于团队协作编排）
      // 注意：team.ts 刻意不依赖 Date.now（便于测试），idle_ms 交由 hook 消费方自行度量，此处不传。
      if (this.opts.hookSystem) {
        try {
          await this.opts.hookSystem.fireTeammateIdleEvent(
            `${this.teamName}:${member.name}`,
            member.name,
          );
        } catch (e) {
          log.warn("SWARM", `TeammateIdle hook 触发失败（不影响团队）: ${e}`);
        }
      }
    }

    return result;
  }
}
