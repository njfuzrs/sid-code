/**
 * 预算追踪器——多维度预算规则 + 分级告警
 * 在现有 QuotaManager 基础上增强，支持按周期、按模型等维度的预算管控
 */

/** 预算规则配置 */
export interface BudgetRule {
  id: string;
  name: string;
  /** 预算周期 */
  period: "session" | "hourly" | "daily" | "weekly" | "monthly";
  /** 预算金额（USD） */
  limitUSD: number;
  /** 适用范围（不指定则全局） */
  scope?: {
    model?: string;
  };
  /** 告警阈值（0-1） */
  thresholds: {
    warning: number;   // 如 0.5 = 50%
    critical: number;  // 如 0.8 = 80%
    exceeded: number;  // 如 1.0 = 100%
  };
  /** 超限动作 */
  action: "alert" | "downgrade" | "block";
}

/** 告警事件 */
export interface BudgetAlert {
  ruleId: string;
  ruleName: string;
  level: "warning" | "critical" | "exceeded";
  currentUSD: number;
  limitUSD: number;
  percentage: number;
  timestamp: number;
  action: string;
}

/** 规则状态 */
export interface BudgetRuleStatus {
  ruleId: string;
  ruleName: string;
  currentUSD: number;
  limitUSD: number;
  percentage: number;
  periodKey: string;
  lastAlertLevel?: string;
}

export class BudgetTracker {
  private rules: BudgetRule[];
  /** ruleId:periodKey → 当前周期累计成本 */
  private periodCosts = new Map<string, number>();
  /** ruleId → 已触发的最高告警级别（防止重复告警） */
  private lastAlertLevel = new Map<string, string>();
  private alertCallback?: (alert: BudgetAlert) => void;

  constructor(rules: BudgetRule[], onAlert?: (alert: BudgetAlert) => void) {
    this.rules = rules;
    this.alertCallback = onAlert;
  }

  /** 记录一笔成本，检查是否触发告警，返回最高级别的告警（如有） */
  recordCost(costUSD: number, context: { model?: string }): BudgetAlert | undefined {
    let highestAlert: BudgetAlert | undefined;

    for (const rule of this.rules) {
      if (!this.matchesScope(rule, context)) continue;

      const periodKey = this.getPeriodKey(rule);
      const costKey = `${rule.id}:${periodKey}`;
      const current = (this.periodCosts.get(costKey) ?? 0) + costUSD;
      this.periodCosts.set(costKey, current);

      const percentage = current / rule.limitUSD;
      const level = this.getAlertLevel(percentage, rule.thresholds);

      if (level) {
        const lastLevel = this.lastAlertLevel.get(rule.id);
        const levelOrder = ["warning", "critical", "exceeded"];
        const lastIdx = lastLevel ? levelOrder.indexOf(lastLevel) : -1;
        const currentIdx = levelOrder.indexOf(level);

        // 只在级别升级时触发
        if (currentIdx > lastIdx) {
          this.lastAlertLevel.set(rule.id, level);
          const alert: BudgetAlert = {
            ruleId: rule.id,
            ruleName: rule.name,
            level,
            currentUSD: current,
            limitUSD: rule.limitUSD,
            percentage,
            timestamp: Date.now(),
            action: level === "exceeded" ? rule.action : "alert",
          };
          this.alertCallback?.(alert);

          if (!highestAlert || currentIdx > levelOrder.indexOf(highestAlert.level)) {
            highestAlert = alert;
          }
        }
      }
    }

    return highestAlert;
  }

  /** 获取所有规则的当前状态 */
  getStatus(): BudgetRuleStatus[] {
    return this.rules.map(rule => {
      const periodKey = this.getPeriodKey(rule);
      const costKey = `${rule.id}:${periodKey}`;
      const currentUSD = this.periodCosts.get(costKey) ?? 0;
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        currentUSD,
        limitUSD: rule.limitUSD,
        percentage: rule.limitUSD > 0 ? currentUSD / rule.limitUSD : 0,
        periodKey,
        lastAlertLevel: this.lastAlertLevel.get(rule.id),
      };
    });
  }

  /** 检查是否有任何规则处于 exceeded 状态 */
  isAnyExceeded(): boolean {
    for (const rule of this.rules) {
      const periodKey = this.getPeriodKey(rule);
      const costKey = `${rule.id}:${periodKey}`;
      const current = this.periodCosts.get(costKey) ?? 0;
      if (current >= rule.limitUSD * rule.thresholds.exceeded) {
        return true;
      }
    }
    return false;
  }

  /** 检查是否有 block 动作的规则被触发 */
  shouldBlock(): boolean {
    for (const rule of this.rules) {
      if (rule.action !== "block") continue;
      const periodKey = this.getPeriodKey(rule);
      const costKey = `${rule.id}:${periodKey}`;
      const current = this.periodCosts.get(costKey) ?? 0;
      if (current >= rule.limitUSD * rule.thresholds.exceeded) {
        return true;
      }
    }
    return false;
  }

  /** 重置告警级别（/clear 时调用） */
  resetAlertLevels(): void {
    this.lastAlertLevel.clear();
  }

  private matchesScope(rule: BudgetRule, ctx: { model?: string }): boolean {
    if (!rule.scope) return true;
    if (rule.scope.model && rule.scope.model !== ctx.model) return false;
    return true;
  }

  private getAlertLevel(
    pct: number,
    thresholds: BudgetRule["thresholds"],
  ): "warning" | "critical" | "exceeded" | undefined {
    if (pct >= thresholds.exceeded) return "exceeded";
    if (pct >= thresholds.critical) return "critical";
    if (pct >= thresholds.warning) return "warning";
    return undefined;
  }

  private getPeriodKey(rule: BudgetRule): string {
    const now = new Date();
    switch (rule.period) {
      case "session":
        return "session";
      case "hourly":
        return now.toISOString().slice(0, 13);
      case "daily":
        return now.toISOString().slice(0, 10);
      case "weekly": {
        const week = Math.floor(now.getTime() / (7 * 86400000));
        return `w${week}`;
      }
      case "monthly":
        return now.toISOString().slice(0, 7);
    }
  }
}
