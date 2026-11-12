/**
 * /cost 命令（PR-B 重做后的薄封装）。
 *
 * 分层：取数在 core 的 `buildCostReport`（session/cost-report.ts），排版在
 * `cost-render.ts`（`CostReport → string`）。本文件只剩**接线**：从进程级单例
 * 拿快照、从 config 拿预算、决定要不要颜色。排版层重算指标正是 D9 的根因，
 * 这里不许出现第二份算法。
 */

import { getBackgroundGateStats } from "@sid-code/core/agent/background-task-gate.ts";
import { getSideStats } from "@sid-code/core/trace/side-call-sink.ts";
import { getRecentCacheBreaks } from "@sid-code/core/api/cache-detection.ts";
import { resolveEffectiveCostLimit } from "@sid-code/core/llm/quota.ts";
import { buildCostReport } from "@sid-code/core/session/cost-report.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";
import { renderCostReport, type PendingTasksView } from "./cost-render.ts";

// 既有测试（cost-pending-tasks / cost-api-duration）从本模块导入这两个符号。
// 实现已随渲染层拆到 cost-render.ts，这里 re-export 保持导入路径稳定。
export { formatPendingTasksNotice } from "./cost-render.ts";
export type { PendingTasksView } from "./cost-render.ts";

/** /cost 命令 */
export class CostCommand implements LocalCommandModule {
  /**
   * 后台闸门读取函数**可注入**：闸门是进程级单例，`bun test` 同批多文件跑在同一进程里，
   * 测试若去占用/重置它会和 `packages/core/tests/agent/background-task-gate.test.ts`
   * 互相干扰（两个文件并发跑时，一边的 drain 会清掉另一边的待补队列）。
   * 生产路径用默认值读真实闸门，测试传假状态即可覆盖「进行中 / 排队 / 空闲」三个分支。
   */
  constructor(
    private readonly readGateStats: () => PendingTasksView = () => getBackgroundGateStats(),
  ) {}

  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const ss = ctx.sessionState;
    const config = ctx.config;

    // 预算：与预算守卫同一个取数函数（quota.costLimit 与顶层 costLimit 取更严）。
    // 读不到 config（部分测试只给 sessionState）时按未设置处理，预算段整段省略。
    const costLimitUSD = resolveEffectiveCostLimit(config?.quota?.costLimit, config?.costLimit);

    const report = buildCostReport(ss, {
      sideStats: getSideStats(),
      gateStats: this.readGateStats(),
      cacheBreaks: getRecentCacheBreaks(),
      ...(costLimitUSD > 0 ? { costLimitUSD } : {}),
    });

    // 颜色只在真终端给（D15 规则 11）：/cost 是 headless 命令，`-p` / 管道输出走的就是
    // 这条路径，ANSI 转义码会污染脚本解析。isTTY 是唯一判据，不猜 TERM。
    const stdout = process.stdout as { isTTY?: boolean; columns?: number };
    const value = renderCostReport(report, {
      useColor: stdout.isTTY === true,
      columns: stdout.columns ?? 80,
    });

    return { type: "text", value };
  }
}
