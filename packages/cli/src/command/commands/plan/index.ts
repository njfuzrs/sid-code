import type { UnifiedCommand } from "../../types.ts";

/** /plan 命令定义（轻量，启动时加载）。实现在 ./plan.ts。 */
const plan: UnifiedCommand = {
  type: "local",
  name: "plan",
  aliases: [],
  description: "进入计划模式（先规划后执行）",
  source: "builtin",
  load: () => import("./plan.ts").then((m) => new m.PlanCommand()),
};

export default plan;
