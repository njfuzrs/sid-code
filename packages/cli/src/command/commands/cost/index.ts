import type { UnifiedCommand } from "../../types.ts";

/** /cost 命令定义（轻量，启动时加载）。实现在 ./cost.ts。 */
const cost: UnifiedCommand = {
  type: "local",
  name: "cost",
  aliases: [],
  description: "显示 token 用量和费用",
  source: "builtin",
  headless: true,
  immediate: true,
  outputPanel: true,
  load: () => import("./cost.ts").then((m) => new m.CostCommand()),
};

export default cost;
