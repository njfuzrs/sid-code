import type { UnifiedCommand } from "../../types.ts";

/**
 * /effort 命令定义（轻量，启动时加载）。
 *
 * immediate: true —— 让用户在模型运行时也能切换推理强度（与 /model 对齐）。
 * 切换的运行时态由 queryLoop 下一轮读取，当轮生效。实现在 ./effort.ts。
 */
const effort: UnifiedCommand = {
  type: "local",
  name: "effort",
  description: "显示或切换推理强度档位（low/medium/high/max/auto）",
  argumentHint: "low|medium|high|max|auto",
  source: "builtin",
  immediate: true,
  load: () => import("./effort.ts").then((m) => m.default),
};

export default effort;
