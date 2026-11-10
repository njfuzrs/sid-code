/**
 * CronDeleteTool（Spec 18 §5.3.3）
 * 删除定时任务。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { getScheduler } from "../cron/scheduler.ts";
import { releaseWait } from "../task/wait-registry.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const cronDeleteSchema = lazySchema(() =>
  z.object({
    id: z.string().describe("要删除的任务 ID"),
  }),
);

export class CronDeleteTool implements Tool {
  readonly zodSchema = cronDeleteSchema();
  /** 长尾工具：定时调度低频使用，延迟加载，由 tool_search 按需调出 */
  readonly shouldDefer = true;
  readonly guidance = "取消不再需要的定时任务（含已达成目标后撤掉剩余轮询）时用。";
  readonly searchHint = "cron schedule delete cancel 定时 调度 删除 取消";

  name(): string {
    return "cron_delete";
  }

  description(): string {
    return "删除指定 ID 的定时任务。";
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(cronDeleteSchema()) as Record<string, unknown>;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const params = input as { id?: string };
    if (!params.id) {
      return { output: "错误: 缺少 id 参数", isError: true };
    }

    const ok = getScheduler().removeTask(params.id);
    if (ok) {
      // W3：会话级唤醒若登记过等待源，用户取消时同步释放——否则 todo 闸门会为一条
      // 已经不会触发的唤醒继续放行（回执说「已删除」、闸门却还当它在等）。
      releaseWait(params.id, "cancelled");
    }
    return ok
      ? { output: `已删除定时任务 ${params.id}` }
      : { output: `任务 ${params.id} 不存在`, isError: true };
  }
}
