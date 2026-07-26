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
import { withTeamMember } from "./team-context.ts";
import { PermissionSync, type PermissionArbiter } from "./permission-sync.ts";
import { assignAgentColor, getAgentColor, type AgentColor } from "../agent/color.ts";
import {
  createStructuredTask,
  updateStructuredTask,
  getStructuredTask,
  getTeamTasks,
  clearTeamTasks,
  claimNextUnblockedTask,
  isTaskUnblocked,
} from "../task/structured-task-store.ts";
import { persistTeamTasks, loadTeamTasks } from "../task/team-task-store.ts";
import { getLogger } from "../debug/logger.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import type { Checker, PermissionRequest, Decision } from "../permission/types.ts";
/**
 * P3-2：teammate 显示模式（对齐 CC teammateMode 的 tmux / in-process 两态）。
 *
 * CC 还有 `tmux -CC`（iTerm2 原生 tab）——这里不作为独立模式：tmux.ts 已自动检测 iTerm2
 * 并在提示里给出 `tmux -CC attach`，模式本身仍是 tmux，避免多一个近义枚举增加心智负担。
 */
export type TeammateMode = "in-process" | "tmux";

/** 解析 teammate 显示模式：显式入参 > 环境变量 > in-process 默认。非法值回退默认。 */
export function resolveTeammateMode(
  explicit?: TeammateMode,
  raw: string | undefined = process.env.SID_TEAMMATE_MODE,
): TeammateMode {
  if (explicit === "tmux" || explicit === "in-process") return explicit;
  if (raw === "tmux") return "tmux";
  return "in-process";
}

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
  /** P2-2：本成员从共享池额外认领并完成的任务数（0/未认领时省略）。 */
  claimedTaskCount?: number;
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
  /**
   * P2-2：共享任务池——不预分配给成员的任务。成员做完自己的 task 后从这里认领，
   * 直到池空（CC 式「teammate 从共享列表认领」）。空/未设 = 仅执行成员各自的 task。
   */
  sharedTasks?: Array<{ subject: string; description: string }>;
  /**
   * P3-2：teammate 显示模式（对齐 CC teammateMode）。
   * - "in-process"（默认）：成员输出汇聚回主对话，用 agent 身份色区分。
   * - "tmux"：额外给每个成员开一个 tmux window 实时 tail 其输出（需环境有 tmux，
   *   无 tmux 或创建失败时 warn 并自动降级 in-process，绝不阻断执行）。
   * 缺省时读 SID_TEAMMATE_MODE 环境变量，仍缺省则 in-process。
   */
  teammateMode?: TeammateMode;
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
  /** P2-2：共享池任务 ID（未预分配给成员，由成员做完自己的活后认领）。 */
  private sharedTaskIds: string[] = [];
  /** P3-2：生效的 teammate 显示模式（tmux 不可用时会被降级为 in-process）。 */
  private teammateMode: TeammateMode;
  /** P3-2：tmux 观察 session 名（仅 tmux 模式且创建成功时非空）。 */
  private tmuxSession: string | null = null;

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
    // P3-2：显式入参 > SID_TEAMMATE_MODE > in-process。实际可用性在 run() 里探测后可能降级。
    this.teammateMode = resolveTeammateMode(opts.teammateMode);
  }

  /** P3-2：当前生效的显示模式（tmux 探测失败后为 in-process）。供调用方汇总展示。 */
  getTeammateMode(): TeammateMode {
    return this.teammateMode;
  }

  /** P3-2：tmux 观察 session 名（未启用/创建失败为 null），供调用方提示用户如何 attach。 */
  getTmuxSession(): string | null {
    return this.tmuxSession;
  }

  /**
   * P3-2：tmux 模式下建立观察 session。不可用则就地降级为 in-process 并 warn。
   * 观察窗是纯增益，任何失败都不得阻断团队执行。
   */
  private async setupTeammateDisplay(): Promise<void> {
    if (this.teammateMode !== "tmux") return;
    try {
      const { createTeamTmuxSession, generateTeamTmuxSessionName } = await import("../worktree/tmux.ts");
      const name = generateTeamTmuxSessionName(this.teamName);
      this.tmuxSession = createTeamTmuxSession(name, this.opts.baseDir ?? process.cwd());
    } catch (err: any) {
      getLogger().warn("SWARM", `teammate tmux 观察窗初始化失败: ${err?.message ?? err}`);
      this.tmuxSession = null;
    }
    if (!this.tmuxSession) {
      // 降级：把生效模式改回 in-process，后续不再尝试开 pane（避免每个成员各失败一次）。
      this.teammateMode = "in-process";
      getLogger().warn("SWARM", "teammateMode=tmux 不可用，已降级为 in-process（成员输出仍汇总回主对话）");
    }
  }

  /** P3-2：给某成员开观察 pane（tail 其落盘输出）。非 tmux 模式直接跳过。 */
  private async attachMemberPane(memberName: string, outputFile: string | undefined): Promise<void> {
    if (this.teammateMode !== "tmux" || !this.tmuxSession || !outputFile) return;
    try {
      const { createTeammatePane } = await import("../worktree/tmux.ts");
      createTeammatePane(this.tmuxSession, memberName, outputFile);
    } catch {
      /* 观察窗失败不影响执行 */
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
  // P1-3：leader 侧的 mailbox 写入口（补齐双向通信的另一半方向）
  // ============================================================

  /**
   * leader 向运行中的某成员追加消息（成员下一轮 onBeforeTurn drain 时读到）。
   *
   * 与「创建团队时投递初始任务」不同：这是**运行期**的追加指令通道，让 leader 能在
   * 成员执行途中补充上下文、纠偏、或转达其他成员的发现。
   *
   * @returns 成员名不存在时返回 false（不静默丢消息）
   */
  sendToMember(
    memberName: string,
    content: string,
    kind: "task" | "result" | "info" = "info",
  ): boolean {
    if (!this.opts.members.some((m) => m.name === memberName)) return false;
    this.mailbox.send({ from: "leader", to: memberName, content, kind, timestamp: 0 });
    return true;
  }

  /** 广播给全部成员（各自收件箱一份）。返回实际投递的成员数。 */
  broadcastToMembers(content: string, kind: "task" | "result" | "info" = "info"): number {
    let n = 0;
    for (const m of this.opts.members) {
      this.mailbox.send({ from: "leader", to: m.name, content, kind, timestamp: 0 });
      n++;
    }
    return n;
  }

  /** 取 leader 收件箱里已 drain 出的成员消息（run 结束后可读，用于观测/回放）。 */
  getLeaderMessages(): import("./mailbox.ts").MailMessage[] {
    return this.leaderMessages;
  }

  /**
   * 构建成员任务 prompt：任务本体 + 团队协作说明。
   *
   * 说明段告诉成员「你在一个团队里、队友是谁、可以用 team_message 联系谁」——
   * 否则成员不知道通信通道存在，team_message 白注册（工具在池里但模型永不调用）。
   * 只在有队友时才附加，单成员团队不加噪音。
   */
  private buildMemberPrompt(member: TeammateSpec): string {
    const peers = this.opts.members.map((m) => m.name).filter((n) => n !== member.name);
    if (peers.length === 0) return member.task;
    return `${member.task}

---

你是团队「${this.teamName}」的成员 **${member.name}**。队友：${peers.join("、")}。
需要与他人沟通时用 \`team_message\` 工具：收信人写队友名，或写 "leader" 汇报给团队负责人。
适用场景：向 leader 汇报进展/提问、与依赖你产出的队友约定接口、把影响他人的发现同步出去。
对方会在其下一轮开始时收到。你自己收到的消息也会在每轮开头以「团队消息」出现。`;
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
        // 只看本团队分区的任务（主会话 TODO 与其他团队的任务不参与成员映射复原）。
        for (const t of getTeamTasks(this.teamName)) {
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
        // 映射不完整（成员集变更）→ 放弃复用，只清本团队分区后重建，避免半吊子状态。
        // 关键：clearTeamTasks 而非全量清空——后者会连带删掉主会话 LLM 的 TODO 清单。
        this.memberTaskIds.clear();
        clearTeamTasks(this.teamName);
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

    // P2-2：共享池任务——刻意不打 metadata.member，成员做完自己的活后按 onlyUnassigned 认领。
    this.sharedTaskIds = [];
    for (const st of this.opts.sharedTasks ?? []) {
      const task = createStructuredTask({
        subject: st.subject,
        description: st.description,
        metadata: { team: this.teamName },
      });
      this.sharedTaskIds.push(task.id);
    }
    if (this.sharedTaskIds.length > 0) {
      log.info("TEAM_TASKS", `团队 "${this.teamName}" 共享任务池: ${this.sharedTaskIds.length} 个待认领任务`);
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

  /**
   * 标记成员任务终态（成功=completed / 失败保持 in_progress→仍标 completed 释放依赖，但记 metadata.failed），落盘。
   *
   * 幂等：认领调度路径会在自身任务跑完后先调一次（尽早解锁下游），runMember 的 finally
   * 兜底再调一次。已是 completed 时直接返回，避免第二次调用把首次记录的 failed 标记冲掉。
   */
  private markMemberDone(memberName: string, success: boolean): void {
    const taskId = this.memberTaskIds.get(memberName);
    if (!taskId) return;
    if (getStructuredTask(taskId)?.status === "completed") return;
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

    // P3-2：tmux 模式先建观察 session（失败即降级 in-process，不阻断）。
    await this.setupTeammateDisplay();

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

  /**
   * 执行单个成员：先做自己被预分配的任务，再从共享池认领未分配任务直到池空（CC 式自协调）。
   *
   * 共享池 = 该团队分区里 `metadata.member` 为空的 pending 任务（leader 用
   * `shared_tasks` 参数或 task_create 建的活）。成员做完自己的活不闲着，
   * 继续认领——这是 CC「teammate 从共享列表认领任务」的核心行为。
   * 认领在同一 worktree / 同一 SubAgent 配置下进行，避免每个任务重开隔离环境。
   */
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

      // P3-2：tmux 模式下预建任务，以便拿到 outputFile 并为该成员开观察 pane。
      // 预建同时把 taskId/abortController 交给子代理复用（_taskId 路径），避免重复建任务。
      // in-process 模式不预建，保持原路径（由 sub-agent 内部按需创建）。
      let preTaskId: string | undefined;
      let preAbort: AbortController | undefined;
      if (this.teammateMode === "tmux") {
        try {
          const { createAgentTask } = await import("../task/agent-task.ts");
          const created = createAgentTask({
            agentType: member.type,
            prompt: member.task,
            description: `[${this.teamName}] ${member.name}`,
          });
          preTaskId = created.taskState.id;
          preAbort = created.abortController;
          await this.attachMemberPane(member.name, created.taskState.outputFile);
        } catch (err: any) {
          // 预建/开窗失败不影响执行——回落到不带 _taskId 的常规路径。
          log.debug("SWARM", `teammate 观察窗预建任务失败 (${member.name}): ${err?.message ?? err}`);
          preTaskId = undefined;
          preAbort = undefined;
        }
      }

      /**
       * 取一次预建任务字段（取后清空）。只有 tmux 模式的第一段执行会拿到，
       * 保证观察 pane tail 的那个 outputFile 正是成员主任务的输出。
       */
      const takePreTask = (): { _taskId?: string; _abortController?: AbortController } => {
        if (!preTaskId || !preAbort) return {};
        const out = { _taskId: preTaskId, _abortController: preAbort };
        preTaskId = undefined;
        preAbort = undefined;
        return out;
      };

      /** 跑一段任务文本，返回子代理结果并把结果回写 leader 邮箱。 */
      const runOne = async (prompt: string, label: string) => {
        // P1-3：把成员身份绑到整条异步执行链，使成员内部调用 team_message 时能确定
        // "我是谁"、往哪个团队邮箱投递。并发成员各自独立 store，不串台。
        const exec = await withTeamMember(
          {
            teamName: this.teamName,
            memberName: member.name,
            mailbox: this.mailbox,
            memberNames: this.opts.members.map((m) => m.name),
          },
          () => sub.execute(
          {
            type: member.type,
            description: `[${this.teamName}] ${label}`,
            prompt,
            cwd: isolatedCwd, // B7: withAgentCwd 隔离，并发安全
            // P3-2：tmux 模式预建的任务只复用给第一段（成员自己的活）——观察 pane 正 tail
            // 它的输出文件。后续认领任务各自建新任务（takePreTask 取一次即清空）。
            ...takePreTask(),
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
          ),
        );
        // 结果回写到 leader 邮箱
        this.mailbox.send({
          from: member.name,
          to: "leader",
          content: exec.output,
          kind: "result",
          timestamp: ts,
        });
        return exec;
      };

      // ① 先做自己被预分配的任务（带上团队协作说明，让成员知道有 team_message 通道可用）。
      const own = await runOne(this.buildMemberPrompt(member), member.name);
      result.success = own.success;
      result.output = own.output;

      // P2-2：② 自己的活干完，从共享池继续认领未分配任务，直到池空或被中止（CC 式自协调）。
      // markMemberDone 在 finally 里执行，所以这里先手动置本成员任务完成，
      // 让依赖本成员的下游任务在本轮认领中就能解锁。
      this.markMemberDone(member.name, own.success);

      const claimedOutputs: string[] = [];
      while (!memberSignal?.aborted) {
        const claimed = claimNextUnblockedTask(member.name, this.teamName, {
          onlyUnassigned: true,
        });
        if (!claimed) break;
        persistTeamTasks(this.teamName, this.opts.baseDir);
        log.info("TEAM_TASKS", `成员 "${member.name}" 认领共享任务 #${claimed.id}: ${claimed.subject}`);
        try {
          const exec = await runOne(
            `${claimed.subject}\n\n${claimed.description}`,
            `${member.name} → #${claimed.id}`,
          );
          claimedOutputs.push(
            `\n\n--- 认领任务 #${claimed.id}（${claimed.subject}）---\n${exec.output}`,
          );
          if (!exec.success) result.success = false;
          updateStructuredTask(claimed.id, {
            status: "completed",
            metadata: { failed: !exec.success },
          });
        } catch (err: any) {
          // 单个认领任务失败不拖垮成员：标完成（记 failed）释放下游依赖后继续认领。
          log.warn("TEAM_TASKS", `成员 "${member.name}" 执行认领任务 #${claimed.id} 失败: ${err?.message ?? err}`);
          claimedOutputs.push(`\n\n--- 认领任务 #${claimed.id} 执行失败：${err?.message ?? err} ---`);
          result.success = false;
          updateStructuredTask(claimed.id, {
            status: "completed",
            metadata: { failed: true },
          });
        }
        persistTeamTasks(this.teamName, this.opts.baseDir);
      }
      if (claimedOutputs.length > 0) {
        result.output += claimedOutputs.join("");
        result.claimedTaskCount = claimedOutputs.length;
      }
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
