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
  description: "显示或切换模型（主模型 / fallback / 子代理，-p 持久化）",
  argumentHint: "[name|fallback <name>|sub <type> <name>] [-p]",
  source: "builtin",
  immediate: true,
  // 无参（打开对话框）/list/help 等都能单次回车直执行；仅带模型名时才需参数，
  // 但补全列表回车回填后用户可继续输入，故不标 requiresArgs（保持无参可直接开对话框）。
  load: () => import("./model.ts").then((m) => m.default),
};

export default model;
