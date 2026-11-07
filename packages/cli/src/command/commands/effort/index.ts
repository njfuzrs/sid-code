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
  description: "打开面板或切换推理强度档位（low/medium/high/xhigh/max/auto）",
  argumentHint: "low|medium|high|xhigh|max|auto",
  source: "builtin",
  // T5：无头 cmdCtx 已注入 getEffortState/setEffort（真实写入 runtimeEffort，queryLoop
  // 下一轮经 getEffortSetting 读到）。无参返回 dialog = 明确失败非 0，不会假成功。
  headless: true,
  immediate: true,
  load: () => import("./effort.ts").then((m) => m.default),
};

export default effort;
