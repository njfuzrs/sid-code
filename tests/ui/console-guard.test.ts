/**
 * TUI console 护栏测试
 *
 * 背景见 src/ui/console-guard.ts 头部注释：React development build 的
 * `console.error("Maximum update depth exceeded...")` 走的是 console 信道，
 * patchStderr（拦裸 process.stderr.write）拦不到，必须单独设护栏。
 *
 * 本测试锁三件事：
 *  1. stderr 三件套被接管、且**不碰** stdout 类方法（尊重 patchConsole:false 的意图）
 *  2. 内容有留痕（转进 logger），不是静默丢弃 —— 静默吞掉现场正是这次排查最大的障碍
 *  3. 卸载后恢复原状 + 重入不炸栈
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  installTUIConsoleGuard,
  uninstallTUIConsoleGuard,
  isTUIConsoleGuardInstalled,
} from "@sid-code/cli/ui/console-guard.ts";

afterEach(() => {
  uninstallTUIConsoleGuard();
});

describe("TUI console 护栏", () => {
  test("接管 stderr 三件套 + assert，且不碰 stdout 类方法", () => {
    const beforeLog = console.log;
    const beforeInfo = console.info;
    const beforeError = console.error;
    const beforeWarn = console.warn;
    const beforeTrace = console.trace;

    installTUIConsoleGuard();
    try {
      // stderr 类：必须被换掉
      expect(console.error).not.toBe(beforeError);
      expect(console.warn).not.toBe(beforeWarn);
      expect(console.trace).not.toBe(beforeTrace);
      // stdout 类：必须原封不动（这是与 ink patchConsole 的关键区别）
      expect(console.log).toBe(beforeLog);
      expect(console.info).toBe(beforeInfo);
    } finally {
      uninstallTUIConsoleGuard();
    }

    // 卸载后完全恢复
    expect(console.error).toBe(beforeError);
    expect(console.warn).toBe(beforeWarn);
    expect(console.trace).toBe(beforeTrace);
  });

  test("护栏生效时 console.error 不写终端（不触碰 stdout/stderr）", () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    process.stdout.write = ((c: any) => { stdoutWrites.push(String(c)); return true; }) as never;
    process.stderr.write = ((c: any) => { stderrWrites.push(String(c)); return true; }) as never;

    installTUIConsoleGuard();
    try {
      // 正是同事机器上刷屏的那条真实文案
      console.error(
        "Maximum update depth exceeded. This can happen when a component calls setState inside useEffect, but useEffect either doesn't have a dependency array, or one of the dependencies changes on every render.",
      );
      console.warn("some warning");
      console.trace("some trace");
    } finally {
      uninstallTUIConsoleGuard();
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    // 核心断言：一个字节都不该落到终端
    const leaked = [...stdoutWrites, ...stderrWrites].join("");
    expect(leaked).not.toContain("Maximum update depth");
    expect(leaked).not.toContain("some warning");
  });

  test("内容转进 logger 而非静默丢弃（有留痕）", async () => {
    const { getLogger } = await import("@sid-code/core/debug/logger.ts");
    const logger = getLogger();

    const seen: { level: string; cat: string; msg: string }[] = [];
    const origError = logger.error.bind(logger);
    const origWarn = logger.warn.bind(logger);
    (logger as any).error = (cat: string, msg: string) => seen.push({ level: "error", cat, msg });
    (logger as any).warn = (cat: string, msg: string) => seen.push({ level: "warn", cat, msg });

    installTUIConsoleGuard();
    try {
      console.error("Maximum update depth exceeded. blah");
      console.warn("just a warning");
    } finally {
      uninstallTUIConsoleGuard();
      (logger as any).error = origError;
      (logger as any).warn = origWarn;
    }

    expect(seen.length).toBe(2);
    expect(seen[0].level).toBe("error");
    expect(seen[0].cat).toBe("TUI:CONSOLE");
    expect(seen[0].msg).toContain("Maximum update depth");
    expect(seen[1].level).toBe("warn");
  });

  test("Error 实参被压成单行（保证日志可 grep）", async () => {
    const { getLogger } = await import("@sid-code/core/debug/logger.ts");
    const logger = getLogger();
    const seen: string[] = [];
    const orig = logger.error.bind(logger);
    (logger as any).error = (_cat: string, msg: string) => seen.push(msg);

    installTUIConsoleGuard();
    try {
      console.error(new Error("boom happened"));
    } finally {
      uninstallTUIConsoleGuard();
      (logger as any).error = orig;
    }

    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("boom happened");
    expect(seen[0]).not.toContain("\n"); // 必须单行
  });

  test("重复安装幂等，且 logger 内部再调 console 不会无限递归", async () => {
    const { getLogger } = await import("@sid-code/core/debug/logger.ts");
    const logger = getLogger();
    const orig = logger.error.bind(logger);
    let calls = 0;
    // 模拟 logger 降级路径里自己又调 console.error（真实存在：writeToConsole）
    (logger as any).error = (_c: string, _m: string) => {
      calls++;
      console.error("logger 内部再次 console.error");
    };

    installTUIConsoleGuard();
    const second = installTUIConsoleGuard(); // 幂等：不应叠加一层
    expect(isTUIConsoleGuardInstalled()).toBe(true);

    try {
      // 若无重入守卫，这里会 RangeError: Maximum call stack size exceeded
      expect(() => console.error("trigger")).not.toThrow();
      expect(calls).toBe(1); // 递归第二层被守卫丢弃，没有雪崩
    } finally {
      second();
      (logger as any).error = orig;
    }

    expect(isTUIConsoleGuardInstalled()).toBe(false);
  });

  test("卸载幂等：未安装时调用是 no-op", () => {
    const before = console.error;
    expect(() => uninstallTUIConsoleGuard()).not.toThrow();
    expect(console.error).toBe(before);
  });
});
