/**
 * 成本配额管理
 * 四级预警：50% info、80% warning、95% critical、100% exceeded
 */

/** 告警级别 */
export type AlertLevel = "info" | "warning" | "critical" | "exceeded";

/** 配额检查结果 */
export interface QuotaCheckResult {
  level: AlertLevel;
  message: string;
}

export class QuotaManager {
  private costLimit: number;
  /** 已触发过的最高告警级别，避免重复告警 */
  private lastAlertLevel: AlertLevel | null = null;

  constructor(costLimit: number) {
    this.costLimit = costLimit;
  }

  /** 检查是否超限，返回当前告警级别（仅在级别升级时返回，避免重复） */
  check(currentCost: number): QuotaCheckResult | null {
    if (this.costLimit <= 0) return null;

    const ratio = currentCost / this.costLimit;
    let level: AlertLevel | null = null;

    if (ratio >= 1.0) {
      level = "exceeded";
    } else if (ratio >= 0.95) {
      level = "critical";
    } else if (ratio >= 0.80) {
      level = "warning";
    } else if (ratio >= 0.50) {
      level = "info";
    }

    if (!level) return null;

    // 只在级别升级时触发
    const levelOrder: AlertLevel[] = ["info", "warning", "critical", "exceeded"];
    const lastIdx = this.lastAlertLevel ? levelOrder.indexOf(this.lastAlertLevel) : -1;
    const currentIdx = levelOrder.indexOf(level);

    if (currentIdx <= lastIdx) return null;

    this.lastAlertLevel = level;

    const percent = (ratio * 100).toFixed(0);
    const messages: Record<AlertLevel, string> = {
      info: `成本已达配额 ${percent}%（$${currentCost.toFixed(4)} / $${this.costLimit.toFixed(2)}）`,
      warning: `⚠ 成本已达配额 ${percent}%（$${currentCost.toFixed(4)} / $${this.costLimit.toFixed(2)}），请注意控制用量`,
      critical: `⚠ 成本已达配额 ${percent}%（$${currentCost.toFixed(4)} / $${this.costLimit.toFixed(2)}），即将超限！`,
      exceeded: `成本已超出配额（$${currentCost.toFixed(4)} / $${this.costLimit.toFixed(2)}），自动停止`,
    };

    return { level, message: messages[level] };
  }

  /** 是否已超限 */
  isExceeded(currentCost: number): boolean {
    if (this.costLimit <= 0) return false;
    return currentCost >= this.costLimit;
  }
}
