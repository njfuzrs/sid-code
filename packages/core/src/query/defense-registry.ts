/**
 * 防线注册表（方案 T4，2026-10-30）
 *
 * ## 为什么要有它
 *
 * 主循环里的防线（续跑闸门、注入提醒、熔断、如实收尾）此前散在 `loop.ts` 各分支，
 * 「补的是哪个短板、还在不在起作用、什么时候能拆」只能读代码一条条判。本文件把这三问
 * 落成一张**测试读得到**的常量表，由 `tests/query/defense-registry-complete.test.ts` 保证：
 *
 * - 三个锚点（`ContinueReason` / `DoneIncompleteReason` / `query/` 内发射的 trace 事件名）
 *   的每个成员都必须分类：要么指向一道防线，要么写明「不是防线」的理由。**不开白名单**。
 * - 字段内容不能撒谎：`metricSource` 必须能解析到真实发射点、`toggle.env` 必须真被读取、
 *   `cap` 与 `CONTINUE_STREAK_CAPS` 双向一致、`retireWhen` 只有 D 类可写「零触发」。
 *
 * 键完备性交给 tsc（`Record` 漏一项编译不过），门禁只管内容。
 *
 * ## `triage` 取值
 *
 * A/B/C/D 沿用 T2 零触发分诊的四类（A 埋点晚于窗口 / B 前置条件没出现 / C 默认关闭 /
 * D 前置条件出现过、防线自己判了不触发）。T2 只分诊了零触发的那批，所以另加两类：
 * `active` = 本地轨迹里已有触发（不是拆除候选）；`untriaged` = 零触发但 T2 没覆盖到，
 * **不能**当拆除证据，要先过一遍 T2 的判据。
 *
 * ⚠️ B 类的「零」是「没人用」，不是「用不上」。`retireWhen` 写成「零触发 N 天」会把前者
 * 算成后者，所以门禁只许 D 类这么写。
 *
 * ## 不在这里的东西
 *
 * - `CONTINUE_STREAK_CAPS` 的数字不搬进来（`cap.kind: "streak"` 只做引用），那张表刻意 Partial。
 * - 「谁中断谁」（`interrupts`）与闸门顺序敏感性留给 T9，现在填只能猜。
 */
import type { ContinueReason, DoneIncompleteReason, LOOP_STATE_FLAG_KIND } from "./types.ts";
import type { ExhaustibleGate } from "./gate-exhaustion.ts";

export type DefenseTriage = "A" | "B" | "C" | "D" | "active" | "untriaged";

/** 封顶方式（判别联合）。数字一律不在这里重写，只写去哪里取。 */
export type DefenseCap =
  /** 封顶值在 `CONTINUE_STREAK_CAPS`（transition.ts） */
  | { kind: "streak" }
  /** one-shot 标志，必须是 `LOOP_STATE_FLAG_KIND` 里 `set_only` 的键 */
  | { kind: "flag"; field: keyof typeof LOOP_STATE_FLAG_KIND }
  /** 导出的常量：`query/<module>` 必须导出名为 `name` 的 number */
  | { kind: "constant"; module: string; name: string }
  /** 可配置 */
  | { kind: "config"; key: string }
  /** 递减收益、用户授权、只告警等本来就没有固定上限 */
  | { kind: "none"; reason: string };

export type DefenseToggle =
  /** `env`：源码里真被读取的环境变量；`setting`：`config/settings/types.ts` 里的 settings 键 */
  { env?: string[]; setting?: string } | { none: string };

/** 触发率取数口径。`none` 本身就是发现：这道防线触发了也看不到。 */
export type DefenseMetricSource =
  | { event: string }
  | { transition: ContinueReason["type"] }
  | { none: string };

export interface DefenseDef {
  /** 补的是模型哪个短板，或环境哪个不可靠点 */
  assumption: string;
  /**
   * 触发它的会话 id / 事故（方案里叫 `origin`）；摘不出来写 `unknown`（`unknown` 本身是 T8 的输入）。
   * ⚠️ 不叫 `origin`：`context/internal-message-sentinel.test.ts` 把源码里所有
   * 「origin 冒号 + 字符串字面量」都当成内部消息来源标记去对白名单。
   */
  incident: string;
  cap: DefenseCap;
  /** 对应的可耗尽闸门；耗尽效果从 `GATE_EXHAUSTION_EFFECT[gate]` 派生，不另写 */
  gate: ExhaustibleGate | null;
  /** 用户授权续跑（`+500k` / `/goal`），`GATE_EXHAUSTION_EFFECT` 枚举里缺的第三类 */
  authorizedByUser: boolean;
  /** 是否位于 end_turn 闸门链（digest 的 `GATE_CONTINUE_TYPES` 由此派生） */
  endTurnChain: boolean;
  toggle: DefenseToggle;
  metricSource: DefenseMetricSource;
  triage: DefenseTriage;
  /** B 类必填：前置条件出现的取数口径 */
  precondition?: string;
  /** 什么时候能拆。只有 D 类可以写「零触发 N 天」 */
  retireWhen: string;
}

/** 锚点条目：要么指向一道防线，要么写明不是防线的理由 */
export type DefenseAnchor<Id extends string = DefenseId> =
  | { defenseId: Id }
  | { notDefenseReason: string };

const NO_TOGGLE = { none: "无开关，常开" } as const;

/** 防线定义（每道只写一次，锚点用 id 指过来） */
export const DEFENSES = {
  stop_hook: {
    assumption:
      "模型自称完成但 lint / test 仍红：用户配置的 Stop Hook 给出 blocking error 后注入修复",
    incident: "unknown",
    cap: { kind: "streak" },
    gate: "stop_hook",
    authorizedByUser: false,
    endTurnChain: true,
    toggle: { setting: "hooks" },
    metricSource: { transition: "stop_hook_retry" },
    triage: "B",
    precondition: "settings（用户级 + 项目级）的 `hooks` 里配置了 Stop 条目的会话数 > 0",
    retireWhen: "不拆：用户配置的 hook 是产品功能，不是对模型短板的补丁",
  },
  unanswered: {
    assumption: "模型 end_turn 却没给出任何答复（空文本 / 只有思考 / 未解析的工具调用）",
    incident: "unknown",
    cap: { kind: "streak" },
    gate: "unanswered",
    authorizedByUser: false,
    endTurnChain: true,
    toggle: NO_TOGGLE,
    metricSource: { transition: "unanswered_retry" },
    triage: "active",
    retireWhen: "按模型拆开后某模型 UnansweredEndTurn 长期为 0，只对该模型关（不全局拆）",
  },
  promise_nudge: {
    assumption: "工具后紧跟一句短承诺（「我来改一下」）就 end_turn，说了不做",
    incident: "20261016-124310-ebff882b",
    cap: { kind: "streak" },
    gate: "promise_nudge",
    authorizedByUser: false,
    endTurnChain: true,
    toggle: { env: ["SID_DISABLE_PROMISE_NUDGE"] },
    metricSource: { event: "PromiseNudge" },
    triage: "D",
    retireWhen:
      "EndTurnShape=short_after_tools 持续出现、PromiseNudge fired 零触发 30 天 → 进 T8 关闭 A/B",
  },
  todo_gate: {
    assumption: "清单还有未完成项就 end_turn（长任务做一半停下）",
    incident: "20261005-233851-9b91e1b7",
    cap: { kind: "streak" },
    gate: "todo",
    authorizedByUser: false,
    endTurnChain: true,
    toggle: NO_TOGGLE,
    metricSource: { transition: "todo_gate_retry" },
    triage: "active",
    retireWhen: "T8 关闭 A/B 显示完成率不降",
  },
  hypothesis_gate: {
    assumption: "把未裁决 / 已被推翻的假设当结论交付",
    incident: "unknown",
    cap: { kind: "streak" },
    gate: "hypothesis",
    authorizedByUser: false,
    endTurnChain: true,
    toggle: { env: ["SID_ENABLE_HYPOTHESIS"] },
    metricSource: { transition: "hypothesis_gate_retry" },
    triage: "B",
    precondition:
      "PreToolUse 里 hypothesis_register 调用次数 > 0（机制默认关，需 SID_ENABLE_HYPOTHESIS=1）",
    retireWhen: "开启该机制的会话里 A/B 无准确率收益（2026-08-01 的 A/B 已据此默认关闭）",
  },
  empty_param: {
    assumption: "大上下文下模型声明 tool_use 但参数填空（DeepSeek v4-pro ~80k input 实测）",
    incident: "unknown",
    cap: { kind: "streak" },
    gate: "empty_param",
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { transition: "empty_param_retry" },
    triage: "active",
    retireWhen: "按模型拆开后某模型 EmptyParamRetry 长期为 0，只对该模型关",
  },
  context_window_recovery: {
    assumption: "输入撑满模型窗口（model_context_window_exceeded），压缩后可续写",
    incident: "unknown",
    cap: { kind: "streak" },
    gate: "context_window",
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { transition: "context_window_recovery" },
    triage: "B",
    precondition: "AfterModelRaw 原始 stop_reason=model_context_window_exceeded 的次数 > 0",
    retireWhen: "不拆：环境硬上限，没有它就是直接失败",
  },
  reactive_compact: {
    assumption: "流式阶段撞 prompt-too-long，压一次可救回",
    incident: "unknown",
    cap: { kind: "streak" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { transition: "reactive_compact" },
    triage: "active",
    retireWhen: "不拆：环境硬上限",
  },
  context_overflow_retry: {
    assumption: "prompt-too-long 兜底：响应式压缩失败后 autoCompact 再重试",
    incident: "unknown",
    cap: { kind: "flag", field: "compactCircuitOpen" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { transition: "context_overflow_retry" },
    triage: "active",
    retireWhen: "不拆：环境硬上限",
  },
  compact_circuit: {
    assumption: "同一段历史压不动时每轮重试会烧掉数千次调用（CC 前车之鉴）",
    incident: "unknown",
    cap: { kind: "flag", field: "compactCircuitOpen" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { event: "CompactionCircuitBreaker" },
    triage: "A",
    retireWhen: "等数据：10-29 才上线，攒够窗口再判",
  },
  timeout_retry: {
    assumption: "网关抖动 / 厂商限流导致流超时，退避重试可恢复",
    incident: "unknown",
    cap: { kind: "config", key: "networkProfile.maxTimeoutRetries" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { transition: "timeout_retry" },
    triage: "active",
    retireWhen: "不拆：环境不可靠点",
  },
  max_tokens_recovery: {
    assumption: "输出撞 max_tokens 被截断，续写 / 提额可接上",
    incident: "unknown",
    cap: { kind: "none", reason: "递减收益检测 + diminishingReturnsHandoffDone 让手一次后终止" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { transition: "max_tokens_continuation" },
    triage: "B",
    precondition: "AfterModelRaw 原始 stop_reason=max_tokens 的次数 > 0",
    retireWhen: "不拆：环境硬上限",
  },
  loop_recovery: {
    assumption: "模型重复同一工具调用原地打转",
    incident: "unknown",
    cap: { kind: "none", reason: "检测器内部计数 + 软重置，无固定常量" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: { env: ["SID_ENABLE_LOOP_DETECTION"] },
    metricSource: { transition: "loop_recovery" },
    triage: "C",
    retireWhen: "已默认关闭；T8 改问「deepseek 臂上要不要默认打开」",
  },
  goal: {
    assumption: "用户 /goal 授权持续推进，由评估者判断目标是否达成",
    incident: "unknown",
    cap: { kind: "none", reason: "用户授权：按预算 / 递减收益 / 评估者 / 轮数终止" },
    gate: null,
    authorizedByUser: true,
    endTurnChain: true,
    toggle: { none: "由用户 /goal 显式开启" },
    metricSource: { event: "GoalGateDecision" },
    triage: "B",
    precondition: "UserPromptSubmit 以 /goal 开头的条数 > 0",
    retireWhen: "不拆：用户授权的产品功能",
  },
  token_budget: {
    assumption: "用户 `+500k` 授权按 token 预算继续",
    incident: "unknown",
    cap: { kind: "none", reason: "用户授权：按预算与递减收益终止" },
    gate: null,
    authorizedByUser: true,
    endTurnChain: true,
    toggle: { none: "由用户消息里的 +Nk 指令开启" },
    metricSource: { transition: "token_budget_continuation" },
    triage: "B",
    precondition: "UserPromptSubmit 中能被 parseTokenBudgetDirective 解析的条数 > 0",
    retireWhen: "不拆：用户授权的产品功能",
  },
  stall_escalation: {
    assumption: "长任务原地打转（反复改回、无新进展），到顶的提醒只会沉默",
    incident: "20261020-110542-ce7ea52e",
    cap: { kind: "flag", field: "stallStopRequested" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: {
      env: ["SID_CODE_STALL_ESCALATION", "SID_CODE_STALL_HARD_STOP"],
      setting: "stallHardStop",
    },
    metricSource: { event: "StallEscalation" },
    triage: "active",
    retireWhen: "L2 影子期抽检误报率决定 stallHardStop 默认值（T7）",
  },
  no_progress_nag: {
    assumption: "模型做了一半不更新清单 / 工作日志，靠工作记忆追踪必然遗漏",
    incident: "20260707-155324-1fb62e56",
    cap: {
      kind: "none",
      reason: "todo 通道无进展时永不封顶（催干活是主功能）；work-log 通道封顶 MAX_NO_PROGRESS_NAGS",
    },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { event: "NoProgressNagInjected" },
    triage: "active",
    retireWhen: "T8 关闭 A/B 显示完成率不降",
  },
  repeated_readonly_guard: {
    assumption: "冻结的 git-status 快照让模型反复跑只读命令确认（死锁）",
    incident: "20260710-164407",
    cap: { kind: "constant", module: "repeated-readonly-guard.ts", name: "MAX_STUCK_REMINDERS" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { event: "RepeatedReadonlyGuardTriggered" },
    triage: "untriaged",
    retireWhen: "先过 T2 判据：git-status 刷新修复后前置形态是否还出现",
  },
  low_yield_spin: {
    assumption: "反复跑同参同返回值的单标量命令（`grep -c` / `wc -l`）空转",
    incident: "20260810-214525-2df54593",
    cap: { kind: "constant", module: "low-yield-spin.ts", name: "MAX_LOW_YIELD_INTERVENTIONS" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { event: "LowYieldSpinIntervened" },
    triage: "untriaged",
    retireWhen: "先过 T2 判据：前置形态（连续同参单标量命令）是否出现过",
  },
  unchanged_observation: {
    assumption: "同指纹同返回值重复调用，重复劳动未产出新信息",
    incident: "unknown",
    cap: { kind: "none", reason: "只告警不干预，没有注入可封顶" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { event: "UnchangedObservationRun" },
    triage: "active",
    retireWhen: "影子数据判定误报率后决定升级为干预或删除",
  },
  todo_rework: {
    assumption: "清单提前标 completed、返工时没改回来，状态不实时",
    incident: "20261005-233851-9b91e1b7",
    cap: { kind: "none", reason: "同一 (项, 文件) 只提醒一次，按对去重而不是按次数封顶" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { event: "TodoReworkDetected" },
    triage: "active",
    retireWhen: "T8 关闭 A/B",
  },
  hypothesis_guide: {
    assumption: "调查性任务里模型形成判断却不登记假设",
    incident: "unknown",
    cap: { kind: "flag", field: "hypothesisGuideInjected" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: { env: ["SID_ENABLE_HYPOTHESIS"] },
    metricSource: { event: "HypothesisGuideInjected" },
    triage: "C",
    retireWhen: "随 hypothesis 机制整体去留",
  },
  stop_reason_mismatch: {
    assumption: "provider 声称 end_turn 但 content 含 tool_use（协议偏差），兜底照常执行工具",
    incident: "unknown",
    cap: { kind: "none", reason: "协议兜底，每次都执行，不注入" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: NO_TOGGLE,
    metricSource: { event: "StopReasonMismatch" },
    triage: "untriaged",
    retireWhen: "不拆：环境不可靠点，没触发只说明当前 provider 合规",
  },
  thinking_divergence: {
    assumption: "思考量雪崩（单调激增）= 分析瘫痪",
    incident: "20260728-173546",
    cap: {
      kind: "constant",
      module: "thinking-divergence.ts",
      name: "MAX_THINKING_DIVERGENCE_INTERVENTIONS",
    },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: { env: ["SID_ENABLE_THINKING_DIVERGENCE", "SID_ENABLE_LOOP_DETECTION"] },
    metricSource: { none: "只有 log.warn，没有 trace 事件" },
    triage: "C",
    retireWhen: "已默认关闭；要评估先补埋点",
  },
  output_stall: {
    assumption: "产出量持续很低（diminishing returns），模型原地打转",
    incident: "unknown",
    cap: { kind: "constant", module: "output-stall.ts", name: "MAX_OUTPUT_STALL_INTERVENTIONS" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: { env: ["SID_ENABLE_OUTPUT_STALL", "SID_ENABLE_LOOP_DETECTION"] },
    metricSource: { none: "只有 log.info，没有 trace 事件" },
    triage: "C",
    retireWhen: "已默认关闭；要评估先补埋点",
  },
  soft_turn_limit: {
    assumption: "交互模式 maxTurns=Infinity 下模型完全没有自省信号",
    incident: "unknown",
    cap: { kind: "flag", field: "softTurnLimitReminded" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: { env: ["SID_MAX_TURNS"] },
    metricSource: { none: "只有 log.info，没有 trace 事件" },
    triage: "C",
    retireWhen: "已默认关闭；要评估先补埋点",
  },
  edit_failure_reminder: {
    assumption: "弱模型对同一文件反复编辑失败（old_string 找不到）后原样再试",
    incident: "unknown",
    cap: { kind: "none", reason: "按连续失败次数阈值提醒，无注入次数上限常量" },
    gate: null,
    authorizedByUser: false,
    endTurnChain: false,
    toggle: { env: ["SID_DISABLE_EDIT_FAILURE_REMINDER", "SID_EDIT_FAILURE_REMINDER_THRESHOLD"] },
    metricSource: { none: "走 PostToolUse 回注通道，没有 trace 事件" },
    triage: "untriaged",
    retireWhen: "先补埋点再判",
  },
} as const satisfies Record<string, DefenseDef>;

export type DefenseId = keyof typeof DEFENSES;

/** 锚点 1：`ContinueReason["type"]`。顺序即 `scripts/defense-trigger-report.ts` 报告列顺序。 */
export const CONTINUE_ANCHORS: Record<ContinueReason["type"], DefenseAnchor> = {
  tool_use: { notDefenseReason: "正常续跑：模型调了工具，下一轮把结果交回去" },
  max_tokens_continuation: { defenseId: "max_tokens_recovery" },
  max_tokens_escalate: { defenseId: "max_tokens_recovery" },
  reactive_compact: { defenseId: "reactive_compact" },
  loop_recovery: { defenseId: "loop_recovery" },
  context_overflow_retry: { defenseId: "context_overflow_retry" },
  stop_hook_retry: { defenseId: "stop_hook" },
  timeout_retry: { defenseId: "timeout_retry" },
  todo_gate_retry: { defenseId: "todo_gate" },
  unanswered_retry: { defenseId: "unanswered" },
  promise_nudge: { defenseId: "promise_nudge" },
  hypothesis_gate_retry: { defenseId: "hypothesis_gate" },
  goal_gate_retry: { defenseId: "goal" },
  goal_budget_warning: { defenseId: "goal" },
  empty_param_retry: { defenseId: "empty_param" },
  token_budget_continuation: { defenseId: "token_budget" },
  context_window_recovery: { defenseId: "context_window_recovery" },
};

/** 锚点 2：`DoneIncompleteReason`（「不是正常说完」的出口）。 */
export const INCOMPLETE_ANCHORS: Record<DoneIncompleteReason, DefenseAnchor> = {
  timeout_retry_exhausted: { defenseId: "timeout_retry" },
  aborted: { notDefenseReason: "用户按 ESC 中断，是出口不是防线" },
  stalled: { defenseId: "stall_escalation" },
  context_window_exhausted: { defenseId: "context_window_recovery" },
  empty_param_exhausted: { defenseId: "empty_param" },
  empty_stream: {
    notDefenseReason: "如实收尾的出口分类：不改变循环走向，只防 SDK 把空响应映射成 success",
  },
  refusal: { notDefenseReason: "模型安全策略拒答，是出口不是防线" },
  pause_turn: { notDefenseReason: "server tool 暂停，本仓未实现续接，如实收尾" },
  unknown_stop_reason: {
    notDefenseReason:
      "如实收尾的出口分类：不改变循环走向，只防 SDK 把未识别 stop_reason 当 success",
  },
};

/**
 * 锚点 3：`packages/core/src/query/` 内发射的 trace 事件名。键集合由门禁从源码解析对账
 * （多一个、少一个都红），所以新增发射点必须到这里登记。
 */
export const EVENT_ANCHORS: Record<string, DefenseAnchor> = {
  // ─── 观测事件 ───
  TurnComplete: { notDefenseReason: "每条用户消息的收尾快照，观测事件" },
  LoopTransition: { notDefenseReason: "每次 continue 的观测事件，各防线的 transition 取数靠它" },
  CompactionAttempt: { notDefenseReason: "每次压缩的结果记录，观测事件（熔断判据的数据源）" },
  GateExhausted: {
    notDefenseReason:
      "各闸门封顶被触达的观测事件；封顶本身登记在各防线的 cap 上（T2 判 D 的是封顶是否触达）",
  },
  EndTurnShape: { notDefenseReason: "S1 L1：end_turn 形态事实，promise_nudge 的分母" },
  TodoProgressAdvanced: { notDefenseReason: "清单进展观测，todo 闸门预算复位的依据" },
  HypothesisToolUsed: { notDefenseReason: "假设工具实际调用，采纳率的分子" },
  ColdCacheClear: { notDefenseReason: "冷缓存清理，成本优化，不针对模型短板" },
  PostCompactReattach: { notDefenseReason: "压缩后重挂上下文，是压缩流程的组成步骤" },
  CompactionSkipped: { notDefenseReason: "熔断挡掉的压缩次数，compact_circuit 省下的成本口径" },
  // ─── 防线事件 ───
  CompactionCircuitBreaker: { defenseId: "compact_circuit" },
  UnansweredEndTurn: { defenseId: "unanswered" },
  PromiseNudge: { defenseId: "promise_nudge" },
  EmptyParamRetry: { defenseId: "empty_param" },
  GoalGateDecision: { defenseId: "goal" },
  StallEscalation: { defenseId: "stall_escalation" },
  NoProgressNagInjected: { defenseId: "no_progress_nag" },
  RepeatedReadonlyGuardTriggered: { defenseId: "repeated_readonly_guard" },
  LowYieldSpinIntervened: { defenseId: "low_yield_spin" },
  UnchangedObservationRun: { defenseId: "unchanged_observation" },
  TodoReworkDetected: { defenseId: "todo_rework" },
  HypothesisGuideInjected: { defenseId: "hypothesis_guide" },
  StopReasonMismatch: { defenseId: "stop_reason_mismatch" },
};

/** `ContinueReason["type"]` 全集（报告列顺序 = 锚点表声明顺序） */
export const CONTINUE_TYPES = Object.keys(CONTINUE_ANCHORS) as ContinueReason["type"][];

/**
 * end_turn 闸门链产生的 continue 理由（digest「链收尾后又被闸门续上」判据用）。
 * 从注册表派生：锚点指向的防线 `endTurnChain === true`。
 */
export const GATE_CONTINUE_TYPES: ReadonlySet<string> = new Set(
  CONTINUE_TYPES.filter((t) => {
    const a = CONTINUE_ANCHORS[t];
    return "defenseId" in a && DEFENSES[a.defenseId].endTurnChain;
  }),
);
