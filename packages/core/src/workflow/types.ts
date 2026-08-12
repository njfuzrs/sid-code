/**
 * Dynamic Workflows — 共享类型定义
 *
 * 对标 cc 的 Workflow 工具契约（见 docs/.../Dynamic Workflows 官方权威参考.md §3）。
 * 这里只放纯类型,运行时实现分散在 sandbox.ts / scheduler.ts / runtime.ts / journal.ts。
 */

/** workflow 脚本顶部 `export const meta = {...}` 的结构(必须是纯字面量) */
export interface WorkflowMeta {
  /** 必填:workflow 名(权限弹窗、task 标签、保存文件名都用它) */
  name: string;
  /** 必填:一行描述,权限弹窗里展示 */
  description: string;
  /** 可选:何时用,workflow 列表里展示 */
  whenToUse?: string;
  /** 可选:每个 phase() 调用一条,title 与脚本里 phase() 标题字面匹配 */
  phases?: PhaseSpec[];
}

/** meta.phases 单条 */
export interface PhaseSpec {
  title: string;
  detail?: string;
  /** 该 phase 用特定模型时标注 */
  model?: string;
}

/** agent(prompt, opts?) 的 opts */
export interface AgentOpts {
  /** 给 JSON Schema → 强制结构化输出,agent() 返回已校验对象(M2) */
  schema?: Record<string, unknown>;
  /** 覆盖显示标签 */
  label?: string;
  /** 显式归到某进度组(在 pipeline/parallel 内用,防 phase() 全局态竞态) */
  phase?: string;
  /** 覆盖模型;省略=继承主循环模型(M4) */
  model?: string;
  /** 覆盖推理强度 low|medium|high|xhigh|max;省略=继承会话 */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** 独立 git worktree(贵!仅当 agent 并行改文件会冲突时用)(M4) */
  isolation?: "worktree";
  /** 用自定义 subagent 类型(从 Agent 工具同一注册表解析) */
  agentType?: string;
}

/** token 预算(M6),由 runtime 注入为全局 `budget` */
export interface Budget {
  /** 本轮 token 目标;没设则为 null */
  total: number | null;
  /** 本轮主循环 + 所有 workflow 的输出 token 之和(池子共享) */
  spent(): number;
  /** max(0, total - spent());没设目标则 Infinity */
  remaining(): number;
}

/** agent() 原语签名 */
export type AgentFn = (prompt: string, opts?: AgentOpts) => Promise<unknown>;

/** parallel(thunks) 原语签名 —— 参数是 thunk 数组,不是调用结果 */
export type ParallelFn = (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;

/** pipeline 单个 stage 回调:收 (上一阶段结果, 原始 item, 下标) */
export type PipelineStage = (
  prevResult: unknown,
  originalItem: unknown,
  index: number,
) => Promise<unknown> | unknown;

/** pipeline(items, ...stages) 原语签名 */
export type PipelineFn = (items: unknown[], ...stages: PipelineStage[]) => Promise<unknown[]>;

/** phase(title) 原语签名 */
export type PhaseFn = (title: string) => void;

/** log(message) 原语签名 */
export type LogFn = (message: string) => void;

/** workflow(nameOrRef, args?) 原语签名(内联跑子 workflow) */
export type WorkflowFn = (
  nameOrRef: string | { scriptPath: string },
  args?: unknown,
) => Promise<unknown>;

/**
 * 注入到脚本沙箱里的全部 workflow API。
 * sandbox.ts 负责把这些挂成脚本可见的全局,runtime.ts 负责提供真实实现。
 */
export interface WorkflowApi {
  agent: AgentFn;
  parallel: ParallelFn;
  pipeline: PipelineFn;
  phase: PhaseFn;
  log: LogFn;
  /** Workflow 调用时传入的 args,逐字可见 */
  args: unknown;
  budget: Budget;
  /** 内联跑另一个 workflow(嵌套仅一层) */
  workflow?: WorkflowFn;
}

/** 沙箱执行结果 */
export interface SandboxResult {
  /** 脚本 return 的值(可能 undefined) */
  value: unknown;
  /** 校验通过的 meta */
  meta: WorkflowMeta;
}

/** meta 校验结果 */
export type MetaValidation = { ok: true; meta: WorkflowMeta } | { ok: false; error: string };
