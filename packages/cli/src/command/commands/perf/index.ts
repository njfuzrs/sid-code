import type { UnifiedCommand } from "../../types.ts";

/**
 * /perf 命令定义（轻量，启动时加载）。实现在 ./perf.ts。
 *
 * 本机性能数据的产品内出口：TTFT / 生成耗时 / tok/s / 端到端 / 工具耗时 / 上下文峰值。
 * 此前跨会话趋势只能在仓库里跑 scripts/northstar-snapshot.ts，二进制用户没有入口。
 */
const perf: UnifiedCommand = {
  type: "local",
  name: "perf",
  aliases: ["performance"],
  description: "查看本机性能数据：本会话卡在哪一段，近 N 天变快还是变慢",
  argumentHint: "[--days N] [--by-version] [--json] [session-id|latest]",
  source: "builtin",
  outputPanel: true,
  userInvocable: true,
  immediate: true,
  load: () => import("./perf.ts").then((m) => m.default),
};

export default perf;
