/**
 * B43：`sid-code daemon start` 不传 --webhook 时曾被解析成 false，
 * 压过 daemon.ts 里 `webhookEnabled ?? secret !== ""` 的兜底——只设
 * SID_CODE_WEBHOOK_SECRET 时 webhook 永远起不来（实测）。
 */

import { describe, it, expect } from "bun:test";
import { parseDaemonArgs } from "../../src/command/daemon-args.ts";

describe("daemon CLI 参数", () => {
  it("不传 --webhook 时为 undefined（交给「有 secret 就开」的兜底）", () => {
    expect(parseDaemonArgs(["start"]).opts.webhook).toBeUndefined();
    expect(parseDaemonArgs([]).opts.webhook).toBeUndefined();
  });
  it("显式 --webhook 为 true", () => {
    expect(parseDaemonArgs(["start", "--webhook"]).opts.webhook).toBe(true);
  });
});

/**
 * D2：拼错的子命令、选项写在子命令前面，曾被当成 start 直接前台起 daemon（实测）。
 */
describe("daemon 子命令解析", () => {
  it("拼错的子命令原样返回，交给「未知子命令」分支", () => {
    expect(parseDaemonArgs(["stauts"]).sub).toBe("stauts");
  });
  it("选项写在子命令前面 → 报错，不当成 start", () => {
    expect(() => parseDaemonArgs(["--interval", "5000", "status"])).toThrow("子命令必须写在最前面");
  });
  it("多余的位置参数 → 报错", () => {
    expect(() => parseDaemonArgs(["status", "extra"])).toThrow("多余的参数");
  });
  it("正常形态不回归", () => {
    expect(parseDaemonArgs([]).sub).toBe("start");
    expect(parseDaemonArgs(["--webhook"]).sub).toBe("start");
    expect(parseDaemonArgs(["--webhook"]).opts.webhook).toBe(true);
    const r = parseDaemonArgs(["status", "--interval", "5000"]);
    expect(r.sub).toBe("status");
    expect(r.opts.interval).toBe(5000);
  });
});
