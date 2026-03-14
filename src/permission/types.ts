/**
 * 权限系统核心类型
 * 定义权限检查的请求和决策结构
 */

/** 权限决策 */
export interface Decision {
  allowed: boolean;
  reason?: string;
  needsConfirmation?: boolean;
}

/** 权限请求 */
export interface PermissionRequest {
  toolName: string;
  input: unknown;
  description?: string;
}

/** 权限检查器接口 */
export interface Checker {
  check(req: PermissionRequest): Promise<Decision>;
  /** 记住会话内权限决策（可选） */
  rememberDecision?(req: PermissionRequest, allowed: boolean): void;
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
}
