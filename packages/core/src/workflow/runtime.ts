/**
 * Dynamic Workflows M1/M3 — 编排运行时
 *
 * 把 workflow 脚本里的原语(agent/parallel/pipeline/phase/log)接到真实的 SubAgent 执行 +
 * 独立并发调度器(scheduler.ts)。本文件不直接 import SubAgent,而是通过 AgentRunner 接口
 * 解耦——这样:
 *   ① M1 可以注入假 runner 做单测(不打真 LLM);
 *   ② 真实 runner(包 SubAgent.fromRegistry/execute)在 M6 接线时注入。
 *
 * 规模上限(对齐 cc 一手 spec §4.2):
 *   - 单 run 总 agent 数 ≤ 1000(runaway-loop 后备闸)
 *   - 单个 parallel/pipeline 调用 items ≤ 4096(超过显式报错)
 *   - 并发由 Scheduler 控制(cap = min(16, cores-2))
 */

import { Scheduler } from "./scheduler.ts";
import { Journal, computeFingerprint } from "./journal.ts";
import type { AgentOpts, Budget, PipelineStage, WorkflowApi } from "./types.ts";

/** 单 run 总 agent 上限(runaway 后备) */
export const MAX_AGENTS_PER_RUN = 1000;
/** 单个 parallel/pipeline 调用的 items 上限 */
export const MAX_ITEMS_PER_CALL = 4096;

/**
 * agent() 真正干活的抽象。runtime 只负责调度/计数/预算,把"开一个子代理拿结果"委托给它。
 * 真实实现包 SubAgent;测试实现返回桩值。
 */
export interface AgentRunner {
  /**
   * 执行一次 agent 调用。
   * @param prompt  agent 的任务提示
   * @param opts    schema/model/effort/agentType/isolation 等
   * @param ctx     运行上下文(调用序号、所属 phase、abort 信号)
   * @returns       无 schema → string;有 schema → 校验后的对象;失败/被 skip → null
   */
  run(prompt: string, opts: AgentOpts | undefined, ctx: AgentCallContext): Promise<unknown>;
}

/** 单次 agent 调用的上下文 */
export interface AgentCallContext {
  /** 调用序号(0-based,贯穿整个 run,resume 缓存键的一部分) */
  callIndex: number;
  /** 所属 phase 标题(opts.phase 优先,否则取当前全局 phase) */
  phase?: string;
  /** 显示标签(opts.label 优先,否则自动生成) */
  label: string;
  /** 中止信号 */
  signal: AbortSignal;
}

/** 进度上报回调(接 TUI / SDK 事件) */
export interface ProgressSink {
  /** log() 透传的叙述行 */
  onLog?(message: string): void;
  /** phase() 切换 */
  onPhase?(title: string): void;
  /** 一次 agent 调用开始 */
  onAgentStart?(ctx: AgentCallContext): void;
  /** 一次 agent 调用结束(success=false 表示返回 null) */
  onAgentEnd?(ctx: AgentCallContext, success: boolean): void;
}

/** 运行时构造参数 */
export interface RuntimeOptions {
  runner: AgentRunner;
  /** Workflow 调用传入的 args */
  args?: unknown;
  /** token 预算总额;null=不限 */
  budgetTotal?: number | null;
  /** 已花费 token 的实时读取(共享池;由宿主提供)。缺省时按本 run 内累计估算。 */
  spentReader?: () => number;
  /** 并发上限(默认 scheduler 自解析) */
  concurrency?: number;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 进度上报 */
  progress?: ProgressSink;
  /** M5: resume journal。提供时 agent() 命中缓存直接返回,否则真跑后追加。 */
  journal?: Journal;
}

/** 预算耗尽时 agent() 抛出的错误(可被 budget 守卫识别) */
export class BudgetExceededError extends Error {
  constructor(total: number, spent: number) {
    super(
      `[workflow] token 预算已耗尽(上限 ${total},已花 ${spent})。再调 agent() 被拒;请收窄 workflow 规模或提高预算。`,
    );
    this.name = "BudgetExceededError";
  }
}

/** 单 run agent 数超限错误 */
export class AgentLimitError extends Error {
  constructor() {
    super(
      `[workflow] 单次 run 的 agent 调用已达上限 ${MAX_AGENTS_PER_RUN}(runaway-loop 后备闸)。检查是否有未收敛的循环。`,
    );
    this.name = "AgentLimitError";
  }
}

/**
 * 编排运行时。一次 workflow run 对应一个实例。
 * 通过 `api` 暴露给沙箱注入。
 */
export class WorkflowRuntime {
  private readonly runner: AgentRunner;
  private readonly scheduler: Scheduler;
  private readonly progress?: ProgressSink;
  private readonly signal: AbortSignal;
  private readonly journal?: Journal;

  /** 全局调用序号(贯穿整个 run) */
  private callCounter = 0;
  /** 当前 phase(phase() 设置;pipeline/parallel 内用 opts.phase 覆盖避免竞态) */
  private currentPhase: string | undefined;
  /** 本 run 内累计输出 token(spentReader 缺省时的兜底) */
  private localSpent = 0;

  readonly args: unknown;
  readonly budget: Budget;

  constructor(opts: RuntimeOptions) {
    this.runner = opts.runner;
    this.scheduler = new Scheduler(opts.concurrency);
    this.progress = opts.progress;
    this.signal = opts.signal ?? new AbortController().signal;
    this.journal = opts.journal;
    this.args = opts.args;

    const budgetTotal = opts.budgetTotal ?? null;
    const spentReader = opts.spentReader ?? (() => this.localSpent);
    this.budget = {
      total: budgetTotal,
      spent: () => spentReader(),
      remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - spentReader())),
    };
  }

  /** 本 run 已发起的 agent 调用总数(测试/可观测) */
  get agentCallCount(): number {
    return this.callCounter;
  }

  /** 调度器(测试/可观测) */
  get sched(): Scheduler {
    return this.scheduler;
  }

  /** 累加本地花费(真实 runner 拿到 usage 后回调;测试也可用) */
  addLocalSpent(tokens: number): void {
    this.localSpent += tokens;
  }

  // ---------- 原语实现 ----------

  /** agent(prompt, opts?) */
  private agent = async (prompt: string, opts?: AgentOpts): Promise<unknown> => {
    // 预算硬门:达上限即抛(对齐 cc:spent 达 total 后 agent() 抛错)
    if (this.budget.total !== null && this.budget.remaining() <= 0) {
      throw new BudgetExceededError(this.budget.total, this.budget.spent());
    }
    // runaway 后备闸
    if (this.callCounter >= MAX_AGENTS_PER_RUN) {
      throw new AgentLimitError();
    }
    const callIndex = this.callCounter++;
    const phase = opts?.phase ?? this.currentPhase;
    const label = opts?.label ?? `agent#${callIndex}`;
    const ctx: AgentCallContext = { callIndex, phase, label, signal: this.signal };

    // M5: resume —— 命中 journal 缓存直接返回(同序号 + 指纹一致)。
    // 指纹不一致(脚本被改过)或未记录 → 真跑。注:callCounter 已自增,序号语义稳定。
    const fingerprint = computeFingerprint(prompt, opts as Record<string, unknown> | undefined);
    if (this.journal) {
      const hit = this.journal.lookup(callIndex, fingerprint);
      if (hit) {
        this.progress?.onAgentStart?.(ctx);
        this.progress?.onAgentEnd?.(ctx, hit.result !== null);
        return hit.result;
      }
    }

    this.progress?.onAgentStart?.(ctx);
    // 经调度器执行(背压);runner 抛错时这里也抛,由 parallel/pipeline 决定吞成 null
    try {
      const result = await this.scheduler.run(() => this.runner.run(prompt, opts, ctx));
      // M5: 真跑成功后追加 journal(失败不缓存,下次重跑)
      this.journal?.record({ callIndex, fingerprint, result, label });
      this.progress?.onAgentEnd?.(ctx, result !== null);
      return result;
    } catch (err) {
      this.progress?.onAgentEnd?.(ctx, false);
      throw err;
    }
  };

  /** parallel(thunks) — 屏障语义,抛错落 null,调用本身不 reject */
  private parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) {
      throw new TypeError("[workflow] parallel(thunks) 的参数必须是数组(每项是 () => Promise)");
    }
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new RangeError(
        `[workflow] parallel 一次最多 ${MAX_ITEMS_PER_CALL} 项,收到 ${thunks.length} 项。请分批或用更粗的粒度。`,
      );
    }
    // 每个 thunk 包成"抛错落 null";调度器已在 agent() 内部,这里只负责聚合
    return Promise.all(
      thunks.map((thunk) =>
        Promise.resolve()
          .then(() => thunk())
          .catch(() => null),
      ),
    );
  };

  /** pipeline(items, ...stages) — 无屏障逐项推进(M3 灵魂) */
  private pipeline = async (items: unknown[], ...stages: PipelineStage[]): Promise<unknown[]> => {
    if (!Array.isArray(items)) {
      throw new TypeError("[workflow] pipeline(items, ...stages) 的 items 必须是数组");
    }
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new RangeError(
        `[workflow] pipeline 一次最多 ${MAX_ITEMS_PER_CALL} 项,收到 ${items.length} 项。`,
      );
    }
    // 关键:每个 item 独立穿过所有 stage,stage 间无屏障。
    // 用 Promise.all 启动所有 item 链,但每条链内部 stage 顺序 await——
    // 因此 item A 可在 stage3 时 item B 还在 stage1(墙钟=最慢单链)。
    const runItemChain = async (item: unknown, index: number): Promise<unknown> => {
      let prev: unknown = item;
      for (let s = 0; s < stages.length; s++) {
        try {
          // 第一个 stage 收原始 item 作为 prevResult(对齐 cc:stage1 收 item)
          prev = await stages[s]!(prev, item, index);
        } catch {
          // 某 stage 抛错 → 该 item 落 null,跳过剩余 stage(其他 item 不受影响)
          return null;
        }
      }
      return prev;
    };
    return Promise.all(items.map((item, i) => runItemChain(item, i)));
  };

  /** phase(title) — 切换当前进度组 */
  private phase = (title: string): void => {
    this.currentPhase = title;
    this.progress?.onPhase?.(title);
  };

  /** log(message) — 透传叙述行 */
  private log = (message: string): void => {
    this.progress?.onLog?.(message);
  };

  /**
   * 组装注入沙箱的 API。
   * @param workflowFn  M6 注入的内联子 workflow 实现(可选)
   * @param argsOverride 覆盖注入的 args(子 workflow 用,传自己的 args 而非父的)
   */
  buildApi(workflowFn?: WorkflowApi["workflow"], argsOverride?: { args: unknown }): WorkflowApi {
    return {
      agent: this.agent,
      parallel: this.parallel,
      pipeline: this.pipeline,
      phase: this.phase,
      log: this.log,
      args: argsOverride ? argsOverride.args : this.args,
      budget: this.budget,
      workflow: workflowFn,
    };
  }
}
