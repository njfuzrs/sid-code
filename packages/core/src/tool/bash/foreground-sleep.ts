/**
 * 前台 `sleep N` 阻塞等待的识别与引导（N6 A 档：只引导，不拦）。
 *
 * ## 为什么需要
 *
 * 真实会话里模型用 `sleep 150 && gh pr view …` 在**本轮内**阻塞地等 CI：
 * 会话 `20261109-160803-fbb02831` 一次会话 7 次（20–240s，合计 1210s）；
 * 全量 954 会话 251 次 / 74 会话、合计 532 分钟。
 *
 * 危害不只是空转本身：`schedule_wakeup` 与后台通知都只在**会话空闲**时才注入。
 * 模型留在本轮 sleep，唤醒就只能排队——fbb02831 第二个唤醒因此晚了 383 秒才送达
 * （`ScheduledFire.lag_ms = 383270`）。这是 N2 修了文案之后仍然存在的**行为面**缺口：
 * 模型就算知道「排完该结束本轮」，它也可能先用 sleep 在本轮里等一会儿。
 *
 * ## 为什么只引导不拦（A 档）
 *
 * 这个形态**离合法用法很近**：`sleep 2 && curl localhost` 是正常的启动节奏，
 * 限速重试、故意放缓也常见。按形态硬拦必然误伤，方案 §N6 因此把它拆成两档：
 * A 档只在「确实在等」时追加一行出口指引，命令照常执行；B 档（对齐 Claude Code
 * 的拒绝执行）要等 A 上线两周后的数据再决定，见
 * `.agents/notes/rejected/feature/2026-11-11-前台sleep改为拒绝执行.md`。
 *
 * ## 形态判据对齐 Claude Code 的 `detectBlockedSleepPattern`
 *
 * - 只认**第一段**是 `sleep N`，且 N 是整数、N ≥ 2：
 *   - `sleep 30 | cat` 不命中——第一段虽然是 sleep，但后面是管道（流式用法，不是阻塞等待）；
 *   - `sleep 1` / `sleep 0.5` 不命中——正常让出 CPU / 限速，不是等待；
 *   - `(sleep 30; gh …)` / `timeout 60 sleep 30` 不命中——第一段不是 sleep。
 * - 先剥掉 `cd … &&` 与环境变量前缀：fbb02831 的真实写法里 `sleep` 前面常带
 *   `cd <worktree> &&`，不剥会漏掉最主要的一类。
 */

import { stripLeadingCdAndEnv } from "../../query/repeated-readonly-guard.ts";

/** `sleep N` 的最低秒数：低于它的是正常节奏（限速 / 让出 CPU），不产生引导。 */
export const FOREGROUND_SLEEP_MIN_SECONDS = 2;

/**
 * 没有声明的等待时，N 达到这个秒数也追加引导。
 *
 * 取 30 的依据：全量 251 次前台 sleep 里，30s 以上的 189 次
 * （30–119s 59 + 120–299s 107 + ≥300s 23），2–29s 的 62 次大多是正常节奏。
 * 30 把「明显在阻塞等待」和「正常让出」分开；有声明的等待时不受这个阈值限制
 * （那说明模型自己已经承认在等外部状态，任何时长的前台 sleep 都在推迟唤醒）。
 */
export const FOREGROUND_SLEEP_LONG_SECONDS = 30;

/** 追加引导的两种触发条件（进事件的闭集标签，不是文案）。 */
export type ForegroundSleepReason = "declared_wait" | "long_sleep";

export interface ForegroundSleepMatch {
  /** sleep 的整数秒数 */
  seconds: number;
  /** sleep 之后剩余的命令（`&&` / `;` / 换行之后的部分；纯 sleep 时为空串） */
  rest: string;
}

/**
 * 判断这条前台命令是否会**阻塞本轮**地 sleep。
 *
 * 命中返回秒数与后续命令，否则 `undefined`。纯函数，不读时钟、不读全局状态。
 */
export function detectForegroundSleep(command: string): ForegroundSleepMatch | undefined {
  const body = stripLeadingCdAndEnv(command);
  // lookahead 里 `\n` 也算分隔符：多行脚本里 `sleep 30` 单独一行同样是阻塞等待。
  // `|` 刻意不在其中——管道里的 sleep 是流式用法，见文件头。
  const matched = /^sleep\s+(\d+)(?=\s*(?:$|&&|;|\n))/.exec(body);
  if (!matched) return undefined;
  const seconds = Number(matched[1]);
  if (!Number.isInteger(seconds) || seconds < FOREGROUND_SLEEP_MIN_SECONDS) return undefined;
  const rest = body.slice(matched[0].length).replace(/^\s*(?:&&|;|\n)?\s*/, "");
  return { seconds, rest };
}

/**
 * 追加到 tool_result 末尾的引导文案。
 *
 * 落点是 tool_result 而不是系统提示：这是**某一次调用**的出口指引，常驻提示会成为噪音
 * （模型不 sleep 时完全用不上），而 tool_result 零缓存影响、只在该出现时出现一次。
 *
 * 两种条件的前半句不同：有声明的等待时要点破「它正在推迟你自己挂的那个等待」，
 * 否则只说「阻塞了本轮」——把因果说到模型自己刚做的事上，才可能改变下一个动作。
 */
export function buildForegroundSleepNotice(
  match: ForegroundSleepMatch,
  reason: ForegroundSleepReason,
): string {
  const head =
    reason === "declared_wait"
      ? `[等待引导] 你已经挂了等待源，前台 sleep ${match.seconds} 只会阻塞本轮：唤醒和后台通知都只在会话空闲时送达，本轮阻塞期间它们全部在排队。`
      : `[等待引导] 前台 sleep ${match.seconds} 阻塞了本轮，期间定时唤醒和后台通知都送不进来。`;
  return `\n${head}要等外部状态，用后台 bash + wait_until_seconds（条件满足就退出的循环）或 monitor，然后结束本轮；不要留在本轮 sleep 里等。`;
}
