/**
 * 权限系统核心类型
 * 定义权限检查的请求和决策结构
 */

import type { ShadowedRule } from "./shadowed-rules.ts";

/** 权限决策原因（用于审计和调试） */
export type PermissionDecisionReason =
  | { type: "rule"; rule: string; behavior: "allow" | "deny" | "ask" }
  /**
   * via：同一 mode 内部的细分来源，目前只有 `skip-inherit-outside-workdir`
   * （skip 档主会话派生的子代理读/写工作区外非敏感路径，A1）。
   * 单独标出来的理由：这条口子放宽了「更安全」一个方向，需要能被统计到用了多少次；
   * 混进普通 always-allow 就再也分不开了（PermissionDecision 已按 reason_type 落轨迹）。
   */
  | { type: "mode"; mode: string; via?: string }
  | { type: "safetyCheck"; reason: string; classifierApprovable: boolean }
  | { type: "dangerousCommand"; pattern: string; severity: string }
  /** D16：工具自报破坏性（MCP `destructiveHint: true`），确认不可被 yesMode / auto / hook 静默放行 */
  | { type: "destructiveTool"; tool: string; openWorld?: boolean }
  | { type: "pathValidation"; reason: string }
  | { type: "sessionMemory" }
  | { type: "denialTracking"; consecutiveDenials: number; totalDenials: number }
  | { type: "other"; reason: string };

/** 权限决策 */
export interface Decision {
  allowed: boolean;
  reason?: string;
  needsConfirmation?: boolean;
  /** 决策原因链（用于审计和调试） */
  decisionReason?: PermissionDecisionReason;
  /** 元数据（传递给上层的额外信息） */
  metadata?: Record<string, unknown>;
  /**
   * 做出本决策的管线位置：阶段一的 Step 编号（"1" / "3.5" / "8-rule" / "14" …）或阶段二的
   * 后处理名（"skip" / "memory" / "hook-allow" / "yes" / "auto" / "headless" / "fuse" / "mode-gate" …）。
   * 固定枚举，不含入参。进本地轨迹 PermissionDecision.step —— 此前 22409/25933 条决策
   * 不带 reason_type，Step 5.5 工具放行 / Step 10 只读 / Step 12 预授权 / skip 早退混在一起分不开。
   */
  step?: string;
  /** 决策时的生效权限模式（sid 原值；skipPermissions 记为 dangerously-skip-permissions） */
  mode?: string;
}

/** 权限请求 */
export interface PermissionRequest {
  toolName: string;
  input: unknown;
  description?: string;
  /**
   * 发起这次鉴权的工具调用 id（模型给的 `tool_use.id`）。B19：权限审计与轨迹
   * `PermissionDecision` 的共同键——此前两边没有任何共同 id，只能按 ±1s + 工具名相邻配对，
   * 并发工具调用会错配。放在请求上而不是 `PermissionCheckOptions` 上：包装型 checker
   * （swarm escalate 等）原样透传 `req` 却丢 options，放这里结构上不会被半路丢掉。
   * 不参与任何判定（规则匹配、会话记忆键都不读它）。
   */
  toolUseId?: string;
}

/**
 * 权限检查选项（G2/G3：PreToolUse hook 决策注入）
 * hookPermissionDecision 由 PreToolUse hook 的 hookSpecificOutput.permissionDecision 得来：
 *   - "allow"：跳过默认交互提示（但 deny 规则/危险命令/ask 规则仍生效）
 *   - "ask"：强制升级为用户确认（即便工具本会自动放行）
 * 安全护栏：allow 永不越过 deny 规则与硬编码危险命令（CC toolHooks.ts:386）。
 */
export interface PermissionCheckOptions {
  hookPermissionDecision?: "allow" | "ask";
  /**
   * 写入 permissions-audit 的 source。`policy-probe` = 不经模型的接线探针，
   * 触发率脚本必须与真实工具行分开计，避免把 A 刷成 100%。
   */
  auditSource?: string;
}

/** 确认弹窗终局（见 `Checker.auditConfirmationOutcome`） */
export interface ConfirmationOutcome {
  allowed: boolean;
  /** 三路竞争的胜出方：user / hook / classifier / timeout / auto */
  source: string;
  /** 终局给出的理由（如「用户拒绝」「权限决策超时」） */
  reason?: string;
  /** 弹窗前那次 check 的成因（「为什么要问」） */
  decisionReason?: PermissionDecisionReason;
}

/** 权限检查器接口 */
export interface Checker {
  check(
    req: PermissionRequest,
    tool?: unknown,
    toolContext?: unknown,
    options?: PermissionCheckOptions,
  ): Promise<Decision>;
  /** 记住会话内权限决策（可选） */
  rememberDecision?(req: PermissionRequest, allowed: boolean): void;
  /**
   * 把一次确认弹窗（ask）的终局写进权限审计（可选）。B20：`check()` 返回 needsConfirmation
   * 时审计里什么都不写，人工批准 / 拒绝、hook 裁决、超时拒绝此前一条都不落盘。
   * 由上层在三路竞争出结果后调用；**只写审计，不改任何决策状态**。
   */
  auditConfirmationOutcome?(req: PermissionRequest, outcome: ConfirmationOutcome): void;
  /**
   * 记录一次「用户在确认弹窗里拒绝」（可选）。
   *
   * 负收益防线审计发现 1：ask 路径此前完全不给 denial tracking 记账，
   * "模型反复请求同一操作、用户反复拒绝"这种最典型的死循环反而永不熔断。
   */
  recordUserDenial?(req: PermissionRequest, reason?: string): void;
  /** 重置 denial tracking（可选，/clear 新一轮对话时调用） */
  resetDenialTracking?(): void;
  /**
   * 读取 denial tracking 的当前状态（可选，只读）。
   * 无头模式收尾时用它汇总「哪些操作被自动拒绝了」——决策本身不在这里改。
   */
  getDenialTracking?(): import("./denial-tracking.ts").DenialTrackingState;
  /** 获取与指定工具相关的阴影规则（可选，供权限对话框展示不可达规则提示） */
  getShadowedRulesForTool?(toolName: string): ShadowedRule[];
  /**
   * GAP-04：获取 Bash 命令风险分类器（可选）。
   * 供 tool-executor 在三路竞争中把分类器作为独立并行路径启动（与 UI 弹窗竞赛），
   * 而非在 check() 内同步串行等待。返回 null 表示未配置分类器。
   */
  getBashClassifier?(): import("./bash-classifier.ts").BashClassifier | null;
  /**
   * 设置命令作用域 allow 规则（斜杠命令 / skill 的 `allowed-tools`），返回被剥离的危险规则（可选）。
   * 生命周期由调用方负责：inline 命令 = 触发它的那一轮，结束（含异常 / 中断）必须
   * {@link clearCommandScopedRules}。
   */
  setCommandScopedRules?(allow: string[], trusted: boolean, origin?: string): string[];
  /** 清空命令作用域 allow 规则（可选） */
  clearCommandScopedRules?(): void;
  /**
   * 获取内部路径校验器（可选）。
   *
   * 供**工具层之外**的读文件路径复用同一道路径防线——目前唯一消费方是 `@文件` 提及展开
   * （`src/app.ts` expandAtReferences）。它此前直接 `readFile` 零校验，等于给敏感文件
   * 开了一条绕过 FILE_TOOLS 校验（checker.ts Step 4）的侧门。
   *
   * 必须暴露**同一个实例**而非新建：`/add-dir` 等运行时授权改的是这个实例的白名单，
   * 新建一个会丢掉本会话的用户授权。
   */
  getPathValidator?(): import("./path-validator.ts").PathValidator;
  /**
   * G21：路径是否被 deny 规则隐藏（供 glob/ls/grep 列举过滤）。
   */
  isPathHidden?(absPath: string): boolean;
  /**
   * P1-1：路径是否命中敏感文件硬 deny（凭证类）。
   * 与 isPathHidden 并列，供 grep/read_many 列举过滤。
   */
  isSensitivePath?(absPath: string): boolean;
}

/** 权限规则配置 */
export interface PermissionRule {
  allow?: string[]; // ["Read", "Glob", "Bash(npm *)"]
  deny?: string[]; // ["Edit(.env*)", "Bash(rm *)"]
  ask?: string[]; // ["Edit", "Write"]
}

/** 审计日志条目 */
export interface AuditEntry {
  timestamp: string; // ISO 8601
  type: string; // "tool_use"
  tool: string; // 工具名
  resource?: string; // 资源路径
  decision: "allow" | "deny";
  reason?: string; // 拒绝原因
  severity?: string; // 危险级别
  /**
   * 这条决策是否由**人**作答（批准、拒绝都算，结论看 `decision`）。
   * 只有确认弹窗的终局行（带 `confirm_source`）才可能是 true；hook allow / yesMode
   * 等自动放行写 false。B20：此前人工结论根本不落审计，这个字段全量恒为 false。
   */
  user_confirmed?: boolean;
  /**
   * B19：本进程会话 id（`bootstrap/state.ts` 的 `getSessionId()`，即 `config.sessionId`）。
   * 由 `AuditLogger` 写入时统一盖章。resume 会话的轨迹目录用的是被恢复会话的旧 id，
   * 新进程 id 记在该轨迹 SessionStart 的 `process_session_id` 上，按它 join。
   */
  session_id?: string;
  /** B19：工具调用 id，与轨迹 `PermissionDecision.tool_use_id` 同值，两边按它 join */
  tool_use_id?: string;
  /**
   * B20：确认弹窗（ask）的终局由谁作出。只出现在 ask 终局行上：
   * user（人点的）/ hook（PermissionRequest hook）/ classifier（并行分类器）/
   * timeout（超时自动拒）/ auto（无交互通道自动拒）。
   * 同一个 tool_use_id 之前那行（若有）是「为什么要问」，这一行是「问的结果」。
   */
  confirm_source?: string;
  /** 决策原因链 */
  decisionReason?: PermissionDecisionReason;
  /** 危险命令判定来源：hardcoded（硬编码正则）/ llm（LLM 分类器）/ both（两者都命中） */
  classifiedBy?: "hardcoded" | "llm" | "both";
  /** LLM 分类器给出的风险等级（仅 LLM 参与判定时） */
  llmRisk?: string;
  /**
   * 审计来源。缺省 = 真实工具决策；`policy-probe` = 启动探针（不经模型）。
   * 触发率脚本用它把探针和真实撞墙分行。
   */
  source?: string;
}

// ── 多来源规则系统类型 ──

/** 规则来源（9 种，优先级从低到高；commandScoped 是唯一的负优先级档，见 RULE_SOURCE_PRIORITY） */
export type PermissionRuleSource =
  | "commandScoped" // 斜杠命令 / skill 的 allowed-tools，仅作用于触发它的那一轮（或那一个 fork 子代理）
  | "session" // 运行时动态添加（权限弹窗 Always Allow）
  | "command" // 斜杠命令 /allow, /deny
  | "cliArg" // CLI 参数 --allow-tool, --deny-tool
  | "userSettings" // ~/.sid-code/settings.json
  | "projectSettings" // .sid-code/settings.json（不可信来源）
  | "localSettings" // .sid-code/settings.local.json
  | "flagSettings" // SDK 内联设置
  | "policySettings"; // 企业策略（最高优先级）

/** 规则来源优先级（数值越大优先级越高） */
export const RULE_SOURCE_PRIORITY: Record<PermissionRuleSource, number> = {
  // 最低档：只产生「免确认」allow，任何持久来源的 deny / ask 都压得住它
  commandScoped: -1,
  session: 0,
  command: 1,
  cliArg: 2,
  userSettings: 3,
  projectSettings: 4,
  localSettings: 5,
  flagSettings: 6,
  policySettings: 7,
};

/** 带来源的权限规则 */
export interface SourcedPermissionRule {
  source: PermissionRuleSource;
  behavior: "allow" | "deny" | "ask";
  /** 原始规则字符串，如 "Bash(npm *)" */
  rawRule: string;
}

/** 设置文件中的权限配置格式 */
export interface SettingsPermissions {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}
