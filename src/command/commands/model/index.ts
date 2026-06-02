import type { UnifiedCommand } from "../../types.ts";

/**
 * /model 命令定义（轻量，启动时加载）
 *
 * 标记 immediate: true —— 让用户在模型运行时也能切换模型（对齐 Claude Code）。
 * 实现代码在 ./model.ts，通过 load() 按需加载。
 */
const model: UnifiedCommand = {
  type: "local",
  name: "model",
  aliases: ["m"],
  description: "显示或切换模型",
  source: "builtin",
  immediate: true,
  load: () => import("./model.ts").then((m) => m.default),
};

export default model;
