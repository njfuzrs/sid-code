/**
 * 权限系统核心类型
 * 定义权限检查的请求和决策结构
 */

import type { ShadowedRule } from "./shadowed-rules.ts";

/** 权限决策原因（用于审计和调试） */
export type PermissionDecisionReason =
  | { type: "rule"; rule: string; behavior: "allow" | "deny" | "ask" }
  | { type: "mode"; mode: string }
  | { type: "safetyCheck"; reason: string; classifierApprovable: boolean }
  | { type: "dangerousCommand"; pattern: string; severity: string }
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
}

/** 权限请求 */
export interface PermissionRequest {
  toolName: string;
  input: unknown;
  description?: string;
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
}

/** 权限检查器接口 */
export interface Checker {
  check(req: PermissionRequest, tool?: unknown, toolContext?: unknown, options?: PermissionCheckOptions): Promise<Decision>;
  /** 记住会话内权限决策（可选） */
  rememberDecision?(req: PermissionRequest, allowed: boolean): void;
  /** 获取与指定工具相关的阴影规则（可选，供权限对话框展示不可达规则提示） */
  getShadowedRulesForTool?(toolName: string): ShadowedRule[];
  /**
   * GAP-04：获取 Bash 命令风险分类器（可选）。
   * 供 tool-executor 在三路竞争中把分类器作为独立并行路径启动（与 UI 弹窗竞赛），
   * 而非在 check() 内同步串行等待。返回 null 表示未配置分类器。
   */
  getBashClassifier?(): import("./bash-classifier.ts").BashClassifier | null;
}

/** 权限规则配置 */
export interface PermissionRule {
  allow?: string[];   // ["Read", "Glob", "Bash(npm *)"]
  deny?: string[];    // ["Edit(.env*)", "Bash(rm *)"]
  ask?: string[];     // ["Edit", "Write"]
}

/** 审计日志条目 */
export interface AuditEntry {
  timestamp: string;        // ISO 8601
  type: string;             // "tool_use"
  tool: string;             // 工具名
  resource?: string;        // 资源路径
  decision: "allow" | "deny";
  reason?: string;          // 拒绝原因
  severity?: string;        // 危险级别
  user_confirmed?: boolean; // 是否用户确认
  /** 决策原因链 */
  decisionReason?: PermissionDecisionReason;
  /** 危险命令判定来源：hardcoded（硬编码正则）/ llm（LLM 分类器）/ both（两者都命中） */
  classifiedBy?: "hardcoded" | "llm" | "both";
  /** LLM 分类器给出的风险等级（仅 LLM 参与判定时） */
  llmRisk?: string;
}

// ── 多来源规则系统类型 ──

/** 规则来源（8 种，优先级从低到高） */
export type PermissionRuleSource =
  | "session"           // 运行时动态添加（权限弹窗 Always Allow）
  | "command"           // 斜杠命令 /allow, /deny
  | "cliArg"            // CLI 参数 --allow-tool, --deny-tool
  | "userSettings"      // ~/.sid-code/settings.json
  | "projectSettings"   // .sid-code/settings.json（不可信来源）
  | "localSettings"     // .sid-code/settings.local.json
  | "flagSettings"      // SDK 内联设置
  | "policySettings";   // 企业策略（最高优先级）

/** 规则来源优先级（数值越大优先级越高） */
export const RULE_SOURCE_PRIORITY: Record<PermissionRuleSource, number> = {
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
