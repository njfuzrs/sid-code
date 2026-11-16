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
  /**
   * 默认最大轮次（同时也是 Goal Gate 续命上限），默认 300；用掉 80%（240 轮）时
   * 会向模型注入一次软提醒。
   *
   * 检查时机（写注释前先看代码，别按设计稿写）：
   * - **软提醒**：每轮在 loop.ts 的 goal 回注段判定一次（`turnsUsed` 自增之后），
   *   首次越过 `GOAL_TURNS_NEAR_LIMIT_RATIO` 时注入一次。
   * - **硬上限**：目前仍在 end_turn 的 `handleGoalGate` 里判定 —— 即只有模型想停的
   *   那一轮才会被拦，连续 `tool_use` 空转时不生效（G1「每轮检查」的修法见方案
   *   文档 §4.1，落地后这里才谈得上「每轮检查」）。在这里写「每轮检查」会造成
   *   注释与实现不符，而注释与实现不符比没有注释更糟。
   */
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
  // 300：goal 是"目标达成前不停"的长任务模式，复杂审计/多文件重构/深度排查动辄
  // 几十轮起步，50 轮对这类任务偏紧（常在收尾阶段被 turns_limited 掐断）；150 在
  // 深度排查里同样容易在收尾阶段被腰斩。默认无 tokenBudget 时 maxTurns 是唯一硬
  // 上限，故放宽到 300 给长任务留足空间。
  //
  // 调到 300 的前提是配套的 80% 软提醒（见 GOAL_TURNS_NEAR_LIMIT_RATIO）：上限翻倍
  // 若不告诉模型"只剩 20%"，就只是把"毫不自知地跑满"的成本也翻倍。软提醒让模型在
  // 240 轮前后拿到一次明确信号，自己决定收敛还是如实报告未完成。用户随时可 ESC
  // 介入，也可用 /goal turns <n> 调整，不会真跑满 300 轮而失控。
  defaultMaxTurns: 300,
  reminderInterval: 4, // 每 4 轮回注一次目标状态
  enableBlockedDetection: true,
  blockedThreshold: 3, // 连续 3 轮相同 blockerKey → blocked
  minTurnsBeforeEval: 2, // 前 2 轮跳过评估
  evaluatorTimeout: 25000, // 25 秒超时（deepseek-v4-pro 首字节 5-15s，8s 必超）
  evalContextMaxChars: 12000, // 评估器上下文上限（保证长报告不被截断）
};

/**
 * 轮次接近上限的软提醒阈值（占 `maxTurns` 的比例）。
 *
 * ## 为什么做成共享常量而不是各写一个 0.8
 *
 * 有两个消费方，它们必须同时翻转，否则用户看到的状态会自相矛盾：
 * - core：`loop.ts` 的 goal 回注段据此判定是否注入一次「只剩 20% 轮次」提醒；
 * - cli：状态栏据此把「目标 N/M 轮」转成黄色（`useStatusLineData.ts`）。
 *
 * 如果状态栏黄了但对话里没提醒，模型不知道自己该收尾；如果对话里提醒了但状态栏
 * 还是灰色，用户会以为还很宽裕。0.8 在两处各写一遍时，任何一边调整都会静默漂移，
 * 且两处都没有测试能把这种漂移变成红色 —— 所以收敛成一个事实源。
 */
export const GOAL_TURNS_NEAR_LIMIT_RATIO = 0.8;

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
