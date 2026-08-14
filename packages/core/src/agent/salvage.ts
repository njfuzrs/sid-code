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
  /** 墙钟到点，已转后台继续跑（detach，不是 kill）。 */
  | "detached"
  /** 墙钟到点且无法转后台（如自定义子代理路径），已停止。 */
  | "timeout"
  /** 用户/父代理主动中止。 */
  | "aborted"
  /** 执行抛异常。 */
  | "error";

export interface BuildSalvageOptions {
  reason: SalvageReason;
  /** 子代理自己的最终文本输出（**必须原样保留在最前**，见模块头注释的硬约束）。 */
  finalText?: string;
  /** 墙钟预算（毫秒），用于文案里说明"跑了多久"。 */
  timeoutMs?: number;
  /** 底层错误/中断消息（`reason: "error"` 时的真实原因，禁止丢弃）。 */
  errorMessage?: string;
  /** detach 后可用于取回最终结果的任务 id。 */
  taskId?: string;
  /** 完整输出的落盘路径（残卷是摘要，超长内容在这里）。 */
  outputFile?: string;
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
    `  <progress turns="${snap.turns}" tool_uses="${snap.toolUseCount}" tokens="${snap.tokenCount}"/>`,
  );

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
  parts.push("</partial-result>");

  return parts.join("\n");
}

function describeReason(opts: BuildSalvageOptions): string {
  const secs = opts.timeoutMs !== undefined ? `${Math.round(opts.timeoutMs / 1000)}秒` : "预算";
  switch (opts.reason) {
    case "detached":
      return `达到前台墙钟预算 (${secs})，已转后台继续执行（未被终止）。以下是截至此刻的成果。`;
    case "timeout":
      return `达到墙钟预算 (${secs}) 并已停止。以下是截至停止时的成果。`;
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

  if (opts.reason === "detached" && opts.taskId) {
    // 给出**具体可调用的工具与参数**。只说"稍后再查"会把主代理推回轮询——正是 P1-3 修的那个病。
    lines.push(
      `子代理仍在后台运行。用 bg_task_get({ task_id: "${opts.taskId}", block: true }) 阻塞等待最终结果，`,
    );
    lines.push("不要反复以相同入参轮询状态（同参轮询会被循环检测拦下）。");
    lines.push("等待期间可以先做**不依赖**该子代理产出的部分。");
  }

  if (snap.changedFiles.length > 0) {
    lines.push(
      `上面 ${snap.changedFiles.length} 个文件的改动**已经落盘生效**，不要重做；先核对它们的当前内容再决定后续。`,
    );
  }

  if (snap.turns === 0) {
    lines.push(
      "子代理零轮产出，属于起步即失败（模型不可用/限流/参数错误的可能性大于任务太难）。重派前先确认模型可用。",
    );
  } else if (snap.changedFiles.length === 0 && opts.reason !== "detached") {
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
