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
