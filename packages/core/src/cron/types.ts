/**
 * Cron 调度数据模型（Spec 18 §5）
 */

/** 定时任务 */
export interface CronTask {
  /** 任务 ID（8 位短 ID） */
  id: string;
  /**
   * 标准 5 字段 cron 表达式（本地时间）：分 时 日 月 周。
   * 当任务为「相对延迟一次性唤醒」（fireAt 已设）时此字段可为空串占位。
   */
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
  /**
   * 绝对触发时间戳（ms）。设置后调度器直接在该时刻触发，绕过 cron 解析。
   * 用于 ScheduleWakeup 的「N 秒后唤醒一次」动态自定步场景（recurring 恒为 false）。
   */
  fireAt?: number;
  /**
   * 任务执行的工作目录（守护进程 fork headless 时 cwd）。
   * 会话内创建时自动填 process.cwd()；缺省回退到任务所在 scheduled_tasks.json 的项目根。
   * 缺口 C1：交互式会话隐含用 process.cwd()，守护进程没有「当前目录」，必须显式记录。
   */
  workspaceDir?: string;
  /**
   * 该任务无头执行时允许的工具白名单（预授权）。
   * 缺口 C1 §5.3：守护进程无人值守，不能交互式 stall 等批准，
   * 故任务级声明放行的工具/命令；缺省走 daemon-config 全局兜底白名单。
   * 空数组或缺省 = 不额外放行（默认只读）。
   */
  allowedTools?: string[];
}

/** 调度器默认配置 */
export const DEFAULTS = {
  /** 检查循环间隔（ms） */
  checkIntervalMs: 30_000,
  /** 循环任务最大存活天数（之后自动过期删除） */
  maxAgeDays: 7,
} as const;
