/**
 * `sid-code daemon` 子命令参数解析。
 *
 * 单独成文件：解析逻辑要能被单测直接调用，而 daemon.ts 的入口一 import
 * 就会拉起 logger / core。
 */

import { parseArgs } from "node:util";

export interface DaemonCliOptions {
  /** undefined = 未传 --webhook，交给 daemon 按 SID_CODE_WEBHOOK_SECRET 是否存在决定 */
  webhook?: boolean;
  interval?: number;
  maxConcurrent?: number;
  allowedTools?: string[];
  help: boolean;
}

const KNOWN_SUBS = new Set(["start", "status", "stop", "restart", "logs", "install", "uninstall"]);

/**
 * 解析失败抛 Error（由 daemon.ts 入口打印并 exit 1；单测可直接断言）。
 *
 * 子命令只看 `args[0]`：
 * - 不以 `-` 开头 → 原样作为子命令返回，**不认识的也原样返回**，由 daemon.ts 走「未知子命令」。
 *   此前是「第一个非 - 参数若不认识就当 start」，拼错的 `stauts` 会直接前台起一个 daemon。
 * - 为空或以 `-` 开头 → 默认 start；此时不允许再出现位置参数。
 *   否则 `--interval 5000 status` 会被当成 start（实测），想查状态却起了一个常驻进程。
 */
export function parseDaemonArgs(args: string[]): { sub: string; opts: DaemonCliOptions } {
  const first = args[0];
  const hasSub = first !== undefined && !first.startsWith("-");
  const sub = hasSub ? first : "start";
  const rest = hasSub ? args.slice(1) : args;

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      webhook: { type: "boolean" },
      interval: { type: "string" },
      "max-concurrent": { type: "string" },
      "allowed-tools": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    const p = positionals[0];
    throw new Error(
      !hasSub && KNOWN_SUBS.has(p)
        ? `子命令必须写在最前面: sid-code daemon ${p} [选项]`
        : `多余的参数: ${positionals.join(" ")}`,
    );
  }
  return {
    sub,
    opts: {
      // B43：不能 `!!values.webhook`——未传时变成 false，会压过 daemon.ts 里
      // `webhookEnabled ?? secret !== ""` 的兜底，只设 secret 时 webhook 永远起不来（实测）。
      webhook: values.webhook === true ? true : undefined,
      interval: values.interval ? parseInt(values.interval, 10) : undefined,
      maxConcurrent: values["max-concurrent"] ? parseInt(values["max-concurrent"], 10) : undefined,
      allowedTools: values["allowed-tools"]
        ? String(values["allowed-tools"])
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      help: !!values.help,
    },
  };
}
