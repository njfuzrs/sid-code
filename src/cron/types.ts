/**
 * Cron 调度数据模型（Spec 18 §5）
 */

/** 定时任务 */
export interface CronTask {
  /** 任务 ID（8 位短 ID） */
  id: string;
  /** 标准 5 字段 cron 表达式（本地时间）：分 时 日 月 周 */
  cron: string;
  /** 触发时执行的 prompt */
  prompt: string;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 是否循环触发（false = 触发一次后删除） */
  recurring: boolean;
  /** 是否持久化到磁盘（跨会话存活） */
  durable: boolean;
  /** 上次触发时间戳（ms） */
  lastFiredAt?: number;
}

/** 调度器默认配置 */
export const DEFAULTS = {
  /** 检查循环间隔（ms） */
  checkIntervalMs: 30_000,
  /** 循环任务最大存活天数（之后自动过期删除） */
  maxAgeDays: 7,
} as const;
