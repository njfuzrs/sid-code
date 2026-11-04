/**
 * 子代理 worktree 隔离「建了没用」的埋点（O1，会话 f5beebde 复盘 PR6）
 *
 * ## 为什么需要这个模块
 *
 * `sub_agent` 的 `isolation=worktree` 会给子代理真建一个 git worktree（`git worktree add`
 * + 复制本地配置 + 可能装依赖），结束时再跑一次 `git status` 判改动、无改动才删。对**只读**
 * 子代理（explore / plan / verify）这套开销是纯浪费：目录里一个文件都不会变，建与删的每一步
 * 都白付。
 *
 * 复盘会话里有 3 个只读 git 历史核查子代理都传了 `isolation: "worktree"`。修法分两步——
 * 先把判据写进工具描述（从源头劝退），再用这条事件**量出这类浪费有多常见**，一周后再决定
 * 要不要做更强的约束。没有分母的「要不要加约束」只能凭感觉，所以打点必须先落地。
 *
 * ## 为什么走模块级 sink 而不是给 SubAgentTool 穿参数
 *
 * 与 `trace/jit-telemetry.ts` 同一个理由：`agent/tool.ts` 的 worktree 清理点（`setupIsolation`
 * 的 cleanup 闭包）拿不到 `TraceCollector`（它是 `App` 私有），而 `App` 之后才创建 collector
 * ——「工具先注册、collector 后就绪」这个时序在主仓已用模块级 sink 解决过多轮
 * （jit / file-freshness / skill / task-lifecycle / subagent-cost 都是同一模式）。
 * 同一进程只有一个会话（与 collector 本身的假设一致），模块级单例在此安全；
 * 测试用 `setIsolationUnusedTraceSink(null)` 复位。
 *
 * ## 判据口径
 *
 * 「浪费」= 子代理结束时该 worktree 的 `changedFiles === 0 && commits === 0`。这个判据
 * 直接复用 `WorktreeManager.countChanges`（与 `remove()` 的「无改动才删」同源），不另立
 * 一套——两套判据必然漂移，而漂移会让事件与真实删除行为对不上。
 *
 * ## 为什么暴露 `hasIsolationUnusedTraceSink()`
 *
 * 判定要在调用方跑一次 `countChanges`（同步 `git status`）。埋点关闭时那次 git status
 * 是纯白付——不启用遥测的用户、headless / CI 环境都不该为一个不落地的事件多付收尾开销。
 * 所以把「sink 在不在」变成显式查询，让调用方在**测量之前**短路，而不是测完再发现没人收。
 */

/** 事件名常量 —— 生产侧（agent/tool.ts）与消费侧（轨迹查询 / 后续统计）共用，避免字面量漂移 */
export const SUBAGENT_ISOLATION_UNUSED_EVENT_NAME = "SubagentIsolationUnused";

/** 埋点写入通道（由 App 注入，指向 `TraceCollector.recordCustomEvent`） */
export type IsolationUnusedTraceSink = (data: Record<string, unknown>) => void;

let sink: IsolationUnusedTraceSink | null = null;

/**
 * 注入/清除埋点通道。
 * 传 `null` 表示关闭（轨迹未启用、或测试收尾复位）。
 */
export function setIsolationUnusedTraceSink(s: IsolationUnusedTraceSink | null): void {
  sink = s;
}

/**
 * 埋点是否启用。
 *
 * 调用方（`agent/tool.ts` 的 cleanup）在判定「有没有白建」之前要先跑一次
 * `countChanges`（同步 `git status`）。埋点关闭时那次 git status 是纯白付——
 * 不启用遥测的用户、headless / CI 环境都不该为一个不落地的事件多付收尾开销。
 * 所以把「sink 在不在」暴露成显式查询，让调用方在**测量之前**短路。
 */
export function hasIsolationUnusedTraceSink(): boolean {
  return sink !== null;
}

/**
 * 记录一条「worktree 建了但一个改动都没有」的子代理结束事件。
 *
 * 字段口径服务于后续决策（要不要做更强的约束）：
 * - `agent_type`：哪些类型最常白建（explore/plan/verify 是只读类型，命中即典型误用）
 * - `worktree_name`：`agent-<hex>`，可与 `SubagentStart.agent_cwd` 的路径尾段对上
 * - `lifetime_ms`：worktree 从创建到清理存活多久（白付的墙钟量级）
 * - `description`：派活意图（与 `SubagentStart.description` 同源同尺度）
 * - `success`：本次子代理执行是否成功。没有它，「只读任务误用」与「任务本来就失败、
 *   worktree 只是陪着白建」两种样本分不开，一周后的占比统计会把失败样本算进分母。
 *
 * 不抛异常：埋点失败不能影响子代理收尾（worktree 清理才是关键路径）。
 */
export function emitSubagentIsolationUnused(data: {
  agentType: string;
  description: string;
  worktreeName: string;
  lifetimeMs: number;
  success: boolean;
}): void {
  if (!sink) return;
  try {
    sink({
      agent_type: data.agentType,
      description: data.description,
      worktree_name: data.worktreeName,
      lifetime_ms: data.lifetimeMs,
      success: data.success,
      // 判据命中的前提就是零改动；显式落 0 让消费侧不必依赖「字段缺失 = 0」的约定。
      changed_files: 0,
      commits: 0,
    });
  } catch {
    /* 埋点失败静默：不影响子代理收尾 */
  }
}
