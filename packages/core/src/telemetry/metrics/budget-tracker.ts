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
    warning: number; // 如 0.5 = 50%
    critical: number; // 如 0.8 = 80%
    exceeded: number; // 如 1.0 = 100%
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
  /** recordTurn 已入账到的会话有效总花费（增量记账的基线） */
  private accountedTotalUSD = 0;

  constructor(rules: BudgetRule[], onAlert?: (alert: BudgetAlert) => void) {
    this.rules = rules;
    this.alertCallback = onAlert;
  }

  /** 只记账、不评估告警 */
  private addCost(costUSD: number, context: { model?: string }): void {
    if (!(costUSD > 0)) return;
    for (const rule of this.rules) {
      if (!this.matchesScope(rule, context)) continue;
      const costKey = this.costKeyOf(rule);
      this.periodCosts.set(costKey, (this.periodCosts.get(costKey) ?? 0) + costUSD);
    }
  }

  /**
   * 主循环每轮记账：按会话**有效总花费**的增量入账，与 costLimit 同口径
   * （`SessionState.getEffectiveTotalCostUSD()`，含标题/记忆/摘要等影子调用、子代理、作废重试）。
   *
   * 原来只记本次主调用的 `thisCost`，影子调用的花费逃过所有 budgetRules，
   * 同一个数配给 costLimit 和 `period: "session"` 规则，两者触发时机不同。
   *
   * 增量里属于本次主调用的部分按 `model` 入账（`scope.model` 可匹配），
   * 其余部分不带模型 —— 只进不限模型的规则。不按模型拆是因为增量来自多条入账路，
   * 拆不出来就不猜；宁可 scope.model 规则少算，也不把别的模型的钱记到它头上。
   * 不会重复计数：每次入账后基线推进到当前总额，同一笔钱只在一个增量里出现。
   */
  recordTurn(
    effectiveTotalUSD: number,
    mainCostUSD: number,
    context: { model?: string },
  ): BudgetAlert | undefined {
    let delta = effectiveTotalUSD - this.accountedTotalUSD;
    // 总额回退 = 计数器被归零过（/clear → rotate），此时全部都是新钱
    if (delta < 0) delta = effectiveTotalUSD;
    this.accountedTotalUSD = effectiveTotalUSD;
    const main = Math.min(Math.max(mainCostUSD, 0), delta);
    this.addCost(main, context);
    this.addCost(delta - main, {});
    return this.checkAlerts();
  }

  /**
   * resume 回灌用量后调用：把回灌进来的历史花费设为记账基线。
   *
   * - `period: "session"` 规则：会话是同一个，历史花费计入（与 costLimit 看
   *   `getEffectiveTotalCostUSD()` 同口径）。按模型拆不出来，只计入不限模型的规则。
   * - hourly/daily/...：历史花费发生在过去，不知道落在哪个周期，不计入，
   *   否则 resume 一次就把昨天的钱记进今天。
   */
  hydrateSessionBaseline(effectiveTotalUSD: number): void {
    const total = Math.max(0, effectiveTotalUSD);
    this.accountedTotalUSD = total;
    if (total <= 0) return;
    for (const rule of this.rules) {
      if (rule.period !== "session" || rule.scope?.model) continue;
      const costKey = this.costKeyOf(rule);
      this.periodCosts.set(costKey, (this.periodCosts.get(costKey) ?? 0) + total);
    }
  }

  /** 记录一笔成本并评估告警，返回最高级别的告警（如有）。告警只在级别升级时返回。 */
  recordCost(costUSD: number, context: { model?: string }): BudgetAlert | undefined {
    this.addCost(costUSD, context);
    return this.checkAlerts();
  }

  /**
   * 评估全部规则的告警升级（不记账）。
   *
   * 遍历**全部**规则而不只是本次 model 命中的：辅助调用经 `addCost` 记进了别的
   * scope 的规则，那些规则的升级也得在这里报出来。
   */
  checkAlerts(): BudgetAlert | undefined {
    let highestAlert: BudgetAlert | undefined;
    const levelOrder = ["warning", "critical", "exceeded"];

    for (const rule of this.rules) {
      const costKey = this.costKeyOf(rule);
      const current = this.periodCosts.get(costKey) ?? 0;
      const percentage = current / rule.limitUSD;
      const level = this.getAlertLevel(percentage, rule.thresholds);
      if (!level) continue;

      // 去重键带周期：每日/每周规则翻周期后要能重新告警，按 rule.id 去重会让它从此哑掉。
      const lastLevel = this.lastAlertLevel.get(costKey);
      const lastIdx = lastLevel ? levelOrder.indexOf(lastLevel) : -1;
      const currentIdx = levelOrder.indexOf(level);

      // 只在级别升级时触发（告警去重；硬停判定不走这里，见 findBlockingRule）
      if (currentIdx > lastIdx) {
        this.lastAlertLevel.set(costKey, level);
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

    return highestAlert;
  }

  /** 获取所有规则的当前状态 */
  getStatus(): BudgetRuleStatus[] {
    return this.rules.map((rule) => {
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
        lastAlertLevel: this.lastAlertLevel.get(costKey),
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

  /**
   * 当前周期内已超限的 block 规则（取第一条）—— **硬停判定只看它**，每轮都问。
   *
   * 不能拿 `recordCost()` 的返回值当硬停：那是告警升级事件，exceeded 触发一次之后
   * 恒为 undefined —— 交互模式下第一次超限停一轮，之后再也不拦（2026-10-22 实测）。
   */
  findBlockingRule(): { rule: BudgetRule; currentUSD: number } | undefined {
    for (const rule of this.rules) {
      if (rule.action !== "block") continue;
      const current = this.periodCosts.get(this.costKeyOf(rule)) ?? 0;
      if (current >= rule.limitUSD * rule.thresholds.exceeded) {
        return { rule, currentUSD: current };
      }
    }
    return undefined;
  }

  /** 检查是否有 block 动作的规则被触发 */
  shouldBlock(): boolean {
    return this.findBlockingRule() !== undefined;
  }

  /** 重置告警级别（/clear 时调用） */
  resetAlertLevels(): void {
    this.lastAlertLevel.clear();
  }

  /**
   * 清空 `period: "session"` 的累计值（/clear 时调用）。
   *
   * /clear 是切到新会话（sessionState.rotate），session 周期必须随之归零；
   * 否则硬停每轮都问 findBlockingRule，/clear 之后第一条消息就会被旧会话的花费拦住。
   * hourly/daily/... 是自然时间周期，与会话无关，刻意不清。
   */
  resetSessionPeriod(): void {
    // /clear 之后 rotate 把会话花费归零，基线跟着归零
    this.accountedTotalUSD = 0;
    for (const rule of this.rules) {
      if (rule.period !== "session") continue;
      const costKey = this.costKeyOf(rule);
      this.periodCosts.delete(costKey);
      this.lastAlertLevel.delete(costKey);
    }
  }

  private costKeyOf(rule: BudgetRule): string {
    return `${rule.id}:${this.getPeriodKey(rule)}`;
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

  /**
   * 周期键按**本地时区**算，`weekly` 按 ISO 周（周一开始）。
   *
   * 原来取 `toISOString()`（UTC）：UTC+8 下「每日预算」到本地早上 8 点才清零；
   * `weekly` 用 `floor(epoch / 7天)`，1970-01-01 是周四，一周从周四开始。
   * 用户按本地自然日/自然周理解规则，键必须跟着本地时间走。
   * 远程预算的 period_key 由服务端给（remote-budget.ts），不经这里，两边互不影响。
   */
  private getPeriodKey(rule: BudgetRule, now: Date = new Date()): string {
    return budgetPeriodKey(rule.period, now);
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 本地时区的周期键（导出供测试固定时间断言） */
export function budgetPeriodKey(period: BudgetRule["period"], now: Date): string {
  const y = now.getFullYear();
  const m = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  switch (period) {
    case "session":
      return "session";
    case "hourly":
      return `${y}-${m}-${d}T${pad2(now.getHours())}`;
    case "daily":
      return `${y}-${m}-${d}`;
    case "weekly": {
      // ISO 8601 周：取本周周四所在的年作为周年，第 1 周是含 1 月 4 日的那一周。
      // 用 UTC 构造「本地日历日」只为做纯日期算术，避开夏令时让一天不等于 24h。
      const date = new Date(Date.UTC(y, now.getMonth(), now.getDate()));
      const dayNum = date.getUTCDay() || 7; // 周一=1 … 周日=7
      date.setUTCDate(date.getUTCDate() + 4 - dayNum);
      const isoYear = date.getUTCFullYear();
      const yearStart = Date.UTC(isoYear, 0, 1);
      const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
      return `${isoYear}-W${pad2(week)}`;
    }
    case "monthly":
      return `${y}-${m}`;
  }
}
