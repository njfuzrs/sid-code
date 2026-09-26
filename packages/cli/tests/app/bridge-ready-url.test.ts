/**
 * 连上之后的成功提示不得回显 --bridge URL 里的 token。
 *
 * 准入拒绝已经剥过（admission.test.ts）。runBridge 在 start() 成功后
 * 还会把 URL 打到日志和 stderr，那是另一条路径。
 *
 * 放在子进程里跑：mock.module 是进程级的，mock.restore() 也不还原被替换的
 * 模块。在父进程里替换 bridge-runner，会让同一次 bun test 里排在后面的
 * 「永久失败」测试拿到一个 start() 什么都不做的假类，4001 / 1008 的断言
 * 全部放空，而且单独跑那个文件又是绿的——只在一起跑时才红。
 */

import { describe, test, expect } from "bun:test";

describe("App.runBridge · 成功提示", () => {
  test("stderr 与 BRIDGE 日志不含 query 里的 token", async () => {
    const proc = Bun.spawn(
      ["bun", new URL("./bridge-ready-url-child.ts", import.meta.url).pathname],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr: stderr.trim() }).toEqual({ code: 0, stderr: "" });
  });
});
