/**
 * 能力自愈进轨迹 —— 模块级观察者，与 `permission/decision-telemetry.ts` 同一模式。
 *
 * ## 为什么需要
 *
 * 自愈此前只有 `debug` 级日志，而本机 `debug.log` 只覆盖了一次会话；轨迹里没有任何自愈事件，
 * 只能从 `effort_wire=omitted` 倒推「这一轮剥过 effort」。倒推分不出两件关键的事：
 * 是措辞点名触发还是结构兜底触发、这次有没有落盘记账。前者决定归因可不可信，
 * 后者决定一个模型会不会被永久记成「不支持 effort」（剖析 21/1 §5.9）。
 *
 * ## 为什么是模块级单例
 *
 * 自愈发生在 `OpenAIProvider` 内部，手上没有 TraceCollector；为一个度量把 collector
 * 穿透进 provider 改面太大。collector 在 `registerHooks` 时注入自己，未注入（测试 /
 * 无轨迹模式）时静默 no-op。
 */

/** 自愈由什么触发：错误文本点名了 effort 字段 / 只凭 HTTP 4xx 的结构兜底 */
export type CapabilityHealTrigger = "wording" | "structural";

export interface CapabilityHealedEvent {
  /** 真名（与能力缓存记账同一个键） */
  model: string;
  trigger: CapabilityHealTrigger;
  /** 首次失败的 HTTP 状态码；取不到时不填 */
  statusCode?: number;
  /** 剥掉的字段。当前只有 reasoning_effort，留成数组是为了以后加字段时不改形态 */
  stripped: string[];
  /** 本次是否把「不支持 effort」写进了能力缓存 */
  recorded: boolean;
  /** 剥字段后的重试是否成功 */
  retryOk: boolean;
}

let _observer: ((event: CapabilityHealedEvent) => void) | null = null;

/** collector 注入；传 null 解除（测试收尾用） */
export function setCapabilityHealedObserver(
  fn: ((event: CapabilityHealedEvent) => void) | null,
): void {
  _observer = fn;
}

/** 记一次自愈。观察者异常一律吞掉——度量永不阻断请求主流程 */
export function recordCapabilityHealed(event: CapabilityHealedEvent): void {
  try {
    _observer?.(event);
  } catch {
    /* 度量失败不影响主流程 */
  }
}
