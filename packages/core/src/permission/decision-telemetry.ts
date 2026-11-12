/**
 * 权限决策进轨迹（B11）—— 模块级观察者，与 `tool/git-operation-tracking.ts` 同一模式。
 *
 * ## 为什么不是只靠 `analytics/events.ts` 的 permission_allow / permission_deny
 *
 * 那两条走遥测 sink（`~/.sid-code/telemetry/events.jsonl`），受隐私级别 / killswitch /
 * 采样管辖，而且**不带会话维度进 session-index**。于是北极星「更安全」那张卡上的
 * 「人工确认介入率」「确认耗时」只能标 ❌：数据有一半，但没有一条能按 release 复算的曲线。
 * 轨迹是本地数据、不外发，不该被遥测开关连带关掉。
 *
 * ## 为什么挂在 events.ts 的门面函数里而不是各调用点各调一次
 *
 * 鉴权有三条执行路径（主循环 / 子代理 / forked，见 `PermissionContext`），共 7 个
 * `logPermission*` 调用点。各自再补一行 `recordPermissionDecision` = 下一个新鉴权分支
 * 只记得其中一个，漏掉的那条路径在轨迹里永久隐身且不会有任何东西变红。
 * 挂在门面里，「发了遥测」⇔「进了轨迹」由结构保证。
 *
 * ## 观察者为什么是模块级单例
 *
 * 鉴权点（tool-executor / sub-agent / forked-agent）不持有 TraceCollector，
 * 为一个度量把 collector 穿透传参改面太大（git-operation-tracking 头注释同一理由）。
 * collector 在 `registerHooks` 时注入自己；未注入（测试 / 无轨迹模式）时静默 no-op。
 */

import type { PathMismatchShape } from "../tool/types.ts";

/** 最终判定。`ask` 不是终态：弹窗之后一定落到 allow / deny 之一，用 `prompted` 表达"问过人" */
export type PermissionOutcome = "allow" | "deny";

/**
 * 人工确认实际经由的通道。
 *
 * 为什么需要：远程接管（bridge）与 SDK 宿主（`can_use_tool`）的确认，在
 * `PermissionDecision` 里与 TUI 弹窗长得一模一样（`source=user` + `prompted=true`），
 * 于是「这条批准是坐在终端前的人点的，还是管理台上远程点的」在轨迹上分不出来 ——
 * 触发清单 A11/A12 都卡在这里。`PermissionSource` 是**外发遥测**的闭集，不能扩
 * （扩了要动后端 schema）；这个字段只进本地轨迹。
 */
export type ConfirmVia = "tui" | "bridge" | "sdk" | "headless";

export interface PermissionDecisionEvent {
  /** 工具名（本地轨迹，不脱敏；外发通道的脱敏仍由 events.ts 门面负责） */
  tool: string;
  outcome: PermissionOutcome;
  /**
   * 是否弹窗问过人。HITL 介入率的分子就是它。
   * 注意：弹窗后被 hook / classifier 抢先判定的，仍算 prompted —— 墙钟已经开始走了。
   */
  prompted: boolean;
  /** 谁做的决定：user / hook / classifier / timeout / rule / other */
  source: string;
  /**
   * 人工确认经由哪条通道（`prompted=true` 时才填）。
   * 取值由 `App.requestUserConfirmation` 按实际走的分支确定：bridge 远程代理 /
   * SDK `can_use_tool` / TUI 弹窗 / headless 自动决策。
   */
  confirmVia?: ConfirmVia;
  /**
   * 命中的规则来源：`PermissionDecisionReason.type`（rule / mode / safetyCheck / …）。
   * 固定枚举，不含规则文本与入参片段。缺省 = 决策没带 reason（checker 的若干早退放行分支）。
   */
  reasonType?: string;
  /** 执行路径：main / subagent / forked */
  context: string;
  /**
   * S10：发起这次鉴权的 fork / 子代理身份（与 StreamPhase.agent_id 同一个值，可配对）。
   * 主循环不填。必须由 fork / 子代理执行入口**显式传入**：工具执行在流的 next() 之外，
   * RequestContext 的 ALS 在这里是空的，事后从 ALS 补只会补成 undefined 或误标。
   */
  agentId?: string;
  /** 决策耗时（含等人确认的墙钟）。未测量的分支不填，**不填 0** —— 0 会被读成"秒批" */
  durationMs?: number;
  /**
   * 做出决策的管线位置（`Decision.step`：Step 编号或后处理名，固定枚举）。
   * 没有它时 reasonType 为空的那一大桶（2026-10-24 本机 22409/25933 条）分不出是
   * Step 5.5 工具放行、Step 10 只读、Step 12 预授权还是 skip 早退。
   */
  step?: string;
  /**
   * 决策时的 sid 原生权限模式（`Decision.mode`）。SessionStart 的 permission_mode 是 CC 映射值
   * （always-allow 与 skip 合并成 bypassPermissions，deny-write 记成 default），且只记一次，
   * 会话中途 Shift+Tab / enter_plan_mode 切换后就失真——逐条带上才能按模式切片。
   */
  mode?: string;
  /**
   * forked 拒绝的类别（`ForkedDenyKind`），由注入的 `canUseTool` 自己报。只进本地轨迹。
   * 不并进 reasonType：那是外发遥测的固定枚举，且语义是「哪条管线规则」，这里是「哪类越权」。
   */
  denyKind?: string;
  /** `denyKind === "path_mismatch"` 时的路径形状（只有布尔，不含路径原文） */
  pathMismatch?: PathMismatchShape;
  /**
   * 工具入参摘要（`tool/input-summary.ts` 的白名单键 + 截断）。**只进本地轨迹**。
   *
   * 目前只有 forked 路径会传：它不写 PreToolUse（见 forked-agent 顶部），
   * `PermissionDecision` 是它的工具调用唯一留痕 —— 不补这一项的话，「session-memory
   * fork 被拒的那条 bash 命令是什么」在轨迹里查不到。主循环 / 子代理不传，
   * 它们的入参已经在 `PreToolUse.input_summary` 里，同一次调用记两遍会让按字段数
   * 统计的口径翻倍。
   */
  inputSummary?: Record<string, unknown>;
  /**
   * B19：工具调用 id（`tool_use.id`），与权限审计行的 `tool_use_id` 同值。
   * 此前 6.8 万条 PermissionDecision 一条都不带，只能按「紧随 PreToolUse」的相邻关系配对，
   * 并发工具调用会错配。只进本地轨迹（遥测 payload 不加，外发 schema 不变）。
   */
  toolUseId?: string;
  /**
   * B20：危险确认是哪道结构性闸门触发的（`guardOf(decision)`，固定枚举）。
   * A2 注入校验器与 A6 展开超限在 `step` 上都是 `2`、`reasonType` 都是 dangerousCommand，
   * 此前在轨迹里不可分，校验器名只在审计 reason 文本里。只取固定标签，不取命令片段。
   */
  guard?: string;
  /**
   * A9：auto 档分类器没有放行、回退人工时的成因（absent / safety-guard / unsafe /
   * unavailable / error）。取自 `Decision.metadata.autoClassifier`，只有 auto 档的 ask 才有。
   */
  autoClassifier?: string;
  /**
   * B21：这次弹窗的生命周期观测（只有 TUI 真弹过窗才有，见 `PromptObservation`）。
   *
   * 补它之前，「弹窗显示后无人能答」只有 `duration_ms=300009 + source=timeout` 一条事实，
   * 而下面四种**完全不同**的故障在该形态上一模一样，排查只能靠 PTY 探针逐次复现：
   *   ① 弹窗根本没显示（排队中被 abort）；② 显示了但按键没到组件（handler 未订阅/焦点被吃）；
   *   ③ 按键到了、`onSelect` 也触发了，却被 `resolvedRef` 静默吞掉（#756 的根因形态）；
   *   ④ `decide` 走了，但 resolve 被 app.ts 的 `settled` 去重吞掉。
   */
  prompt?: PromptObservation;
}

/**
 * 一次确认弹窗的生命周期观测。**只进本地轨迹**：它是「这台机器上这次为什么卡住」的
 * 排障数据，不是跨会话指标的分母，不扩外发遥测 schema。
 *
 * 字段判读（配合 `duration_ms` 一起看）：
 * - `mounts === 0` → 弹窗从未挂载，落在 ①；
 * - `queue_ms` 大而 `shown_ms` 小 → 时间花在等显示权（interactionQueue 排队），不是弹窗问题；
 * - `keys === 0` 且 `shown_ms` 很大 → 按键没到组件，落在 ②；
 * - `keys_dropped > 0` → 按键到了但被 `resolvedRef` 去重吞掉，落在 ③（#756 的精确信号）；
 * - `resolve_dropped > 0` → `decide` 走了但 app 层已 `settled`，落在 ④。
 */
export interface PromptObservation {
  /** 请求产生 → 弹窗首帧挂载的排队墙钟（interactionQueue + 状态桥） */
  queueMs?: number;
  /** 弹窗首帧挂载 → 决策落定 的墙钟；缺失 = 弹窗没显示过 */
  shownMs?: number;
  /** 弹窗组件挂载次数。>1 = 发生过重挂载（换 key / 父级重建）；0 = 从未挂载 */
  mounts: number;
  /** 到达组件的按键数（handler 收到即算，含方向键与被忽略的键） */
  keys: number;
  /** 被 `resolvedRef` 去重静默吞掉的按键数（#756 形态） */
  keysDropped: number;
  /** 被 app.ts `settled` 去重吞掉的 resolve 次数 */
  resolveDropped: number;
}

let _promptObs: PromptObservation | null = null;
let _promptRequestedAt = 0;
let _promptShownAt = 0;

/**
 * 一次确认请求拿到显示权（interactionQueue 的 show 里）时调用。
 *
 * `requestedAt` 由调用方在请求产生时取（要早于排队），所以 `queue_ms` 能量的出
 * 「等了多久才轮到显示」——`duration_ms` 含这段，分不出卡在队列还是卡在弹窗。
 */
export function beginPromptObservation(requestedAt: number): void {
  _promptRequestedAt = requestedAt;
  _promptShownAt = 0;
  _promptObs = { mounts: 0, keys: 0, keysDropped: 0, resolveDropped: 0 };
}

/** 弹窗组件挂载一次（`PermissionDialog` 的 mount effect）。首帧时刻即「弹窗真的显示了」 */
export function notePromptMounted(): void {
  const obs = _promptObs;
  if (!obs) return;
  obs.mounts += 1;
  if (_promptShownAt === 0) {
    _promptShownAt = Date.now();
    obs.queueMs = _promptShownAt - _promptRequestedAt;
  }
}

/** handler 收到一个按键（`HotkeyChoiceList` 的 onKeyObserved） */
export function notePromptKey(): void {
  if (_promptObs) _promptObs.keys += 1;
}

/** 按键到了组件、但 `decide` 被 `resolvedRef` 去重吞掉 */
export function notePromptKeyDropped(): void {
  if (_promptObs) _promptObs.keysDropped += 1;
}

/** `decide` 已经调用 resolve，但被 app.ts 的 `settled` 去重吞掉 */
export function notePromptResolveDropped(): void {
  if (_promptObs) _promptObs.resolveDropped += 1;
}

/**
 * 取走本次观测并清空——一次确认对应一条决策。
 *
 * 消费即清的理由与 `consumeConfirmVia` 相同：单例会串到下一次「没弹窗」的决策上。
 * 没有正在观测的弹窗（规则直放行 / 子代理）时返回 null。
 */
export function consumePromptObservation(): PromptObservation | null {
  const obs = _promptObs;
  _promptObs = null;
  if (!obs) return null;
  if (_promptShownAt > 0) obs.shownMs = Date.now() - _promptShownAt;
  _promptShownAt = 0;
  _promptRequestedAt = 0;
  return obs;
}

/**
 * 从决策里取「哪道结构性闸门」的固定标签。只认两类有闭集来源的模式：
 * - 注入校验器：`pattern = "injection:<id>"`，id 来自 `bash-security.ts` 的校验器表；
 * - 展开超限：`pattern = "展开超限"`。
 * 其余 dangerousCommand 的 pattern 可能是 LLM 分类器的自由文本（`LLM:...`），一律不取。
 * headless / dontAsk 把 ask 落成 deny 时会覆盖 decisionReason，标签由 checker 搬到
 * `metadata.guard`（见 checker.ts `guardMetadata`），这里优先读它。
 */
export function guardOf(decision: {
  decisionReason?: { type?: string; pattern?: unknown } | null;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const carried = decision.metadata?.guard;
  if (typeof carried === "string") return carried;
  const r = decision.decisionReason;
  if (!r || r.type !== "dangerousCommand" || typeof r.pattern !== "string") return undefined;
  if (r.pattern === "展开超限") return "expansion-limit";
  const m = /^injection:([a-z0-9-]+)$/.exec(r.pattern);
  return m ? `injection:${m[1]}` : undefined;
}

/** 取 `Decision.metadata.autoClassifier`（A9）；非字符串一律视为没有 */
export function autoClassifierOf(decision: {
  metadata?: Record<string, unknown>;
}): string | undefined {
  const v = decision.metadata?.autoClassifier;
  return typeof v === "string" ? v : undefined;
}

let _observer: ((event: PermissionDecisionEvent) => void) | null = null;

/**
 * 本次确认实际经由的通道。由 `App.requestUserConfirmation` 在分支内设置。
 *
 * 为什么用进程级单值而不是参数透传：四条通道（sdk / bridge / tui / headless）的
 * 优先级在 App 里是固定的；而把值带回 core 需要改
 * `ToolExecutorDeps.requestUserConfirmation` 的返回类型（30+ 处测试实现与三条
 * 鉴权路径都受影响），代价远大于收益。
 *
 * ⚠️ 单值是 **sticky** 的，所以消费侧有两条硬约束，缺一条都会把口径记错：
 *
 * - **只在 `source === "user"` 时消费**：`needsPrompt=true` 的决策可能是
 *   classifier / hook 在弹窗期间抢先赢了（见 `tool-executor.ts` 的记录点注释），
 *   那次并**没有人真的被问**。它们的 `source` 不是 `user`，不该带这个字段；
 * - **消费即清**（`consumeConfirmVia`）：一次确认只对应一条决策。否则上一次的值
 *   会串到下一次「没人被问」的决策上——同进程多会话 / 测试复用同一进程时，
 *   这正是拿一次远程批准去污染后续本地决策的形态。
 */
let _confirmVia: ConfirmVia | null = null;

/** App 在确定本次确认走哪条通道后调用；测试收尾传 null 复位。 */
export function setConfirmVia(via: ConfirmVia | null): void {
  _confirmVia = via;
}

/**
 * 取走当前通道并清空——一次确认只消费一次。
 *
 * 只应由「确实问过用户」的那条决策调用，判据是 `source === "user"`
 * （`needsPrompt` 单独不够，见上面的注释）。
 */
export function consumeConfirmVia(): ConfirmVia | null {
  const via = _confirmVia;
  _confirmVia = null;
  return via;
}

/** collector 注入；传 null 解除（测试收尾用） */
export function setPermissionDecisionObserver(
  fn: ((event: PermissionDecisionEvent) => void) | null,
): void {
  _observer = fn;
}

/** 记一次权限决策。观察者异常一律吞掉——度量永不阻断鉴权主流程 */
export function recordPermissionDecision(event: PermissionDecisionEvent): void {
  try {
    _observer?.(event);
  } catch {
    /* 度量失败不影响主流程 */
  }
}

// ─── 命令 allowed-tools 下发（bugfixes 20261013 方案 G）───

/**
 * 一次命令 / skill 的 `allowed-tools` 被装进 commandScoped 规则源。
 * 用途：复算「声明了 allowed-tools 的命令里，有多少条规则被危险过滤剥离」
 * （辅助口径分母 = 本事件条数，分子 = `dropped` 非空的条数）。
 * 记在 RuleLoader.setCommandScopedRules 里——inline 与 fork 都经过它，结构上不会漏一条路径。
 */
export interface CommandAllowedToolsEvent {
  /** 来源标签（如 "/project-qa allowed-tools"、"命令 allowed-tools"） */
  origin: string;
  /** 声明的规则条数 */
  declared: number;
  /** 实际装入的规则（原样串） */
  rules: string[];
  /** 因来源不可信被剥离的规则 */
  dropped: string[];
  trusted: boolean;
}

let _commandObserver: ((event: CommandAllowedToolsEvent) => void) | null = null;

export function setCommandAllowedToolsObserver(
  fn: ((event: CommandAllowedToolsEvent) => void) | null,
): void {
  _commandObserver = fn;
}

export function recordCommandAllowedTools(event: CommandAllowedToolsEvent): void {
  try {
    _commandObserver?.(event);
  } catch {
    /* 度量失败不影响主流程 */
  }
}

// ─── 权限配置形态快照（2026-10-24 §4 审计 · 可观测性缺口 3）───

/**
 * 会话开始时「这个会话的权限配置长什么样」——只有计数与开关，**不含规则文本**
 * （规则串含命令片段与路径）。
 *
 * ## 为什么需要
 *
 * §4 审计发现的四类绕过，每一类的触发前提都是某种配置（有 allow 规则 / 有 deny 规则 /
 * 有 disallowedTools / 处于某个模式）。轨迹此前不记配置，于是「影响面有多大」
 * 这个问题没有分母：数不出「有规则的会话」有多少，修复前后也就无从比较暴露面。
 */
export interface PermissionConfigShape {
  /** sid 原生权限模式（会话开始时） */
  mode: string;
  skip_permissions: boolean;
  yes_mode: boolean;
  /** 按 behavior × 来源的规则条数，如 { allow: { userSettings: 2 }, deny:  } */
  rules: Record<"allow" | "deny" | "ask", Record<string, number>>;
  /** 预授权（--allowed-tools / config.allowedTools / CLAUDE.md 白名单）条数 */
  allowed_tools: number;
  disallowed_tools: number;
  sandbox_auto_allow: boolean;
}

let _configProvider: (() => PermissionConfigShape | undefined) | null = null;

/** cli 在主 checker 建好后注入；collector 在 SessionStart 读取。传 null 解除 */
export function setPermissionConfigProvider(
  fn: (() => PermissionConfigShape | undefined) | null,
): void {
  _configProvider = fn;
}

/** 读当前配置形态；未注入或取值抛错时返回 undefined（度量永不阻断主流程） */
export function readPermissionConfigShape(): PermissionConfigShape | undefined {
  try {
    return _configProvider?.() ?? undefined;
  } catch {
    return undefined;
  }
}
