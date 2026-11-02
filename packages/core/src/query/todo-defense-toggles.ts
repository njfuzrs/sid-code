/**
 * 清单三道防线的关闭开关（2026-11-01，进度清单横向剖析第五部分 T3）
 *
 * 防线注册表里 `todo_gate` / `no_progress_nag` / `todo_rework` 原先都是 `NO_TOGGLE`，
 * 而它们的 `retireWhen` 要求「T8 关闭 A/B」——没有开关，关闭臂根本跑不出来。
 *
 * 约定与 `SID_DISABLE_PROMISE_NUDGE` 一致：
 *   - 默认开，只做开关不改默认值；
 *   - 只认字面 `1`（`true` / `yes` 不生效），防宽松解析误关防线；
 *   - 每次调用现读 env，测试与评测臂可在进程内切换。
 *
 * 关闭后的边界：
 *   - `SID_DISABLE_TODO_NAG` 只关「催更」（todo 回注节流路径 + work-log 摘要），
 *     **不关**压缩后的重注入——那是信息丢失兜底，不是催促，关掉它 A/B 测的就不是 nag 了；
 *   - `SID_DISABLE_TODO_REWORK` 只关提醒注入，事件照发并带 `suppressed: true`，
 *     关闭臂里仍能数出「本该提醒几次」，A/B 的分母不丢。
 */

export const TODO_GATE_DISABLE_ENV = "SID_DISABLE_TODO_GATE";
export const TODO_NAG_DISABLE_ENV = "SID_DISABLE_TODO_NAG";
export const TODO_REWORK_DISABLE_ENV = "SID_DISABLE_TODO_REWORK";

export function isTodoGateDisabled(): boolean {
  return process.env[TODO_GATE_DISABLE_ENV] === "1";
}

export function isTodoNagDisabled(): boolean {
  return process.env[TODO_NAG_DISABLE_ENV] === "1";
}

export function isTodoReworkDisabled(): boolean {
  return process.env[TODO_REWORK_DISABLE_ENV] === "1";
}
