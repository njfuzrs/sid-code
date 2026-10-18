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
  PIPE_CLOSED_EXIT_CODE,
  terminalDeathCause,
  watchTerminalOutputErrors,
} from "@sid-code/cli/signal-teardown.ts";

const SIGNAL_TEARDOWN_TS = join(import.meta.dir, "../src/signal-teardown.ts");

describe("decideRepeatSignal（M3：无计时分支）", () => {
  test("第一个信号开始收尾", () => {
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      expect(decideRepeatSignal(null, s)).toBe("start");
    }
  });
  test("收尾中重复 SIGHUP / SIGTERM 一律忽略，与已过去多久无关", () => {
    // 旧实现「>2s 再来即强退」在同步卡死时根本执行不到、异步挂起时又被 1.5s 兜底抢先，已删。
    expect(decideRepeatSignal({ startedAt: 0 }, "SIGHUP")).toBe("ignore");
    expect(decideRepeatSignal({ startedAt: 0 }, "SIGTERM")).toBe("ignore");
    expect(decideRepeatSignal({ startedAt: -1e9 }, "SIGTERM")).toBe("ignore");
  });
  test("收尾中第二个 SIGINT 强退（headless 连按两次 Ctrl+C，与现状一致）", () => {
    expect(decideRepeatSignal({ startedAt: 0 }, "SIGINT")).toBe("force_exit");
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
    t = 60_000;
    target.emit("SIGHUP");
    expect(forced).toBe(0);
    target.emit("SIGINT");
    expect(forced).toBe(1);
    expect(ctl.arrivals()).toBe(4);
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
    const p = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
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
    const p = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
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

  test("T5：未被监听的流（真实文件 WriteStream）发出 EIO → onDead 不触发，错误照原路崩溃", () => {
    // 旧用例拿无监听的裸 EventEmitter，emit('error') 无论如何都抛，与被测函数无关（恒真）。
    // 这里断言两件事：onDead 没被调（不是 42）、崩溃的确实是那条文件错误（stderr 有原文）。
    // 若 watcher 被改成按 code 全局吞（uncaughtException 里匹配 EIO），第一条就红。
    const r = run(`
      const { createWriteStream } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      watchTerminalOutputErrors([process.stdout, process.stderr], () => process.exit(42));
      process.on("uncaughtException", (e) => {
        if (e && e.code === "EIO" && globalThis.__sidSwallow) process.exit(42);
        process.stderr.write("CRASH:" + e.message + "\\n");
        process.exit(7);
      });
      const fileStream = createWriteStream(tmpdir() + "/sid-t5-" + process.pid + ".log");
      fileStream.emit("error", Object.assign(new Error("file eio"), { code: "EIO" }));
    `);
    expect(r.code).toBe(7);
    expect(r.err).toContain("CRASH:file eio");
  });

  test("T5：被监听流之外、自带 error 监听的流收到 EIO —— 走它自己的监听器，onDead 不触发", () => {
    let dead = 0;
    const watched = new EventEmitter() as unknown as NodeJS.WriteStream;
    (watched as any).destroy = () => {};
    watchTerminalOutputErrors([watched], () => dead++);
    const other = new EventEmitter();
    let own = 0;
    other.on("error", () => own++);
    other.emit("error", Object.assign(new Error("x"), { code: "EIO" }));
    expect({ dead, own }).toEqual({ dead: 0, own: 1 });
    watched.emit("error", Object.assign(new Error("x"), { code: "EIO" }));
    expect(dead).toBe(1);
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

describe("L7：EPIPE 与 EIO 分开归因", () => {
  test("EPIPE → pipe_closed（管道下游关闭），EIO → terminal_closed", () => {
    expect(terminalDeathCause({ code: "EPIPE" })).toBe("pipe_closed");
    expect(terminalDeathCause({ code: "EIO" })).toBe("terminal_closed");
    expect(PIPE_CLOSED_EXIT_CODE).toBe(141);
  });
});

/**
 * M3 验收用例 2：删掉「>2s 第二个信号强退」后，收尾里**异步挂起**仍能由 forceExitTimer 退出。
 * 跑生产的 armForceExit + installTeardownSignalHandlers。
 * 变异自证：run 里去掉 armForceExit，进程挂住到 10s 被测试 kill → 这条红。
 */
describe("真进程 · 收尾异步挂起由 forceExit 兜底", () => {
  test("收尾 await 永不 resolve：1.5s 内以 129 退出；期间第二个 SIGHUP 不打断也不提前杀", async () => {
    const script = `
      const { installTeardownSignalHandlers, armForceExit } = await import(${JSON.stringify(SIGNAL_TEARDOWN_TS)});
      installTeardownSignalHandlers({
        run: async () => {
          armForceExit(129, 800);
          process.stdout.write("enter\\n");
          await new Promise(() => {}); // SessionEnd hook 永久挂起
        },
        forceExit: () => process.exit(137),
      });
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `;
    const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    const dec = new TextDecoder();
    let out = "";
    while (!out.includes("ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    const t0 = Date.now();
    p.kill("SIGHUP");
    await new Promise((r) => setTimeout(r, 300));
    p.kill("SIGHUP");
    const killer = setTimeout(() => p.kill("SIGKILL"), 5_000);
    const code = await p.exited;
    clearTimeout(killer);
    expect(code).toBe(129);
    expect(Date.now() - t0).toBeLessThan(3_000);
  }, 10_000);
});

/**
 * T6：真 pty 集成 —— 关掉 pty master 后，挂着生产 handler 的进程走完收尾（落盘 done）并以 129 退出。
 * 用 python3 的 pty 模块开 pty（bun 无 pty API；GitHub 的 ubuntu / macos runner 都自带 python3）。
 * 子进程装的是生产的 installTeardownSignalHandlers + watchTerminalOutputErrors（与 app.ts 同接法：
 * EIO → trigger("SIGHUP")），收尾里写文件代表 messages.json 落盘。
 * 变异自证（2026-10-18 实跑）：去掉 SIGHUP 监听 → 退出码 -1（被信号杀）、无 done，这条红。
 * ⚠️ `on`→`once` 它锁不住：pty 关闭只发一次 SIGHUP，那个变异由上面「两发 SIGHUP」用例负责。
 */
describe("真 pty · 关闭终端后收尾落盘", () => {
  test("关 master → SIGHUP/EIO 收尾跑完、done 文件存在、退出码 129", () => {
    const { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sid-pty-"));
    try {
      const child = join(dir, "child.ts");
      const doneFile = join(dir, "done");
      writeFileSync(
        child,
        `
        const m = await import(${JSON.stringify(SIGNAL_TEARDOWN_TS)});
        const { writeFileSync } = await import("node:fs");
        const ctl = m.installTeardownSignalHandlers({
          run: async (sig) => {
            m.armForceExit(9, 1500);
            await new Promise((r) => setTimeout(r, 300)); // 模拟 SessionEnd 落盘耗时
            writeFileSync(${JSON.stringify(doneFile)}, sig);
            process.exit(129);
          },
          forceExit: () => process.exit(137),
        });
        m.watchTerminalOutputErrors([process.stdout, process.stderr], () => ctl.trigger("SIGHUP"));
        process.stdout.write("ready\\n");
        setInterval(() => process.stdout.write("tick\\n"), 20); // 关 pty 后持续写 → EIO
        `,
      );
      const driver = join(dir, "drive.py");
      writeFileSync(
        driver,
        [
          "import os, pty, sys, time",
          "pid, fd = pty.fork()",
          "if pid == 0:",
          "    os.execvp(sys.argv[1], [sys.argv[1], sys.argv[2]])",
          "buf = b''",
          "while b'ready' not in buf:",
          "    buf += os.read(fd, 1024)",
          "os.close(fd)",
          "deadline = time.time() + 6",
          "while time.time() < deadline:",
          "    r, st = os.waitpid(pid, os.WNOHANG)",
          "    if r:",
          "        print(os.waitstatus_to_exitcode(st)); sys.exit(0)",
          "    time.sleep(0.05)",
          "os.kill(pid, 9); print('hung')",
        ].join("\n"),
      );
      const r = Bun.spawnSync(["python3", "-I", driver, process.execPath, child], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = r.stdout.toString().trim();
      expect({ out, stderr: r.stderr.toString().slice(0, 300) }).toMatchObject({ out: "129" });
      expect(existsSync(doneFile)).toBe(true);
      expect(readFileSync(doneFile, "utf-8")).toBe("SIGHUP");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
