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
