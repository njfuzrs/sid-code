/**
 * 子代理墙钟预算：按**实测吞吐**派生，而不是所有模型共用一个 300s（P0-1(c)）。
 *
 * ## 为什么不能所有模型写死 300s
 *
 * 事故实测（2026-08-11 会话，n=254 的 `stream_completed`）：主 agent 单轮 elapsed
 * **p50 = 6.1s、p95 = 19.1s、max = 102.8s**。300s ÷ 6.1s ≈ 25 轮上限，而其中一个 task
 * 子代理在 **294.3s** 时最后一次活动仍是 `grep`——**连编辑阶段都没进去**。给的预算连
 * "读懂上下文"都不够，却按"它超时了"归因。
 *
 * 慢模型（deepseek / glm 等）的单轮 p95 可以是快模型的三五倍，同一个 300s 对前者是
 * "跑三轮就没了"、对后者是"绰绰有余"。所以预算的正确单位不是**秒**，而是**轮数**：
 *
 * ```
 * budget = 单轮 p95 × 目标轮数
 * ```
 *
 * ## 与 (b) 交回残卷的分工（别把这条当主菜）
 *
 * 判据原话：**「300s 改 600s 只是把同样的浪费翻倍，交回残卷才是止损。」**
 * 本模块只让预算更贴合现实，真正的止损在 `salvage.ts`——到点后**交回已完成的成果**。
 * 两者一起做才成立：预算派生减少"到点"的次数，残卷保证"到点"时不再归零。
 *
 * ## 观测数据从哪来（以及为什么不去查 events.jsonl）
 *
 * 派生所需的 p95 由**进程内**的轮次耗时样本喂进来（`recordTurnLatency`），不读
 * `~/.sid-code/events.jsonl`：
 *   1. 子代理 spawn 在**关键路径**上，同步读盘 + 解析上千行 JSONL 会直接拖 TTFT；
 *   2. 落盘遥测一读就要考虑测试隔离（CLAUDE.md 测试约定那一整节），而这里本不需要落盘；
 *   3. 样本不足时的正确行为是**回退固定默认值**，不是"想办法凑出一个数"。
 *
 * 样本不足（< MIN_SAMPLES）时一律回退 `AgentDefinition.timeout`，行为与改造前逐字节一致——
 * 这保证本模块不会在冷启动会话里引入任何行为变化。
 */

/** 派生所需的最小样本数。少于这个数的 p95 是噪音，不足以支撑放大/收缩预算。 */
export const MIN_SAMPLES = 8;

/** 每个模型保留的最近轮次耗时样本数（环形缓冲）。 */
const MAX_SAMPLES_PER_MODEL = 64;

/**
 * 目标轮数：预算至少要够子代理跑这么多轮。
 *
 * 取 12 的依据来自事故实测的失败形态，不是拍脑袋：撞墙的 4 个子代理分别跑了
 * 16 / 11 / 8 / 5 轮，其中 8 轮和 5 轮那两个**明显不够用**（还停在 grep 阶段）。
 * 12 轮是"够读懂上下文 + 动手改几个文件"的下限。
 */
export const TARGET_TURNS = 12;

/** 派生结果的下限：不低于此值（防样本恰好极快时把预算压到形同虚设）。 */
export const DERIVED_MIN_MS = 120_000;
/** 派生结果的上限：与 custom.ts 的 CUSTOM_AGENT_TIMEOUT_MAX_MS 同值，保持两条路径同一天花板。 */
export const DERIVED_MAX_MS = 600_000;

/**
 * 硬 kill 相对墙钟预算的倍数（P0-1(a)）。
 *
 * detach 之后子代理继续在后台跑，但不能**永远**跑：跑到 `timeout × 这个倍数` 仍未结束，
 * 那已不是"慢"而是"失控"，此时才真正 abort（reason `subagent-hard-kill`）。
 * 取 3 是为了让"慢但会完成"的子代理有充分余量——detach 的意义就在于它还能跑完。
 */
export const HARD_KILL_MULTIPLIER = 3;

/** 每模型的轮次耗时样本（进程内，会话级；不落盘、不跨进程）。 */
const samples = new Map<string, number[]>();

/**
 * 记录一次轮次耗时（毫秒）。由子代理执行路径每轮调用，喂给后续的预算派生。
 *
 * 幂等性无要求、异常必须自吞：它挂在 `onTurnEnd` 上，抛异常等于让子代理白跑一场。
 */
export function recordTurnLatency(model: string | undefined, elapsedMs: number): void {
  if (!model) return;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  let arr = samples.get(model);
  if (!arr) {
    arr = [];
    samples.set(model, arr);
  }
  arr.push(elapsedMs);
  // 环形语义：只保留最近 N 条。模型的真实吞吐会随时段/网关负载漂移，
  // 无上限累积会让半小时前的样本继续拖住当下的判断。
  if (arr.length > MAX_SAMPLES_PER_MODEL) arr.shift();
}

/** 清空样本（测试用；生产路径不调用）。 */
export function resetTurnLatencySamples(): void {
  samples.clear();
}

/** 已积累的样本数（测试/诊断用）。 */
export function turnLatencySampleCount(model: string): number {
  return samples.get(model)?.length ?? 0;
}

/**
 * 求 p95（最近邻插值，与 trace/digest.ts 的 percentile 同口径）。
 *
 * 刻意不 import `trace/digest.ts` 的 percentile：那个模块会把整套轨迹分析依赖拉进
 * 子代理启动路径（它 import 了落盘/聚合一大串），为一个 5 行的分位数不值得。
 */
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

export interface ResolveTimeoutInput {
  /** AgentDefinition.timeout（或自定义 agent 的默认值）——样本不足时的回退值。 */
  definitionTimeoutMs: number | undefined;
  /** 调用方显式指定的 timeout（`task.timeout`）。**存在即最高优先级，不做派生。** */
  explicitTimeoutMs?: number | undefined;
  /** 子代理实际使用的模型名（派生的样本维度）。 */
  model?: string;
  /** 兜底默认（既有语义：120s）。 */
  fallbackMs: number;
}

export interface ResolvedTimeout {
  timeoutMs: number;
  /** 这个值是怎么来的——写进日志，避免"预算为什么是这个数"变成又一个黑盒。 */
  source: "explicit" | "env" | "derived" | "definition" | "fallback";
  /** 派生时的依据（source === "derived" 才有）。 */
  detail?: { p95Ms: number; samples: number };
}

/**
 * 解析子代理墙钟预算。优先级（自上而下，命中即返回）：
 *
 *   1. `task.timeout` 显式指定 —— 调用方比我们更清楚这次要跑多久，不猜。
 *   2. `SID_CODE_SUBAGENT_TIMEOUT_MS` env —— 运维/测试的统一覆盖入口。
 *   3. 实测派生（样本 ≥ MIN_SAMPLES）：`p95 × TARGET_TURNS`，钳到 [DERIVED_MIN, DERIVED_MAX]。
 *   4. `AgentDefinition.timeout` —— 各 agent 类型声明的值（改造前的唯一来源）。
 *   5. `fallbackMs`。
 *
 * 第 3 步只在样本足够时介入，且**只在派生值比声明值更大时才采用**——派生的目的是
 * "别把慢模型饿死"，不是"给快模型减预算"。收缩预算会让原本能跑完的子代理提前 detach，
 * 那是在用一个未被要求的优化换取回归风险。
 */
export function resolveSubAgentTimeout(input: ResolveTimeoutInput): ResolvedTimeout {
  if (input.explicitTimeoutMs !== undefined && input.explicitTimeoutMs > 0) {
    return { timeoutMs: input.explicitTimeoutMs, source: "explicit" };
  }

  const envRaw = process.env.SID_CODE_SUBAGENT_TIMEOUT_MS;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const n = Number(envRaw.trim());
    // 非法值静默回退到后续层级，绝不把 NaN 交给 setTimeout（那等价于立即触发）。
    if (Number.isFinite(n) && n > 0) return { timeoutMs: Math.floor(n), source: "env" };
  }

  const baseline = input.definitionTimeoutMs ?? input.fallbackMs;

  const arr = input.model ? samples.get(input.model) : undefined;
  if (arr && arr.length >= MIN_SAMPLES) {
    const perTurn = p95(arr);
    const derived = Math.min(DERIVED_MAX_MS, Math.max(DERIVED_MIN_MS, perTurn * TARGET_TURNS));
    // 只放大不收缩（见函数头注释）
    if (derived > baseline) {
      return {
        timeoutMs: Math.floor(derived),
        source: "derived",
        detail: { p95Ms: Math.round(perTurn), samples: arr.length },
      };
    }
  }

  return {
    timeoutMs: baseline,
    source: input.definitionTimeoutMs !== undefined ? "definition" : "fallback",
  };
}
