/**
 * S15：信号收尾不得被第二个同类信号打断。
 *
 * 缺陷现场：`process.once` 触发一次后监听器被摘除，间隔 200ms 再来一个 SIGHUP 走默认处置
 * 直接杀进程 —— 只有 handler-enter、没有 handler-done，退出码同为 129（看退出码分不出）。
 * 实测信号路径会话 messages.json / session-summary.json 落盘 0/209。
 */
import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  decideRepeatSignal,
  installTeardownSignalHandlers,
  STUCK_TEARDOWN_MS,
} from "@sid-code/cli/signal-teardown.ts";

const SIGNAL_TEARDOWN_TS = join(import.meta.dir, "../src/signal-teardown.ts");

describe("decideRepeatSignal", () => {
  test("第一个信号开始收尾", () => {
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      expect(decideRepeatSignal(null, s, 0)).toBe("start");
    }
  });
  test("收尾中重复 SIGHUP / SIGTERM 先忽略，让收尾跑完", () => {
    expect(decideRepeatSignal({ startedAt: 0 }, "SIGHUP", 200)).toBe("ignore");
    expect(decideRepeatSignal({ startedAt: 0 }, "SIGTERM", STUCK_TEARDOWN_MS)).toBe("ignore");
  });
  test("收尾卡住超过阈值后再来 SIGTERM / SIGHUP 即强退（否则只剩 SIGKILL）", () => {
    expect(decideRepeatSignal({ startedAt: 0 }, "SIGTERM", STUCK_TEARDOWN_MS + 1)).toBe(
      "force_exit",
    );
    expect(decideRepeatSignal({ startedAt: 0 }, "SIGHUP", STUCK_TEARDOWN_MS + 1)).toBe(
      "force_exit",
    );
  });
  test("收尾中第二个 SIGINT 强退（headless 连按两次 Ctrl+C，与现状一致）", () => {
    expect(decideRepeatSignal({ startedAt: 0 }, "SIGINT", 10)).toBe("force_exit");
  });
});

describe("installTeardownSignalHandlers（注入 target）", () => {
  test("监听器常驻：重复信号不再触发 run，也不摘除监听器", async () => {
    const target = new EventEmitter();
    let runs = 0;
    let forced = 0;
    let t = 0;
    const ctl = installTeardownSignalHandlers({
      run: () => {
        runs++;
      },
      forceExit: () => {
        forced++;
      },
      now: () => t,
      target: target as any,
    });
    target.emit("SIGHUP");
    t = 200;
    target.emit("SIGHUP");
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(forced).toBe(0);
    // 读代码行为：第二个信号之后监听器仍挂着（once 的语义是这里变 0）
    expect(target.listenerCount("SIGHUP")).toBe(1);
    t = STUCK_TEARDOWN_MS + 500;
    target.emit("SIGHUP");
    expect(forced).toBe(1);
    expect(ctl.arrivals()).toBe(3);
  });

  test("trigger（终端流 EIO）与真信号共用重入保护", async () => {
    const target = new EventEmitter();
    let runs = 0;
    const ctl = installTeardownSignalHandlers({
      run: () => {
        runs++;
      },
      forceExit: () => {},
      now: () => 0,
      target: target as any,
    });
    target.emit("SIGHUP");
    ctl.trigger("SIGHUP");
    await Promise.resolve();
    expect(runs).toBe(1);
  });
});

/**
 * 真进程：两发 SIGHUP 间隔 200ms，handler-done 必须出现。
 * 变异自证：把 installTeardownSignalHandlers 里的 `target.on` 改成 `once`，这条必红
 * （第二发走默认处置，进程以信号终止，stdout 里没有 done）。
 */
describe("真进程 · 两发 SIGHUP", () => {
  test("第二个 SIGHUP 不打断收尾：handler-done 出现、退出码 129", async () => {
    const script = `
      const { installTeardownSignalHandlers } = await import(${JSON.stringify(SIGNAL_TEARDOWN_TS)});
      installTeardownSignalHandlers({
        run: async () => {
          process.stdout.write("enter\\n");
          await new Promise((r) => setTimeout(r, 600));
          process.stdout.write("done\\n");
          process.exit(129);
        },
        forceExit: () => process.exit(137),
      });
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `;
    const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    let out = "";
    const dec = new TextDecoder();
    while (!out.includes("ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    p.kill("SIGHUP");
    await new Promise((r) => setTimeout(r, 200));
    p.kill("SIGHUP");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    const code = await p.exited;
    expect(out).toContain("enter");
    expect(out).toContain("done");
    expect(code).toBe(129);
  }, 10_000);
});

/**
 * EIO 判据落在流对象上：流发出的 EIO → 转入收尾；写普通文件的 EIO 不被吞。
 * 处理器绑 process.stdout，放子进程里测（与 contracts-runtime E3 同做法）。
 */
describe("watchTerminalOutputErrors", () => {
  const run = (body: string) => {
    const script = `
      const { watchTerminalOutputErrors } = await import(${JSON.stringify(SIGNAL_TEARDOWN_TS)});
      ${body}
    `;
    const p = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, err: p.stderr.toString() };
  };

  test("stderr 流对象发出的 EIO 只触发一次 onDead，进程不崩", () => {
    const r = run(`
      let n = 0;
      watchTerminalOutputErrors([process.stdout, process.stderr], () => { n++; });
      const e = () => Object.assign(new Error("x"), { code: "EIO", syscall: "write" });
      process.stdout.emit("error", e());
      process.stdout.emit("error", e());
      await new Promise((r) => setTimeout(r, 20));
      process.exit(n === 1 ? 42 : 1);
    `);
    expect(r.code).toBe(42);
  });

  test("非终端流的 EIO 不被吞（仍走原有崩溃路径）", () => {
    const r = run(`
      const { EventEmitter } = await import("node:events");
      watchTerminalOutputErrors([process.stdout, process.stderr], () => process.exit(42));
      const fileStream = new EventEmitter();
      fileStream.emit("error", Object.assign(new Error("file eio"), { code: "EIO" }));
    `);
    expect(r.code).not.toBe(42);
    expect(r.code).not.toBe(0);
  });

  test("非 EIO / EPIPE 的流错误不判终端已死", () => {
    const r = run(`
      watchTerminalOutputErrors([process.stdout], () => process.exit(42));
      process.stdout.emit("error", Object.assign(new Error("x"), { code: "EAGAIN" }));
      await new Promise((r) => setTimeout(r, 20));
      process.exit(0);
    `);
    expect(r.code).toBe(0);
  });
});
