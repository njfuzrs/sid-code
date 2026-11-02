import type { UnifiedCommand } from "../../types.ts";

/** /cron 命令定义（轻量，启动时加载）。实现在 ./cron.ts。 */
const cron: UnifiedCommand = {
  type: "local",
  name: "cron",
  // schedule：对齐 claude-code 命名（CC /schedule 做本地定时任务，我们用 /cron 覆盖同能力）。
  // 云端 Routine 部分不做（无云端基建，见方案 §6）。
  aliases: ["schedule"],
  description: "管理定时任务（列出 / 删除）",
  argumentHint: "[list|delete <id>]",
  source: "builtin",
  outputPanel: true,
  load: () => import("./cron.ts").then((m) => new m.CronCommand()),
};

export default cron;
