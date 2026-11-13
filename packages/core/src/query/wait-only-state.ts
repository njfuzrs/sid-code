/**
 * R5：等待态判定 —— 当前「清单上还没做完的事」就是在等外部状态。
 *
 * 缺陷形态（事故 20261112 的 10:48:21 形态，真实轨迹人工核过）：
 * 模型已经用 `bash --wait_until_seconds` 挂上了对 PR CI 的等待，清单里只剩 1 项
 * `in_progress` 的「等 CI 结果」。此时 harness 的催促通道仍按「清单有未完成项」判，
 * 每 8 轮注入一次「仍有 1 项未完成。**请继续推进**」——而模型此刻唯一能做的是等。
 * 它于是要么去重复查询状态（P1 守卫要拦的同一件事），要么把那一项标成 blocked
 * 来让催停（T2 已经点破过：闸门在逼它对清单撒谎）。
 *
 * 判据设计（三条同时成立才算等待态）：
 *   1. 有未完成项 —— 全部完成时不存在「催不催」的问题；
 *   2. 有**显式声明的外部等待**（`isDeclaredExternalWait`）—— 用窄判据而非
 *      `hasPromisedWait`：派生出来的子代理 / 普通后台 shell 承诺的是「自己结束时回报」，
 *      不构成「清单在等外部状态」的证据（同 P1 拦截的判据，见 wait-registry.ts 注释）；
 *   3. 未完成项数 ≤ 有效显式等待数 —— 每一项都有一个等待在盯，才谈得上「都在等」。
 *      用 ≤ 而不是 ==：一个等待（如一次 CI 跑）可以同时兑现多项（「等 CI 过」+「等 PR 合并」），
 *      要求严格相等会把这种常见形态漏掉，让催促照旧打断等待。
 *
 * 另有一条**让路条件**：上一次 `todo_write` 之后又发生过真实副作用进展时不算等待态。
 * 反例是「一边等 CI 一边继续改别的文件」——那种情况模型确实在干活，催它记账是对的，
 * 不该被「有等待」整体免掉。注意这里必须是**相对上次 todo_write** 的增量而非
 * `hasRealProgress` 的会话级累积：正常形态是「先改完代码（文件早已落盘）→ 再起等待」，
 * 拿累积量判会让最常见的等待场景永远命中不了这一条，等于整条修法失效。
 */

/** `isWaitingOnlyState` 的入参（全部由 loop.ts 现算后传入，本模块保持纯函数）。 */
export interface WaitingOnlyStateInput {
  /** 清单里 pending + in_progress 的项数（`countUnfinished` 口径，不含 blocked）。 */
  unfinished: number;
  /** 当前有效的**显式外部**等待数（`listWaits().filter(isDeclaredExternalWait).length`）。 */
  declaredWaitCount: number;
  /**
   * 上一次 `todo_write` 之后是否又发生过新的副作用进展（改文件 / 观测值变化）。
   * 由 `measured-progress.ts` 的 `progressRevision` 与写入时的基线比较得出。
   */
  progressedSinceTodoWrite: boolean;
}

/**
 * 是否处于「纯等待态」：清单上剩的每一项都已有显式等待在盯，且没有新的副作用进展。
 *
 * 纯函数：不读 registry、不读 SessionState。副作用留在 loop.ts，便于单测四种组合。
 */
export function isWaitingOnlyState(input: WaitingOnlyStateInput): boolean {
  if (input.unfinished <= 0) return false;
  if (input.declaredWaitCount <= 0) return false;
  if (input.progressedSinceTodoWrite) return false;
  return input.unfinished <= input.declaredWaitCount;
}
