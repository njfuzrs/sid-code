import type { UnifiedCommand } from "../../types.ts";

/** /telemetry 命令定义（轻量，启动时加载）。实现在 ./telemetry.ts。 */
const telemetry: UnifiedCommand = {
  type: "local",
  name: "telemetry",
  aliases: ["tele"],
  description: "显示当前会话遥测摘要（Span 树 + Metric 汇总）",
  source: "builtin",
  outputPanel: true,
  load: () => import("./telemetry.ts").then((m) => new m.TelemetryCommand()),
};

export default telemetry;
