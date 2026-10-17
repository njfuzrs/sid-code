/**
 * 子代理「残卷」（partial salvage）——超时/中断时把已完成的成果交回主代理。
 *
 * ## 为什么必须有这个模块（P0-1 的核心，不是调大 timeout）
 *
 * 事故实测（2026-08-11 会话）：4 个子代理全部撞 300s 墙钟，合计烧掉
 * **1,842,462 input token**，主代理从中拿到的可用信息**为零**——因为超时分支把
 * `finalOutput` 整句**替换**成一句话：
 *
 * ```
 * <error>子代理执行超时 (300秒，已完成 16 轮、32 次工具调用，其间 LLM 重试 1 次…)</error>
 * ```
 *
 * 那个 explore 子代理其实已经读到了 `ink.d.ts` 里 Color 类型的真实定义——**整个任务的
 * 关键前提**，一个字都没回传。判据一句话：
 *
 * > **「300s 改 600s 只是把同样的浪费翻倍，交回残卷才是止损。」**
 *
 * 所以本模块的职责不是"美化超时文案"，而是把子代理**已经付过钱的**四类信息捞回来：
 * 已改动文件清单 / 已确认的关键结论 / 未完成部分 / 建议的下一步。
 *
 * ## 为什么收集器活在 sub-agent.ts 这一层，而不在 agentic-loop.ts 里
 *
 * `runAgentLoop` 的 `onTurnEnd` 回调在**工具执行之后**触发，且携带本轮工具名 + 入参
 * （`agentic-loop.ts` 的 `turnToolInfo`）。这已经够拼出全部四类信息，无需改动共享循环的
 * 契约——共享循环被主路径与两条子代理路径同时消费，往里加字段的成本和风险都更高。
 *
 * ## 一条硬约束：残卷是**追加**，绝不替换
 *
 * `buildSalvageOutput` 把子代理自己的最后文本输出（`finalText`）放在**最前面**原样保留，
 * 残卷各段附在其后。任何"没拿到 finalText 就只输出残卷"的改法都会重新引入本缺陷的
 * 一半——模型的自然语言结论往往比机械清单更有信息量。
 *
 * ## `<progress>` 的 token 口径（2026-10-14，卡 D1）
 *
 * 旧版只有一个 `tokens="N"`，口径不明（实为 input + output 之和，不含 cache）。
 * 现在调用方给得出 `usage` 时显式输出 `input / output / cache_read / cache_creation`；
 * 给不出（runAgentLoop 抛异常、spawn 子进程）时输出 `input_output_tokens`——
 * 属性名本身写明口径，绝不再出现无口径的单个数字。
 *
 * ## 失败归因（卡 D1）
 *
 * 事故 20261014-110202：三个子代理真正的死因是「休眠断网 → 漏斗放弃」，残卷却说
 * 「达到墙钟预算」「停在读懂上下文」「检查模型是否可用」——三句全错。根因是判据只有
 * `detached || hardKilled`。归因统一走 {@link classifySubAgentFailure}，四处调用点共用。
 *
 * ## PR-B（2026-10-17）：「到点」类成因整体删除
 *
 * 子代理不再有墙钟 / 硬 kill（对齐 CC），`detached` / `timeout` 两种 reason 与对应文案
 * 随之删除。剩下的成因只有：被中止（ESC / task_stop / 父代理取消）与出错（重试耗尽 /
 * 模型报错），残卷写的永远是**实际开枪的那一层**。⛔ 别为兼容旧文案加回「墙钟」字样。
 */

/** 一次工具调用的极简记录（只留残卷需要的字段）。 */
interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

/**
 * 判定「这次工具调用改动了文件系统」并抽出目标路径。
 *
 * 与 `types.ts` 的 `jitAffectedPaths` 自报机制**刻意不复用**：那个字段回答的是
 * "本次调用触达了哪些路径"（含只读的 read/grep/glob，用于注入目录规范），
 * 而残卷要回答的是"**改了**哪些文件"。把只读工具的路径也算进"已改动文件清单"，
 * 等于告诉主代理"这些文件被动过了"——是比没有清单更坏的假信息。
 *
 * 另一个不复用的现实原因：收集器只拿到工具**名 + 入参**（onTurnEnd 的形态），
 * 手里没有工具实例，调不到实例方法。
 *
 * 判据是保守的白名单（宁可漏报不可误报）：漏报只是清单短一条，误报会让主代理
 * 基于"某文件已改"这个假前提继续往下做。
 */
const MUTATING_TOOLS = new Set(["write", "edit", "notebook_edit", "multi_edit"]);

function extractMutatedPath(rec: ToolCallRecord): string | undefined {
  if (!MUTATING_TOOLS.has(rec.name)) return undefined;
  const input = rec.input ?? {};
  const p = input.file_path ?? input.path ?? input.notebook_path;
  return typeof p === "string" && p.trim() !== "" ? p : undefined;
}

/** 残卷收集器可累积的一次「轮次快照」。形态刻意与 onTurnEnd 的 info 对齐。 */
export interface SalvageTurnInfo {
  turn: number;
  textOutput: string;
  tools: ToolCallRecord[];
  tokenCount: number;
  toolUseCount: number;
}

/** 已积累的残卷素材（只读视图，供格式化与测试断言）。 */
export interface SalvageSnapshot {
  /** 已改动文件清单（去重，保持首次改动顺序）。 */
  changedFiles: string[];
  /** 子代理逐轮产出的文本结论（保序，已剔除空串）。 */
  findings: string[];
  /** 最后一次工具活动（`工具名(关键入参)` 形态），用于说明"卡在哪一步"。 */
  lastActivity?: string;
  /** 已完成轮次。 */
  turns: number;
  /** 已发生的工具调用次数。 */
  toolUseCount: number;
  /** 累计真实 token 数（input + output 之和，来自 totalUsage）。 */
  tokenCount: number;
}

/**
 * 残卷收集器：喂 `onTurnEnd` 的每轮快照，随时可导出 `SalvageSnapshot`。
 *
 * 无状态依赖、不落盘、不抛异常——它挂在子代理执行的关键路径上，任何异常都会
 * 变成"子代理白跑一场"，所以这里的每个方法都必须是无脑安全的。
 */
export class SalvageCollector {
  private readonly changed: string[] = [];
  private readonly changedSeen = new Set<string>();
  private readonly findings: string[] = [];
  private lastActivity?: string;
  private turns = 0;
  private toolUseCount = 0;
  private tokenCount = 0;

  /** 记录一轮。重复 turn 号不去重——调用方（onTurnEnd）本就每轮只调一次。 */
  recordTurn(info: SalvageTurnInfo): void {
    this.turns = Math.max(this.turns, info.turn ?? 0);
    this.toolUseCount = info.toolUseCount ?? this.toolUseCount;
    this.tokenCount = info.tokenCount ?? this.tokenCount;

    const text = (info.textOutput ?? "").trim();
    // 只收非空且与上一条不同的文本：agentic-loop 的 lastTextOutput 跨轮沿用（本轮无
    // 文本时保持上一轮的值），不去重会把同一段结论抄进残卷 N 遍，挤掉真正的新信息。
    if (text !== "" && this.findings[this.findings.length - 1] !== text) {
      this.findings.push(text);
    }

    for (const rec of info.tools ?? []) {
      if (!rec?.name) continue;
      const path = extractMutatedPath(rec);
      if (path !== undefined && !this.changedSeen.has(path)) {
        this.changedSeen.add(path);
        this.changed.push(path);
      }
      this.lastActivity = describeCall(rec);
    }
  }

  snapshot(): SalvageSnapshot {
    return {
      changedFiles: [...this.changed],
      findings: [...this.findings],
      lastActivity: this.lastActivity,
      turns: this.turns,
      toolUseCount: this.toolUseCount,
      tokenCount: this.tokenCount,
    };
  }
}

/** `工具名(关键入参)` 单行描述。入参截断到 120 字符——残卷是给模型读的摘要，不是 transcript。 */
function describeCall(rec: ToolCallRecord): string {
  const input = rec.input ?? {};
  const key =
    input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query ?? undefined;
  if (typeof key === "string" && key.trim() !== "") {
    const short = key.length > 120 ? `${key.slice(0, 120)}…` : key;
    return `${rec.name}: ${short}`;
  }
  return rec.name;
}

/** 残卷的中断成因——决定文案里"为什么停下"和"建议的下一步"怎么写。 */
export type SalvageReason =
  /** 用户 / 父代理主动中止（ESC / task_stop / 父代理取消）。 */
  | "aborted"
  /** 执行抛异常。 */
  | "error";

/** 失败的具体成因族（决定建议怎么写）。 */
export type FailureCause = "network" | "rate_limit" | "auth" | "context_overflow" | "unknown";

/** 漏斗最后一次 `recovery_give_up` 的结构化证据（由 runAgentLoop 结果带出）。 */
export interface SubAgentGiveUpEvidence {
  /** `GiveUpReason`：budget / same_fingerprint / deadline / … */
  giveUpReason: string;
  /** `ErrorFamily`：transient / auth_suspect / request_suspect / local_fault */
  family?: string;
  /** 本次调用总尝试次数 */
  attempts?: number;
  /** 最后一次错误原文（截断） */
  lastError?: string;
}

export interface FailureClassInput {
  /** 用户 / 父代理 abort（外层 signal） */
  parentAborted: boolean;
  /** 漏斗放弃证据；有它就说明「真正的死因」已知 */
  giveUp?: SubAgentGiveUpEvidence;
  /** 最后一次重试的分类原因（`retry` 遥测的 reopenReason） */
  lastRetryReason?: string;
  /** runAgentLoop 的 errorMessage 或 catch 到的异常消息 */
  errorMessage?: string;
}

export interface FailureClass {
  reason: SalvageReason;
  /** 只在 reason="error" 时有意义 */
  cause?: FailureCause;
}

/**
 * 子代理失败归因（四处调用点唯一入口）。
 *
 * 优先级：外层 abort > **漏斗放弃证据** > 其他错误。
 * PR-B 之前还有「硬 kill」「墙钟到点」两档（事故 20261016-222758 的文案就是被它们带偏的），
 * 计时器删除后这两档没有了触发源，一并删除。
 */
export function classifySubAgentFailure(i: FailureClassInput): FailureClass {
  if (i.parentAborted) return { reason: "aborted" };
  if (i.giveUp) {
    return {
      reason: "error",
      cause: inferFailureCause(
        i.giveUp.family,
        i.lastRetryReason,
        i.giveUp.lastError ?? i.errorMessage,
      ),
    };
  }
  return {
    reason: "error",
    cause: inferFailureCause(undefined, i.lastRetryReason, i.errorMessage),
  };
}

/** 错误族 → 建议族。结构化字段优先，文本只做兜底（文本措辞各网关不一）。 */
export function inferFailureCause(
  family: string | undefined,
  reason: string | undefined,
  message: string | undefined,
): FailureCause {
  const r = reason ?? "";
  const m = message ?? "";
  if (
    r === "context_overflow" ||
    /context[_ ]?(length|window|overflow)|上下文.{0,4}(超出|溢出)/i.test(m)
  ) {
    return "context_overflow";
  }
  if (
    family === "auth_suspect" ||
    /^auth/.test(r) ||
    /\b401\b|unauthori[sz]ed|invalid.{0,10}api.?key/i.test(m)
  ) {
    return "auth";
  }
  if (
    r === "rate_limit" ||
    r === "overloaded" ||
    /\b(429|529)\b|rate.?limit|限流|负载已饱和/i.test(m)
  ) {
    return "rate_limit";
  }
  if (
    family === "transient" ||
    /network|timeout|connection/.test(r) ||
    /connection error|ECONNRESET|ETIMEDOUT|EPIPE|socket|fetch failed|network/i.test(m)
  ) {
    return "network";
  }
  return "unknown";
}

/** 残卷 token 口径（见模块头注释）。 */
export interface SalvageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface BuildSalvageOptions {
  reason: SalvageReason;
  /** reason="error" 时的成因族（来自 classifySubAgentFailure），决定建议的写法。 */
  cause?: FailureCause;
  /** 本次 LLM 重试次数（网络类建议里要说「已重试 N 次」）。 */
  retryAttempts?: number;
  /** 子代理生命周期内的系统休眠时长（毫秒）；>0 时追加休眠说明。 */
  sleptMs?: number;
  /** 只读类子代理（explore / plan 等）：零改动是必然的，不构成「停在读懂上下文」的信号。 */
  readOnlyAgent?: boolean;
  /** 显式 token 口径；缺省时退回 snap.tokenCount（input+output 之和）。 */
  usage?: SalvageUsage;
  /** 子代理自己的最终文本输出（**必须原样保留在最前**，见模块头注释的硬约束）。 */
  finalText?: string;
  /** 底层错误/中断消息（`reason: "error"` 时的真实原因，禁止丢弃）。 */
  errorMessage?: string;
  /** 任务 id（追溯用）。 */
  taskId?: string;
  /** 完整输出的落盘路径（残卷是摘要，超长内容在这里）。
   *  E1：优先是 sidechain transcript（不会被驱逐），不是 `tasks/*.output`。 */
  outputFile?: string;
  /** E1：父会话 id。残卷被贴进别的会话后，靠它追溯回父会话轨迹。 */
  parentSessionId?: string;
}

/** 单段结论的截断上限。残卷整体要能塞进主代理上下文，逐条封顶比整体截断更保信息密度。 */
const FINDING_MAX_CHARS = 2000;
/** 结论段最多保留几条（取**最后** N 条：越晚的结论越接近最终答案）。 */
const FINDING_MAX_ITEMS = 6;
/** 已改动文件清单上限（超出只报计数，避免几百个文件把残卷冲成噪音）。 */
const CHANGED_FILES_MAX_ITEMS = 50;

/**
 * 把残卷素材拼成交给主代理的结构化文本。
 *
 * 结构对齐 §1.5(b) 要求的四段：已改动文件清单 / 已确认的关键结论 / 未完成部分 /
 * 建议的下一步。用 XML 段而非 markdown 标题：主代理侧已有 `<subagent-result>` /
 * `<task-notification>` 的 XML 消费习惯，同构最省解析心智。
 */
export function buildSalvageOutput(snap: SalvageSnapshot, opts: BuildSalvageOptions): string {
  const parts: string[] = [];

  // ① 子代理自己的结论**原样置顶**。这是"绝不替换 finalOutput"这条硬约束的落点。
  const finalText = (opts.finalText ?? "").trim();
  if (finalText !== "") parts.push(finalText, "");

  parts.push("<partial-result>");
  parts.push(`  <interrupted-because>${describeReason(opts)}</interrupted-because>`);
  parts.push(
    `  <progress turns="${snap.turns}" tool_uses="${snap.toolUseCount}" ${tokenAttrs(snap, opts)}/>`,
  );
  const sleepNote = describeSubAgentSleep(opts.sleptMs);
  if (sleepNote) parts.push(`  <host-sleep>${sleepNote}</host-sleep>`);

  // ② 已改动文件清单——验收断言直接看这一段（"包含已改动文件清单而非只有一句超时"）。
  if (snap.changedFiles.length > 0) {
    const shown = snap.changedFiles.slice(0, CHANGED_FILES_MAX_ITEMS);
    const omitted = snap.changedFiles.length - shown.length;
    parts.push(`  <changed-files count="${snap.changedFiles.length}">`);
    for (const f of shown) parts.push(`    <file>${f}</file>`);
    if (omitted > 0) parts.push(`    <omitted>${omitted} 个文件未列出</omitted>`);
    parts.push("  </changed-files>");
  } else {
    // 显式说"没改文件"而不是省略这一段：主代理需要能区分「没改」与「不知道改没改」。
    parts.push(`  <changed-files count="0"/>`);
  }

  // ③ 已确认的关键结论。取最后 N 条，逐条封顶。
  if (snap.findings.length > 0) {
    const shown = snap.findings.slice(-FINDING_MAX_ITEMS);
    parts.push(`  <findings count="${snap.findings.length}">`);
    for (const f of shown) {
      const short = f.length > FINDING_MAX_CHARS ? `${f.slice(0, FINDING_MAX_CHARS)}…[截断]` : f;
      parts.push(`    <finding>${short}</finding>`);
    }
    parts.push("  </findings>");
  }

  // ④ 未完成部分：最后停在哪一步。这是"它连编辑阶段都没进去"这类判断的唯一依据。
  parts.push("  <incomplete>");
  parts.push(
    snap.lastActivity
      ? `    最后一步停在：${snap.lastActivity}`
      : "    尚未产生任何工具调用，子代理很可能连首轮响应都没拿到。",
  );
  parts.push("  </incomplete>");

  // ⑤ 建议的下一步——按成因给**可执行**的动作，不是训话。
  parts.push("  <next-step>");
  for (const line of suggestNextSteps(snap, opts)) parts.push(`    ${line}`);
  parts.push("  </next-step>");

  if (opts.outputFile) parts.push(`  <output-file>${opts.outputFile}</output-file>`);
  if (opts.parentSessionId)
    parts.push(`  <parent-session>${opts.parentSessionId}</parent-session>`);
  parts.push("</partial-result>");

  return parts.join("\n");
}

function tokenAttrs(snap: SalvageSnapshot, opts: BuildSalvageOptions): string {
  const u = opts.usage;
  if (!u) return `input_output_tokens="${snap.tokenCount}"`;
  return (
    `input="${u.inputTokens}" output="${u.outputTokens}" ` +
    `cache_read="${u.cacheReadInputTokens ?? 0}" cache_creation="${u.cacheCreationInputTokens ?? 0}"`
  );
}

/** 休眠说明（给人读）。休眠导致的断网在用户眼里和网关故障一模一样，不说清楚就会去查不存在的故障。 */
export function describeSubAgentSleep(sleptMs: number | undefined): string | null {
  if (!sleptMs || sleptMs <= 0) return null;
  const sec = Math.round(sleptMs / 1000);
  const dur = sec >= 120 ? `约 ${Math.round(sec / 60)} 分钟（${sec}s）` : `${sec}s`;
  return `期间系统休眠 ${dur}，休眠会断开网络连接，这不是网关或模型故障`;
}

function describeReason(opts: BuildSalvageOptions): string {
  switch (opts.reason) {
    case "aborted":
      return "被主动中止。以下是中止前已完成的成果。";
    case "error":
      // 真实错误消息**必须**带上：把它替换成"执行异常"正是历史上「限流误报成超时」那类
      // 错误归因缺陷的同型病灶（见 sub-agent.ts formatRetryHint 的注释）。
      return `执行出错${opts.errorMessage ? `：${opts.errorMessage}` : ""}。以下是出错前已完成的成果。`;
  }
}

function suggestNextSteps(snap: SalvageSnapshot, opts: BuildSalvageOptions): string[] {
  const lines: string[] = [];

  if (snap.changedFiles.length > 0) {
    lines.push(
      `上面 ${snap.changedFiles.length} 个文件的改动**已经落盘生效**，不要重做；先核对它们的当前内容再决定后续。`,
    );
  }

  // D1：已知具体成因 → 按错误族给建议，不再猜「模型不可用」「读懂上下文」。
  const knownCause =
    opts.reason === "error" && opts.cause !== undefined && opts.cause !== "unknown";
  if (knownCause) {
    const n = opts.retryAttempts ?? 0;
    switch (opts.cause) {
      case "network":
        lines.push(
          `网络连接中断${n > 0 ? `，已重试 ${n} 次` : ""}。可直接重派同一任务，无需改 prompt。`,
        );
        break;
      case "rate_limit":
        lines.push("上游限流，稍后重试同一任务即可。");
        break;
      case "auth":
        lines.push("认证失败，检查凭证（API Key / 网关令牌）后重试。");
        break;
      case "context_overflow":
        lines.push("上下文超出模型窗口，缩小任务范围（拆成更小的子任务）后重派。");
        break;
    }
    const sleepNote = describeSubAgentSleep(opts.sleptMs);
    if (sleepNote) lines.push(`${sleepNote}。`);
  } else if (snap.turns === 0) {
    lines.push(
      "子代理零轮产出，属于起步即失败（模型不可用/限流/参数错误的可能性大于任务太难）。重派前先确认模型可用。",
    );
  } else if (
    snap.changedFiles.length === 0 &&
    opts.reason === "aborted" &&
    opts.readOnlyAgent !== true
  ) {
    // 只在「被中止 + 无更具体原因 + 非只读类」时给：只读类零改动是必然的，不是信号。
    // PR-B 前这条挂在墙钟到点上；墙钟删除后，跑了多轮仍零改动而被用户中止是同一信号。
    lines.push(
      "子代理跑了多轮但未改动任何文件，说明它停在「读懂上下文」阶段。重派时请把已确认的结论直接写进 prompt（省掉重新探索），并把范围缩到单一具体目标。",
    );
  }

  if (lines.length === 0) {
    lines.push(
      "按上面的结论继续；如需补全未完成部分，请把已有结论写进新的子任务 prompt 以免重复探索。",
    );
  }
  return lines;
}
