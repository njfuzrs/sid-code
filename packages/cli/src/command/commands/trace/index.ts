import type { UnifiedCommand } from "../../types.ts";

/** /trace 命令定义（轻量，启动时加载）。实现在 ./trace.ts。 */
const trace: UnifiedCommand = {
  type: "local",
  name: "trace",
  aliases: ["digest"],
  description:
    "排查会话：把当前 / 指定会话轨迹嚼碎成结构化摘要（--health 健康看板，--cache 缓存视图）",
  argumentHint: "[<id>] [--list] [--full] [--health] [--cache [--days N]] [--prune-index N]",
  source: "builtin",
  headless: true,
  outputPanel: true,
  load: () => import("./trace.ts").then((m) => new m.TraceCommand()),
};

export default trace;
