/**
 * T1 子进程：只调 readPipedStdin、**不调 process.exit**，靠事件循环自然排空退出。
 * 父测试持有 stdin 写端且不关闭——若 finish() 没 pause()，fd 撑住事件循环，本进程不会退。
 */
import { readPipedStdin } from "@sid-code/cli/utils/piped-stdin.ts";

const r = await readPipedStdin({ timeoutMs: 300, isTTY: false, warn: () => {} });
process.stdout.write(JSON.stringify({ timedOut: r.timedOut, len: r.text.length }) + "\n");
