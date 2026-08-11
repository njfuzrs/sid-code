import type { UnifiedCommand } from "../../types.ts";

/**
 * /think 命令定义（轻量，启动时加载）。
 *
 * immediate: true —— 运行时也能切换思考开关（与 /model、/effort 对齐）。
 * 切换的运行时态由 queryLoop 下一轮读取，当轮生效。实现在 ./think.ts。
 */
const think: UnifiedCommand = {
  type: "local",
  name: "think",
  description: "显示或切换思考开关（on/off/auto）",
  argumentHint: "on|off|auto",
  source: "builtin",
  immediate: true,
  load: () => import("./think.ts").then((m) => m.default),
};

export default think;
