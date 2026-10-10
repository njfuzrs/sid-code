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

/** 最终判定。`ask` 不是终态：弹窗之后一定落到 allow / deny 之一，用 `prompted` 表达"问过人" */
export type PermissionOutcome = "allow" | "deny";

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
   * 命中的规则来源：`PermissionDecisionReason.type`（rule / mode / safetyCheck / …）。
   * 固定枚举，不含规则文本与入参片段。缺省 = 决策没带 reason（checker 的若干早退放行分支）。
   */
  reasonType?: string;
  /** 执行路径：main / subagent / forked */
  context: string;
  /** 决策耗时（含等人确认的墙钟）。未测量的分支不填，**不填 0** —— 0 会被读成"秒批" */
  durationMs?: number;
}

let _observer: ((event: PermissionDecisionEvent) => void) | null = null;

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
