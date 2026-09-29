/**
 * Swarm 权限同步（Spec 18 §7.3.3）
 *
 * Swarm 中的 teammate 没有独立的用户交互通道——它们的权限请求统一路由给
 * leader（主会话）裁决。leader 的批准结果在团队内同步，避免每个 teammate
 * 各自弹窗，也防止 teammate 越权。
 *
 * 设计：进程内的请求队列 + leader 注入的裁决回调。
 */

export type PermissionVerdict = "allow" | "deny" | "allow-always";

export interface TeamPermissionRequest {
  teammate: string;
  toolName: string;
  description: string;
  /** 语义化权限声明（展示给 leader 的操作描述） */
  prompt?: string;
}

/** leader 裁决函数 */
export type PermissionArbiter = (req: TeamPermissionRequest) => Promise<PermissionVerdict>;

export class PermissionSync {
  private arbiter: PermissionArbiter | null = null;
  /** 团队级"始终允许"缓存：toolName → true */
  private alwaysAllow = new Set<string>();

  /** leader 注册裁决回调 */
  setArbiter(arbiter: PermissionArbiter): void {
    this.arbiter = arbiter;
  }

  /** teammate 请求权限，路由给 leader 裁决 */
  async requestPermission(req: TeamPermissionRequest): Promise<PermissionVerdict> {
    // 团队级 always-allow 命中 → 直接放行
    if (this.alwaysAllow.has(req.toolName)) {
      return "allow";
    }

    // 无 leader 裁决回调 → fail-closed 拒绝
    if (!this.arbiter) {
      return "deny";
    }

    const verdict = await this.arbiter(req);
    if (verdict === "allow-always") {
      this.alwaysAllow.add(req.toolName);
    }
    return verdict;
  }

  // P2-2：此处曾有 preApprove(toolNames)，注释称「预置来自 leader 计划的 allowedPrompts」。
  // 生产零调用，而它承诺消费的 allowedPrompts 本身也已删除（exit_plan_mode 不再收集）。
  // 团队级 always-allow 只经 leader 裁决 allow-always 这一条路进入缓存。

  /** 清空团队权限缓存 */
  reset(): void {
    this.alwaysAllow.clear();
    this.arbiter = null;
  }
}
