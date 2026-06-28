import type { UnifiedCommand } from "../../types.ts";

const goal: UnifiedCommand = {
  type: "local",
  name: "goal",
  description: "目标驱动持续执行：设定完成条件，AI 在达成前不停止",
  argumentHint: "<完成条件> | status | pause | resume | edit <新条件> | budget <tokens> | clear",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./goal.ts").then((m) => m.default),
};

export default goal;
