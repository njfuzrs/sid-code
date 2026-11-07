import type { UnifiedCommand } from "../../types.ts";

const goal: UnifiedCommand = {
  type: "local",
  name: "goal",
  description: "目标驱动持续执行：设定完成条件，AI 在达成前不停止",
  argumentHint:
    "<完成条件> | status | pause | resume | edit <新条件> | turns <n> | budget <tokens> | clear",
  source: "builtin",
  // T5：无头 cmdCtx 已注入 getGoalState/setGoalState/updateGoalState（写的是 queryEngine
  // 的 getGoalState 同一个 this.goalState，Goal Gate 真实生效）与 notify（走 stderr）。
  headless: true,
  userInvocable: true,
  immediate: true,
  load: () => import("./goal.ts").then((m) => m.default),
};

export default goal;
