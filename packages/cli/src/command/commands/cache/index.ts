import type { UnifiedCommand } from "../../types.ts";

/** /cache 命令定义（轻量，启动时加载）。实现在 ./cache.ts。 */
const cache: UnifiedCommand = {
  type: "local",
  name: "cache",
  aliases: [],
  description: "显示缓存命中率 / 省钱长期统计",
  argumentHint: "[--period day|week|month] [--model <name>] [--breaks] [--history] [--prune <N>]",
  source: "builtin",
  headless: true,
  outputPanel: true,
  load: () => import("./cache.ts").then((m) => new m.CacheCommand()),
};

export default cache;
