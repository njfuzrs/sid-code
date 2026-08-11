/**
 * 子代理嵌套深度上下文（P3-1，AsyncLocalStorage）
 *
 * 背景：此前用布尔式 `_agentId` 标记"我在子代理里"，一律禁止再 spawn（三道防线：
 * tool-filter 裁掉 sub_agent 工具、tool.ts 拿到 _agentId 直接报错、prompt 明说不能嵌套）。
 * 这挡住了所有嵌套，包括合理的两层分治（leader → 3 个模块 explore → 每个模块内再分文件）。
 *
 * 放开的核心风险是**指数爆炸**：深度 d、每层 fan-out k，总代理数 O(k^d)。所以放开必须同时卡两道：
 *   ① 深度上限（MAX_DEPTH）——限制 d，默认 2（主代理→子→孙）。
 *   ② 全树并发闸——SubAgentTool 的信号量本就是**全局静态**的，天然是全树共享，
 *      不是每层各自 N 个。这点很关键：它把 O(k^d) 的**瞬时**并发压回常数。
 *
 * 但全树共享信号量带来死锁风险：父代理持有 slot 等子代理，子代理排队等 slot，
 * 若所有 slot 都被父辈占着，队列永远推不动。解法见 tool.ts 的 acquireSlot——
 * 嵌套层（depth ≥ 1）走**免排队**通道（不占信号量），因为父辈已经为这条链占了一个 slot，
 * 子代理是在父辈的 slot 额度内执行，不额外增加"活跃链"数量。
 *
 * 默认关闭（需 SID_ENABLE_NESTED_SUBAGENT=1 显式开启），保持现状行为不变。
 *
 * ⚠️ 低依赖：不 import 业务模块。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const depthStorage = new AsyncLocalStorage<number>();

/** 嵌套深度硬上限（主代理=0，其子代理=1，孙代理=2）。超过则拒绝 spawn。 */
export const MAX_AGENT_DEPTH = 2;

/**
 * 嵌套是否开启。默认关闭——放开嵌套会改变成本模型（代理数随深度增长），
 * 需用户显式 opt-in。关闭时行为与改造前完全一致（子代理不能再 spawn）。
 */
export function isNestedSubAgentEnabled(
  raw: string | undefined = process.env.SID_ENABLE_NESTED_SUBAGENT,
): boolean {
  return raw === "1" || raw === "true";
}

/** 解析深度上限（env 可调，非法/缺省回退 MAX_AGENT_DEPTH，且永不超过它）。 */
export function resolveMaxDepth(
  raw: string | undefined = process.env.SID_SUBAGENT_MAX_DEPTH,
): number {
  if (raw === undefined || raw === "") return MAX_AGENT_DEPTH;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return MAX_AGENT_DEPTH;
  // 上限封顶：env 不能把深度调到超过硬上限（防误配导致指数爆炸）。
  return Math.min(n, MAX_AGENT_DEPTH);
}

/** 当前嵌套深度（主代理上下文=0）。 */
export function getAgentDepth(): number {
  return depthStorage.getStore() ?? 0;
}

/** 在深度 +1 的上下文里运行 fn（子代理执行体包在这里面）。 */
export function withIncrementedDepth<T>(fn: () => T): T {
  return depthStorage.run(getAgentDepth() + 1, fn);
}

/**
 * 当前深度是否还允许再 spawn 子代理。
 *
 * - 嵌套未开启：只有主代理（depth 0）可以 spawn（= 改造前行为）。
 * - 嵌套已开启：depth < maxDepth 才可以。
 */
export function canSpawnSubAgent(): boolean {
  const depth = getAgentDepth();
  if (depth === 0) return true;
  if (!isNestedSubAgentEnabled()) return false;
  return depth < resolveMaxDepth();
}

/** 拒绝 spawn 时给模型的说明（区分"未开启"与"已达上限"，便于模型改换策略）。 */
export function describeSpawnRejection(): string {
  const depth = getAgentDepth();
  if (!isNestedSubAgentEnabled()) {
    return "子代理不允许嵌套调用子代理。如需并行执行多个任务，请在主代理层面直接使用多个 sub_agent 调用。";
  }
  return (
    `已达子代理嵌套深度上限（当前深度 ${depth}，上限 ${resolveMaxDepth()}）。` +
    `请自己完成剩余工作，或把需要进一步分治的部分作为结论返回给上层代理。`
  );
}
