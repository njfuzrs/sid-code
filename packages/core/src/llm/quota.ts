/**
 * 成本配额管理
 * 四级预警：50% info、80% warning、95% critical、100% exceeded
 * 支持速率限制（RPM/TPM）
 */

/** 告警级别 */
export type AlertLevel = "info" | "warning" | "critical" | "exceeded";

/** 配额检查结果 */
export interface QuotaCheckResult {
  level: AlertLevel;
  message: string;
}

/** 配额配置 */
export interface QuotaConfig {
  costLimit?: number; // 总成本上限（美元）
  requestsPerMinute?: number; // 每分钟请求数上限
  tokensPerMinute?: number; // 每分钟 token 数上限
}

/**
 * 合并两个花费上限来源，返回本次会话真正生效的上限（美元；0 = 不限）。
 *
 * B18（2026-10-02）：原来是 `quota.costLimit ?? costLimit`，即「配置盖参数」。
 * 而公网团队默认配置自带 `quota.costLimit: 100`，于是用户 `--max-budget-usd 0.5`
 * **主动收紧**反而被放宽成 100 —— 方向错了。上限是「只许收紧」的语义，
 * 两个来源不存在「谁优先」，谁更严听谁的。
 *
 * ⚠️ 0 / 负数 / undefined 都是「这一侧不限」，**不参与取 min**：
 * 0 是评测容器显式关闸门的正当写法（见 config/schema.ts 那段注释），
 * 把它当成「最严」会让任何正数上限都变成 0 —— 等于把闸门整个关掉。
 */
export function resolveEffectiveCostLimit(
  quotaCostLimit: number | undefined,
  topLevelCostLimit: number | undefined,
): number {
  const positives = [quotaCostLimit, topLevelCostLimit].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  return positives.length > 0 ? Math.min(...positives) : 0;
}

export class QuotaManager {
  private costLimit: number;
  private rpmLimit: number;
  private tpmLimit: number;
  /** 已触发过的最高告警级别，避免重复告警 */
  private lastAlertLevel: AlertLevel | null = null;

  /** 滑动窗口：记录最近 60 秒的请求 */
  private requestWindow: number[] = []; // 时间戳数组
  private tokenWindow: { ts: number; tokens: number }[] = [];

  constructor(config: QuotaConfig | number) {
    // 向后兼容：支持直接传数字作为 costLimit
    if (typeof config === "number") {
      this.costLimit = config;
      this.rpmLimit = 0;
      this.tpmLimit = 0;
    } else {
      this.costLimit = config.costLimit ?? 0;
      this.rpmLimit = config.requestsPerMinute ?? 0;
      this.tpmLimit = config.tokensPerMinute ?? 0;
    }
  }

  /** 记录一次请求（用于速率限制） */
  recordRequest(tokens: number): void {
    const now = Date.now();
    this.requestWindow.push(now);
    this.tokenWindow.push({ ts: now, tokens });

    // 清理 60 秒前的记录
    const cutoff = now - 60_000;
    this.requestWindow = this.requestWindow.filter((ts) => ts > cutoff);
    this.tokenWindow = this.tokenWindow.filter((r) => r.ts > cutoff);
  }

  /** 检查速率限制，返回需要等待的毫秒数（0 表示不需要等待） */
  checkRateLimit(): number {
    if (this.rpmLimit > 0 && this.requestWindow.length >= this.rpmLimit) {
      // 需要等到最早的请求过期
      const oldest = this.requestWindow[0];
      return oldest + 60_000 - Date.now();
    }

    if (this.tpmLimit > 0) {
      const totalTokens = this.tokenWindow.reduce((sum, r) => sum + r.tokens, 0);
      if (totalTokens >= this.tpmLimit) {
        const oldest = this.tokenWindow[0];
        return oldest.ts + 60_000 - Date.now();
      }
    }

    return 0;
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
    } else if (ratio >= 0.8) {
      level = "warning";
    } else if (ratio >= 0.5) {
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
      info: `成本已达配额 ${percent}%（$${currentCost.toFixed(4)} / $${this.costLimit.toFixed(4)}）`,
      warning: `⚠ 成本已达配额 ${percent}%（$${currentCost.toFixed(4)} / $${this.costLimit.toFixed(4)}），请注意控制用量`,
      critical: `⚠ 成本已达配额 ${percent}%（$${currentCost.toFixed(4)} / $${this.costLimit.toFixed(4)}），即将超限！`,
      exceeded: `成本已超出配额（$${currentCost.toFixed(4)} / $${this.costLimit.toFixed(4)}），自动停止`,
    };

    return { level, message: messages[level] };
  }

  /** 重置告警级别（/clear 时调用） */
  resetAlertLevel(): void {
    this.lastAlertLevel = null;
  }

  /** 是否已超限 */
  isExceeded(currentCost: number): boolean {
    if (this.costLimit <= 0) return false;
    return currentCost >= this.costLimit;
  }
}
