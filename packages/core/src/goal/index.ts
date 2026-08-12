/**
 * Goal 模块入口 — re-export 所有子模块
 */

export {
  type GoalState,
  type EvidenceEntry,
  type GoalStatus,
  type CreateGoalOptions,
  createGoal,
  serializeGoalState,
  deserializeGoalState,
} from "./state.ts";
export { type GoalConfig, DEFAULT_GOAL_CONFIG } from "./config.ts";
export {
  type GoalEvalResult,
  type EvalConfig,
  evaluateGoal,
  tryFastPathEval,
  extractEvalContext,
} from "./evaluator.ts";
export { collectEvidence, collectEvidenceFromTurn } from "./evidence-collector.ts";
export { buildGoalReminder, buildFirstTurnPrompt, buildResumeTurnPrompt } from "./reminder.ts";
export {
  type TurnUsage,
  checkGoalBudget,
  buildBudgetLimitMessage,
  buildBudgetWarningMessage,
} from "./budget.ts";
export { BlockedDetector } from "./blocked-detector.ts";
