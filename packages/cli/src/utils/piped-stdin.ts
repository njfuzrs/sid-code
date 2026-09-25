/**
 * 无头模式的管道 stdin 读取（B1）。
 *
 * 文档头号用法 `cat logs.txt | sid-code -p "解释这些错误"` 此前把管道内容整个丢掉：
 * prompt 只来自位置参数，print 路径从不读 stdin。本模块补上这一段，语义对齐
 * claude-code 的 `getInputPrompt`：
 *
 *   ① 只在 stdin **不是 TTY**（被管道 / 重定向）时读。交互启动读 stdin 会把
 *      键盘输入吞掉，所以 TTY 一律返回空。
 *   ② 读到的内容与位置参数 prompt 由调用方用 `\n` 拼接，不在这里拼——
 *      拼接策略（空 prompt 判定、resume 豁免）属于路由层。
 *   ③ **超时保护**。stdin 可能是父进程继承下来的空管道，生产者也可能很慢。
 *      到点还没 EOF 就用已收到的部分返回，并在 stderr 告警，绝不永久挂起。
 *      超时时长可用 `SID_CODE_STDIN_TIMEOUT_MS` 覆盖（默认 3000）。
 *
 * 与 `--input-format stream-json` **互斥**。那种模式下 stdin 被 StructuredIO
 * 逐条消费，这里再读一次会把字节抢走。分流由调用方保证，本函数不感知格式。
 */

import type { Readable } from "node:stream";

/** 默认等待时长：生产者 3 秒内没有任何数据也没有 EOF，就告警放行。 */
export const DEFAULT_STDIN_TIMEOUT_MS = 3000;

export interface ReadPipedStdinOptions {
  /** 被读的流。默认 process.stdin，测试注入 mock。 */
  stdin?: Readable;
  /** 是否交互终端。默认读 `stdin.isTTY`。显式传入是为了让单测不依赖真实 TTY。 */
  isTTY?: boolean;
  /** 等待 EOF 的上限（毫秒）。到点返回已收到的部分。 */
  timeoutMs?: number;
  /** 超时告警的落点。默认 process.stderr.write，测试可替换以断言文案。 */
  warn?: (message: string) => void;
}

export interface PipedStdinResult {
  /** 读到的文本（TTY / 空管道 / 超时零字节时为空串）。 */
  text: string;
  /** 是否因为超时而提前返回（没等到 EOF）。 */
  timedOut: boolean;
}

/**
 * 读取管道进来的 stdin。
 *
 * 返回的 `text` 不做 trim：日志 / diff 的尾部换行是内容的一部分，
 * 调用方要不要去掉交给拼接那一层判断。
 */
export async function readPipedStdin(opts: ReadPipedStdinOptions = {}): Promise<PipedStdinResult> {
  const stdin = opts.stdin ?? process.stdin;
  const isTTY = opts.isTTY ?? stdin.isTTY === true;
  if (isTTY) return { text: "", timedOut: false };

  const timeoutMs = resolveStdinTimeoutMs(opts.timeoutMs);
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));

  return new Promise<PipedStdinResult>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      if (timedOut) {
        warn(
          `警告: ${timeoutMs}ms 内未收到完整的 stdin 数据，已用已收到的部分继续` +
            `（可用 SID_CODE_STDIN_TIMEOUT_MS 调整）。\n`,
        );
      }
      resolve({ text: Buffer.concat(chunks).toString("utf-8"), timedOut });
    };

    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => finish(false);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(true), timeoutMs);
    // 不让这个计时器单独撑住进程：调用方退出时不该被一次 stdin 读取拖住。
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    // 暂停态的流不 resume 就永远不发 data/end（父进程重定向时偶发）。
    if (typeof stdin.resume === "function") stdin.resume();
  });
}

/**
 * 解析超时时长。非法 / 负数回落到默认值：一个写错的环境变量不该让
 * 管道读取变成「立即放弃」或「永远等待」。
 */
export function resolveStdinTimeoutMs(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const fromEnv = Number(process.env.SID_CODE_STDIN_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_STDIN_TIMEOUT_MS;
}
