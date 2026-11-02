/**
 * 账本行构造 —— 从 `packages/cli/src/app.ts` 的 App 私有方法下沉到 core（方案模块 D1）。
 *
 * 为什么下沉：这段逻辑产出的是长期回溯用的账本行（`usage-ledger.jsonl` 每会话一行），
 * 口径错了不会有任何报错，只会给出错误结论（"这个 release 更省了吗"直接受它影响）。
 * 而它此前长在 App 类里，只能靠起整个 CLI 才测得到，等于没有回归保护。
 * 下沉成纯函数之后可以用真实 SessionState 直接单测，行为与下沉前逐字一致 ——
 * 唯一的显式差异是多了 `now` / `fallbackModel` / `fallbackProvider` 三个注入点，
 * 它们的默认值与原来直接读 `Date.now` / `this.config` 完全相同。
 */

import type { SessionState } from "../session/state.ts";
import type { UsageLedgerEntry } from "./usage-ledger.ts";
import { getIdentity } from "../identity/index.ts";
import { getRawVersion } from "@sid-code/shared/version.ts";
import { getPeakRatio } from "../llm/billing-sink.ts";
import { getSessionSideStats } from "../trace/side-call-sink.ts";
import { getSessionAgentUsage } from "./agent-usage.ts";

/**
 * 取影子调用的聚合用量供账本使用；无影子调用时返回空对象（不落三个恒零字段）。
 *
 * 落 0 与"旧数据没有这个字段"在读侧无法区分，而账本要长期回溯 —— 字段缺失
 * 明确表示"本会话没有影子调用"，比一个 0 更诚实。
 */
function buildLedgerSideUsage(): {
  sideInputTokens?: number;
  sideOutputTokens?: number;
  sideCostUSD?: number;
} {
  try {
    // N12：取会话维度，与同一行 costUSD（getEffectiveTotalCostUSD，含 resume 回灌的
    // sideCostUSD）同口径；取进程维度会让 resume 后的行「成本含历史、token 不含」。
    const s = getSessionSideStats();
    if (s.apiCalls <= 0) return {};
    return {
      sideInputTokens: s.tokensSent,
      sideOutputTokens: s.tokensReceived,
      sideCostUSD: s.costUSD,
    };
  } catch {
    // 影子调用统计不可用绝不影响账本主体落盘
    return {};
  }
}

/**
 * 从 SessionState 构造账本行；空会话（无 API 调用）返回 null。
 *
 * - 经 SessionState.getNormalizedCacheUsage() 单一事实源派生三段，口径与 Footer/摘要一致。
 * - 只存聚合数字，绝不含消息内容——隐私安全。
 *
 * `fallbackModel` / `fallbackProvider`：多模型会话里主模型取「请求数最多者」，
 * 取不到时才回退到调用方（CLI 传的是当前配置的 model/provider）。
 * `now`：时间注入点，仅供测试使用，默认 `Date.now`。
 */
export function buildUsageLedgerEntry(input: {
  sessionState: SessionState;
  fallbackModel?: string;
  fallbackProvider?: string;
  now?: () => number;
}): UsageLedgerEntry | null {
  const n = input.sessionState.getNormalizedCacheUsage();
  if (n.promptTotal <= 0) return null; // 空会话不落行
  const models = Object.entries(input.sessionState.modelUsage);
  // 主模型 = 请求数最多者（多模型会话取主导模型标注；token 仍为全会话汇总）
  const primary = models.sort(([, a], [, b]) => b.requests - a.requests)[0];
  const model = primary?.[0] ?? input.fallbackModel ?? "unknown";
  const provider = primary?.[1]?.provider ?? input.fallbackProvider ?? "unknown";
  const ident = getIdentity();
  return {
    ts: Math.floor((input.now ?? Date.now)() / 1000),
    sessionId: input.sessionState.sessionId,
    model,
    provider,
    promptTotal: n.promptTotal,
    cacheHit: n.cacheHitTokens,
    cacheWrite: n.cacheWriteTokens,
    uncachedInput: n.uncachedInputTokens,
    output: n.outputTokens,
    costUSD: input.sessionState.getEffectiveTotalCostUSD(),
    savingsUSD: input.sessionState.getTotalCacheSavings(),
    durationMs: input.sessionState.getElapsedMs(),
    // P2-1：影子调用 token 接线。costUSD 走 getEffectiveTotalCostUSD() 已含
    // sideCostUSD，而上面的 token 三段只遍历 modelUsage（不含影子调用）——
    // 同一行里成本与 token 口径不同，"成本 ÷ token"就算不出来。影子调用的
    // token 早在 side-call-sink 采集，这里只是接上，不是新建埋点。
    ...buildLedgerSideUsage(),
    // P0-4：主模型的端点 host，供缓存视图按渠道标注可信度（不可信渠道不进总计）。
    // 取主模型而非 config.baseURL：多模型会话里账本行标注的是主导模型，
    // 端点必须与之对应，否则会把 A 渠道的可信度贴到 B 渠道的数字上。
    ...(primary?.[1]?.endpointHost ? { endpointHost: primary[1].endpointHost } : {}),
    // P0-1：写这一行的 sid-code 版本号。两个用途：① 四方向第 3 级的 release-over-release
    // 曲线唯一分组键；② 让消费侧能把「08-08 前用旧采集代码写的脏数据」隔离出总计（P2-9）。
    // 无条件写（不像上面几个字段做存在性判断）：版本号永远拿得到，缺失只发生在存量行上，
    // 而「缺失」本身正是消费侧用来识别存量数据的信号。
    // env 覆盖与 `analytics/metadata.ts:184`、`trace/collector.ts` 同一口径。
    appVersion: process.env.SID_CODE_VERSION ?? getRawVersion(),
    deviceId: ident.deviceId,
    ...(ident.userId ? { userId: ident.userId } : {}),
    ...(ident.orgId ? { orgId: ident.orgId } : {}),
    ...(ident.teamId ? { teamId: ident.teamId } : {}),
    // D1 / §5.5：本会话请求落在高峰时段的比例。采集点在 `llm/billing-sink.ts`
    // （唯一必然经过的点 —— 挂消费侧只数得到 fork，是个偏样本）。
    // `undefined` = 本会话没有任何分时段模型，此时**不落字段**（落 0 会与
    // "全部落在空闲时段"这个真实的好结果混在一起）。
    ...(getPeakRatio() !== undefined ? { peakRatio: getPeakRatio() } : {}),
    // T1.2：按调用方聚合。空表不落字段（与上面可选字段同一缺失语义）。
    ...buildLedgerByAgent(),
  };
}

function buildLedgerByAgent(): { byAgent?: NonNullable<UsageLedgerEntry["byAgent"]> } {
  try {
    const m = getSessionAgentUsage();
    return m ? { byAgent: m } : {};
  } catch {
    return {};
  }
}
