/**
 * R8：`wait_until_seconds` 到期后的收口（先读输出尾部，再 kill，再记事实）。
 *
 * ## 要解决的是「模型只会拧期限这一个旋钮」
 *
 * 20261112 的轨迹里，模型的等法没有真正的退出条件（脚本一直在报同一个 state，
 * 循环写成 `until …; do sleep 30; done`）。期限到之后它收到的通知只有
 * 「等待期限到（600 秒），条件未满足」——**通篇没有一个字说明期限内看到了什么**，
 * 于是它把期限 600 → 1800 再挂一次，下一条通知还是同一句话。第二次、第三次加长
 * 都不是因为它判断「再等久一点有意义」，而是因为**没有其他可见的事实**。
 *
 * 所以修法不是限制期限（见下），而是让通知带上「期限内最后一次看到的状态」。
 *
 * ## 为什么单独一个模块
 *
 * 这段逻辑要跨三个层：读磁盘（`disk-output`）、杀进程（`shell-task`）、记等待事实
 * （`wait-registry`）。写在 `bash.ts` 里则测试必须等一次真实到期（钳制下限 60s），
 * 单测跑不动；写在 `shell-task.ts` 里则它要反向依赖等待表。放在这里，两条边都只
 * 指向底层模块，`bash.ts` 的定时器与测试调的是同一个函数——测到的就是线上那条路。
 */

import { getTaskOutputTail } from "./disk-output.ts";
import { getTask } from "./registry.ts";
import { killShellTask } from "./shell-task.ts";
import { recordDeadlineExpiryFact } from "./wait-registry.ts";
import { isTerminalStatus } from "./types.ts";

/**
 * 尾部读取窗口（字节）。
 *
 * 为什么不是「读最后 5 行」：行长度不可控（一行 JSON 可能几 KB），按字节开窗再切行
 * 才能保证单次读取有界。1024 字节对「5 行状态输出」绰绰有余，极端长行时少几行也无害
 * ——这段是给人判断的证据，不是完整日志（完整内容在 `.output` 里）。
 */
export const DEADLINE_OUTPUT_TAIL_BYTES = 1024;

/**
 * 期限到：读输出尾部 → kill → 记录「这个对象上次是期限到、最后看到什么」。
 *
 * 返回 kill 之前读到的那一刻尾部；任务已不在跑（自己退出了 / 已被别的路径终止）
 * 或读不到时返回 `null`——调用方据此不写「最后输出是……」这类没有依据的事实。
 *
 * **kill 一定执行**：读尾部再重要也不能让它挡住「到期必 kill」这条承诺，所以读失败
 * 只降级为 `null`，不影响后面的 kill（`getTaskOutputTail` 自身也返回 null 而不抛）。
 */
export async function expireDeadlineShellTask(
  taskId: string,
  opts: {
    /** 钳制后的期限秒数（与 `registerWaitUntil` 登记的一致，进通知文案） */
    clamped: number;
    /** 原始命令（进通知文案，截断 60 字符与既有 kill 文案一致） */
    command: string;
    /** 等待对象的签名（`recordDeadlineExpiryFact` 的索引键） */
    subjects?: string[];
  },
): Promise<string | null> {
  const task = getTask(taskId);
  // 已经终态：告警一次都不该发生（那是重复 kill），不给调用方任何「刚发生过期」的印象
  if (!task || isTerminalStatus(task.status)) return null;

  const tail = await getTaskOutputTail(taskId, DEADLINE_OUTPUT_TAIL_BYTES);
  killShellTask(taskId, {
    // 文案与 R8 之前逐字一致：这次改动只追加尾部证据，不改「期限到」这句话本身
    summary: `等待期限到（${opts.clamped} 秒），条件未满足，已停止命令 "${opts.command.slice(0, 60)}"`,
    ...(tail !== null ? { outputTail: tail } : {}),
  });
  // 记录放在 kill 之后：先杀再记，不会出现「事实已写下但进程没停」的中间态
  recordDeadlineExpiryFact(opts.subjects, taskId, tail);
  return tail;
}
