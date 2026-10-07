/**
 * 工具副作用派生的 hook 事件（§三.8 第 2 条，HC24）：CwdChanged / TaskCreated / TaskCompleted
 *
 * 这三个事件的 fire 方法早就有，调用点一直为零（types.ts 里标「预留」）。接在工具执行器里，
 * 而不是塞进各工具：工具拿不到 hookSystem（ToolContext 里没有），为三个事件给每个工具开一条
 * 依赖注入通道，不如在执行器——已经持有 hookSystem、且看得到工具名 / 入参 / 结果的那一层——统一判定。
 *
 * 判据只看「工具确实做成了这件事」：cwd 前后不同；task 工具成功且结果里有 id / status。
 * 全部 fire-and-forget：通知类事件不能拖慢或打断工具结果回传。
 */

import type { HookSystem } from "../hook/system.ts";
import type { HookAgentRef } from "../hook/types.ts";
import { getLogger } from "../debug/logger.ts";

export function fireToolSideEvents(
  hookSystem: HookSystem | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  result: { output?: string; isError?: boolean },
  cwdBefore: string,
  cwdAfter: string,
  /**
   * 子代理执行链身份。子代理两条执行路径也调本函数（原先只有主循环调，
   * 子代理里 cd / task_create 不发事件）；带上它，hook 才分得清是谁 cd 的。
   */
  agent?: HookAgentRef,
): void {
  if (!hookSystem) return;
  const log = getLogger();
  // 主循环不传 agent → opts 为 undefined，fire 调用形态与改动前一致
  const opts = agent ? { agent } : undefined;
  const swallow = (event: string) => (e: unknown) =>
    log.error("HOOK", `${event} hook 失败: ${(e as Error)?.message ?? e}`);

  // CwdChanged：bash 的 `cd` 由 bash 工具 setCwd 落地，这里只比对前后
  if (cwdBefore !== cwdAfter) {
    hookSystem.fireCwdChangedEvent(cwdBefore, cwdAfter, opts).catch(swallow("cwd_changed"));
  }

  if (result.isError || (toolName !== "task_create" && toolName !== "task_update")) return;
  const parsed = parseTaskOutput(result.output);
  if (!parsed?.id) return;

  if (toolName === "task_create") {
    const desc =
      typeof toolInput.description === "string" ? toolInput.description : (parsed.subject ?? "");
    hookSystem.fireTaskCreatedEvent(parsed.id, desc, opts).catch(swallow("task_created"));
    return;
  }
  // task_update：只有本次调用把状态置为 completed 才算完成（重复置 completed 也 fire，与 CC 一致）
  if (toolInput.status === "completed" && parsed.status === "completed") {
    hookSystem
      .fireTaskCompletedEvent(parsed.id, parsed.subject ?? "", true, undefined, opts)
      .catch(swallow("task_completed"));
  }
}

function parseTaskOutput(
  output: string | undefined,
): { id?: string; subject?: string; status?: string } | undefined {
  if (!output) return undefined;
  try {
    const v = JSON.parse(output) as Record<string, unknown>;
    return {
      id: typeof v.id === "string" || typeof v.id === "number" ? String(v.id) : undefined,
      subject: typeof v.subject === "string" ? v.subject : undefined,
      status: typeof v.status === "string" ? v.status : undefined,
    };
  } catch {
    return undefined;
  }
}
