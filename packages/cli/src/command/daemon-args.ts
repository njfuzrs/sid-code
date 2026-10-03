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

export function parseDaemonArgs(args: string[]): { sub: string; opts: DaemonCliOptions } {
  // 提取子命令（第一个不以 - 开头且属于已知子命令的）
  let sub = "start";
  const subIdx = args.findIndex((a) => !a.startsWith("-"));
  if (subIdx !== -1 && KNOWN_SUBS.has(args[subIdx])) {
    sub = args[subIdx];
  }

  try {
    const { values } = parseArgs({
      args: args.filter((a) => a !== sub),
      options: {
        webhook: { type: "boolean" },
        interval: { type: "string" },
        "max-concurrent": { type: "string" },
        "allowed-tools": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    return {
      sub,
      opts: {
        // B43：不能 `!!values.webhook`——未传时变成 false，会压过 daemon.ts 里
        // `webhookEnabled ?? secret !== ""` 的兜底，只设 secret 时 webhook 永远起不来（实测）。
        webhook: values.webhook === true ? true : undefined,
        interval: values.interval ? parseInt(values.interval, 10) : undefined,
        maxConcurrent: values["max-concurrent"]
          ? parseInt(values["max-concurrent"], 10)
          : undefined,
        allowedTools: values["allowed-tools"]
          ? String(values["allowed-tools"])
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        help: !!values.help,
      },
    };
  } catch (err: any) {
    console.error(`错误: ${err.message}\n使用 sid-code daemon --help 查看用法`);
    process.exit(1);
  }
}
