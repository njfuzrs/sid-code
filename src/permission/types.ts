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
}
