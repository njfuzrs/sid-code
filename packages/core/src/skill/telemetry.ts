/**
 * Skill 降级/拒绝埋点的单一事实源（P1-3）
 *
 * ## 为什么需要这个模块
 *
 * Skill 子系统里有四处「静默降级」：摘要 listing 只剩名字、描述被截断、
 * 权限判定异常 fail-open 放行、ask 无确认通道而拒绝执行。此前它们要么零日志
 * （budget.ts 全文没有一次 getLogger），要么只有一行本地 warn —— 按「防线触发率」
 * 口径这是分母恒为 0 的指标：不知道触发过没有，就等于不知道有没有 skill 是靠异常放行的。
 *
 * 收口方式与 `trace/jit-telemetry.ts` 同款（模块级 sink）：
 *   - 降级点散在 core 的纯函数里（budget.ts / executor.ts），拿不到 TraceCollector；
 *   - App 在 collector 就绪后调一次 `setSkillTraceSink`，事件落进同一个 events.jsonl；
 *   - sink 未注入（测试、轨迹关闭）时 emit 是空操作，埋点绝不影响主流程。
 *
 * 同一进程只有一个会话（与 TraceCollector 同样的假设），模块级单例在此安全；
 * 测试用 `setSkillTraceSink(null)` 复位。
 */

/** 事件名常量 —— 生产侧与消费侧共用，避免字面量漂移 */
export const SKILL_DEGRADATION_EVENT_NAME = "skill_degradation";

/** 降级种类（闭集：新增种类必须在这里登记，消费侧按它分桶） */
export type SkillDegradationKind =
  /** 摘要预算不足：非特权 skill 只剩名字（描述全丢） */
  | "listing_names_only"
  /** 摘要预算不足：描述被截到均分上限 */
  | "listing_truncated"
  /** 权限判定本身抛错 → fail-open 放行（安全相关） */
  | "auth_fail_open"
  /** 需要 ask 确认但没有任何确认通道 → 拒绝执行 */
  | "ask_no_channel"
  /** frontmatter 的 effort 非法 → 忽略 */
  | "effort_invalid";

/** 埋点写入通道（由 App 注入，指向 `TraceCollector.recordCustomEvent`） */
export type SkillEventSink = (data: Record<string, unknown>) => void;

let sink: SkillEventSink | null = null;

/** 注入/清除埋点通道。传 `null` 表示关闭。 */
export function setSkillTraceSink(s: SkillEventSink | null): void {
  sink = s;
}

/** 写一条降级事件。sink 未注入或写入抛错都静默 —— 埋点绝不影响主流程。 */
export function emitSkillDegradation(
  kind: SkillDegradationKind,
  data: Record<string, unknown> = {},
): void {
  try {
    sink?.({ kind, ...data });
  } catch {
    /* 埋点失败静默 */
  }
}

// ─── skill 调用埋点（内置 skill 下沉方案 P1 · §2.3 / §8）─────────────────────
//
// 为什么需要：本机 101 个会话里 skill 元工具调用 0 次，但这个 0 不能当「没人用」——
// 用户手敲 /xxx 走命令执行器，不经过元工具；logCommandInvoke 对非内置命令只报 "custom"
// 占位，按 skill 名分不开。所以「迁走之后还有没有人在用」一直没有分母。
// 这里在用户斜杠路径与模型路径各打一条，只进**本地轨迹**（events.jsonl），不经遥测出机器。

/** 事件名常量 —— 生产侧与消费侧共用 */
export const SKILL_INVOKED_EVENT_NAME = "skill_invoked";

/** 调用路径（闭集）：slash = 用户斜杠命令，model = 模型经 Skill 元工具 / bundled 工具 */
export type SkillInvocationVia = "slash" | "model";

export interface SkillInvocationEvent {
  /** 登记名（插件 skill 带 `<plugin>:` 前缀） */
  skill: string;
  via: SkillInvocationVia;
  /** 来源：builtin / user / project / plugin / mcp / bundled 等；bundled TS skill 固定为 "bundled" */
  loaded_from: string;
  /** 只有插件 skill 才有 */
  plugin?: string;
}

let invocationSink: SkillEventSink | null = null;

/** 注入/清除调用埋点通道。传 `null` 表示关闭。 */
export function setSkillInvocationSink(s: SkillEventSink | null): void {
  invocationSink = s;
}

/** 写一条调用事件。只在「已过权限、即将执行」时调用；失败静默。 */
export function emitSkillInvoked(opts: {
  name: string;
  via: SkillInvocationVia;
  loadedFrom?: string;
}): void {
  try {
    const loadedFrom = opts.loadedFrom ?? "bundled";
    const ev: SkillInvocationEvent = { skill: opts.name, via: opts.via, loaded_from: loadedFrom };
    const sep = opts.name.indexOf(":");
    if (loadedFrom === "plugin" && sep > 0) ev.plugin = opts.name.slice(0, sep);
    invocationSink?.({ ...ev });
  } catch {
    /* 埋点失败静默 */
  }
}
