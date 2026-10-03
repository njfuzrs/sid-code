/**
 * Goal 配置
 *
 * GoalConfig 定义了 /goal 命令的可配置参数，包括评估频率、预算、卡住检测等。
 */

export interface GoalConfig {
  /**
   * 评估者模型。取值顺序见 resolveGoalEvaluatorModel：
   * goal.evaluatorModel → subAgentModels.default → 主模型。
   * 刻意不读 subAgentModels.verify，也**没有**任何内置 haiku 回退——两项都没配时就是主模型自评。
   */
  evaluatorModel?: string;
  /** 默认 Token 预算（0 = 无限制） */
  defaultTokenBudget: number;
  /** 默认最大轮次（同时也是 Goal Gate 续命上限） */
  defaultMaxTurns: number;
  /** reminder 回注间隔（轮次） */
  reminderInterval: number;
  /** 是否启用 blocked 检测（连续 N 轮评估 blockerKey 相同则判定 blocked） */
  enableBlockedDetection: boolean;
  /** blocked 检测阈值（连续相同 blockerKey 的轮次数） */
  blockedThreshold: number;
  /** 前 N 轮跳过评估（模型刚开始工作，不可能已完成） */
  minTurnsBeforeEval: number;
  /** 评估者调用超时（毫秒） */
  evaluatorTimeout: number;
  /** 评估者上下文最大字符数（用于 extractEvalContext 截断上限） */
  evalContextMaxChars: number;
}

export const DEFAULT_GOAL_CONFIG: GoalConfig = {
  defaultTokenBudget: 0, // 无限制
  // 150：goal 是"目标达成前不停"的长任务模式，复杂审计/多文件重构/深度排查动辄
  // 几十轮起步，50 轮对这类任务偏紧（常在收尾阶段被 turns_limited 掐断）。默认无
  // tokenBudget 时 maxTurns 是唯一硬上限，故放宽到 150 给长任务留足空间；用户随时可
  // ESC 介入，也可用 /goal turns <n> 按需临时调整，不会真跑满 150 轮而失控。
  defaultMaxTurns: 150,
  reminderInterval: 4, // 每 4 轮回注一次目标状态
  enableBlockedDetection: true,
  blockedThreshold: 3, // 连续 3 轮相同 blockerKey → blocked
  minTurnsBeforeEval: 2, // 前 2 轮跳过评估
  evaluatorTimeout: 25000, // 25 秒超时（deepseek-v4-pro 首字节 5-15s，8s 必超）
  evalContextMaxChars: 12000, // 评估器上下文上限（保证长报告不被截断）
};

/** 评估者模型的来源：用于 /goal 设定时提示「评估者 = 主模型」与 /goal status 展示。 */
export type GoalEvaluatorSource = "goal.evaluatorModel" | "subAgentModels.default" | "main";

/**
 * 解析 /goal 评估者模型（loop.ts 的 Goal Gate 与 /goal 命令共用这一个事实源，
 * 否则「提示说的评估者」与「实际调用的评估者」会再次漂移——B16 就是注释与实现三处不一致）。
 *
 * 优先级：goal.evaluatorModel > subAgentModels.default > 主模型。
 * 刻意跳过 subAgentModels.verify：verify 语义是"对抗验证子代理"（需强模型、慢），
 * goal 评估是"快速判是否完成"（512 token JSON），复用会撞短超时（20260707 P0-1/P1-4）。
 *
 * 刻意**不**在未配置时自动挑一个"轻量模型"：模型目录随 provider 而异，
 * 按模型名硬编码分级既不可靠也违反项目约定。未配置时如实回退主模型，由调用方提示用户。
 */
export function resolveGoalEvaluatorModel(config: {
  model: string;
  goal?: Partial<GoalConfig>;
  subAgentModels?: { default?: string };
}): { model: string; source: GoalEvaluatorSource } {
  const fromGoal = config.goal?.evaluatorModel;
  if (fromGoal) return { model: fromGoal, source: "goal.evaluatorModel" };
  const fromSub = config.subAgentModels?.default;
  if (fromSub) return { model: fromSub, source: "subAgentModels.default" };
  return { model: config.model, source: "main" };
}
