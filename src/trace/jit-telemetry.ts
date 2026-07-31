/**
 * JIT 上下文埋点的单一事实源（第 5 批）
 *
 * ## 为什么需要这个模块
 *
 * 第 1 批把埋点写在 `app.ts` 里，只覆盖主循环。第 3 批（P2-1）给子代理接了独立的
 * `JitContextManager`，但**没接埋点** —— 于是任何用到子代理的会话，JIT 命中率与
 * 字节量都是系统性偏低的。度量算错比没有度量更糟：它会让后续的成本治理决策
 * （第 6 批的淘汰策略）建立在错的曲线上。
 *
 * 子代理不持有 `TraceCollector`（它由 `App` 私有，且子代理有 6 处创建点，
 * 逐个穿线要改 6 个签名）。这里用「模块级 sink + 共享 payload 构造」收口：
 * - `App` 在 collector 就绪后调一次 `setJitTraceSink`
 * - 主循环与子代理都走 `emitJitEvent`，落到同一个 events.jsonl
 * - `source` 字段区分两条通道，避免把子代理的命中算成主循环的
 *
 * 同一进程只有一个会话（与 `TraceCollector` 本身同样的假设），故模块级单例
 * 在此是安全的；测试用 `setJitTraceSink(null)` 复位。
 */

import { basename, relative } from "path";

/** JIT 埋点写入通道（由 App 注入，指向 `TraceCollector.recordCustomEvent`） */
export type JitEventSink = (data: Record<string, unknown>) => void;

/** 事件名常量 —— 生产侧与消费侧（`digest.ts:aggregateJitStats`）共用，避免字面量漂移 */
export const JIT_EVENT_NAME = "jit_context";

let sink: JitEventSink | null = null;

/**
 * 注入/清除埋点通道。
 * 传 `null` 表示关闭（轨迹未启用、或测试收尾复位）。
 */
export function setJitTraceSink(s: JitEventSink | null): void {
  sink = s;
}

/** JIT 发现结果里埋点需要的那部分（避免本模块反向依赖 config 层的完整类型） */
interface JitDiscoveryLike {
  loaded: Array<{ relPath: string; bytes: number; reason: string; oversized: boolean }>;
  scopeSkipped: number;
  failures: Array<{ path: string; code: string; phase: string }>;
  elapsedMs: number;
}

/**
 * 构造 `jit_context` 事件的 data 体。
 *
 * 字段口径服务于四个具体问题（不是"先埋着以后再说"）：
 *  1. 命中率 → `hit` / `loaded_count`（**未命中也要打点**，否则分母永远缺失）
 *  2. 累积成本 → `injected_bytes` / `cumulative_bytes`（§10.3 的曲线靠后者）
 *  3. 浪费率与静默失效 → `scope_skipped` / `failures`
 *  4. 是否进 TTFT → `elapsed_ms`（P2-3 fire-and-forget 的实测验收）
 *
 * 路径统一转相对项目根：轨迹会上传，绝对路径含用户名等隐私信息。
 */
export function buildJitEventData(opts: {
  accessedPath: string;
  projectRoot: string;
  discovery: JitDiscoveryLike;
  /** manager 当前持有的去重总量（`getLoadedBytes()`） */
  cumulativeBytes: number;
  /** 哪条通道触发的 —— 主循环还是子代理 */
  source: "main" | "subagent";
}): Record<string, unknown> {
  const { accessedPath, projectRoot, discovery: r, cumulativeBytes, source } = opts;
  const rel = (p: string) => {
    try {
      const r2 = relative(projectRoot, p);
      // 项目外路径（不该出现，出现即边界判定有问题）只记文件名，不泄露绝对路径
      return !r2 || r2.startsWith("..") ? basename(p) : r2;
    } catch {
      return basename(p);
    }
  };

  return {
    source,
    accessed_path: rel(accessedPath),
    hit: r.loaded.length > 0,
    loaded_count: r.loaded.length,
    loaded: r.loaded.map((l) => ({
      path: l.relPath,
      bytes: l.bytes,
      reason: l.reason,
      oversized: l.oversized,
    })),
    injected_bytes: r.loaded.reduce((s, l) => s + l.bytes, 0),
    /** 会话累计（含本次）：§10.3 的"累积总量"曲线就靠这个字段画 */
    cumulative_bytes: cumulativeBytes,
    scope_skipped: r.scopeSkipped,
    failures: r.failures.map((f) => ({ path: rel(f.path), code: f.code, phase: f.phase })),
    elapsed_ms: Math.round(r.elapsedMs),
  };
}

/** 写一条 JIT 事件。sink 未注入或写入抛错都静默 —— 埋点绝不影响主流程。 */
export function emitJitEvent(data: Record<string, unknown>): void {
  try {
    sink?.(data);
  } catch {
    /* 埋点失败静默 */
  }
}
