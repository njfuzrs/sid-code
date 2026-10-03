/**
 * 契约 R2 / R10 / L5 / I1b / I1c / I5 / I6 / M5 / O5 / E3 / X4（B9 / T0.5）：运行期行为。
 *
 * 这些契约都在 TTY 分支或进程级信号里，testing shim（非 TTY）覆盖不到，
 * 所以用 tty-streams.ts 的假 TTY 直接挂端口 renderSync。期望值是 2026-10-03 legacy 实测。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import React, { useState } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput } from "@sid-code/cli/ui/render-port/hooks.ts";
import { drainStdin } from "@sid-code/cli/ui/render-port/runtime.ts";
import {
  ENABLE_MOUSE,
  ENTER_ALT,
  ERASE_SCREEN,
  HIDE_CURSOR,
  mountTTY,
  tick,
  ttyStreams,
} from "./tty-streams.ts";

const REPO = join(import.meta.dir, "../../../..");

/** 打开 raw mode 的最小组件：底座只在 raw mode 下挂 readable 读者（契约 I1） */
function Keys({ log, label = "k" }: { log?: string[]; label?: string }) {
  useInput((input, key) => {
    log?.push(key.ctrl ? `ctrl+${input}` : input);
  });
  return <Text>{label}</Text>;
}

const envBackup: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
});

describe("R2 帧调度", () => {
  test("R2: 同一 tick 内多次提交合并：microtask 后出 leading 帧，16ms 内只再补一个 trailing 帧", async () => {
    // NODE_ENV=test 时 reconciler 走 onImmediateRender（无节流），要测真实调度得临时切掉
    setEnv("NODE_ENV", "production");
    const s = ttyStreams();
    let frames = 0;
    // rerender 走 updateContainerSync，提交是同步的；调度合并只发生在「提交 → 出帧」这一段
    const m = mountTTY(<Text>n=0</Text>, s, { onFrame: () => frames++ });
    await tick();
    const base = frames;
    for (let i = 1; i <= 5; i++) m.inst.rerender(<Text>n={i}</Text>);
    expect(frames).toBe(base); // 同步阶段不出帧
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toBe(base + 1); // leading：microtask 里出一帧
    await tick(50);
    expect(frames).toBe(base + 2); // trailing：只补一帧，不是 5 帧
    expect(s.out()).toContain("5");
    m.teardown();
  });
});

describe("R10 SIGCONT 恢复", () => {
  test("R10: alt-screen 下 SIGCONT → 重进 alt + 擦屏 + 重新打开鼠标跟踪", async () => {
    const s = ttyStreams();
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    m.ink.setAltScreenActive(true, true);
    s.clear();
    process.emit("SIGCONT" as NodeJS.Signals);
    expect(s.out().startsWith(ENTER_ALT + ERASE_SCREEN)).toBe(true);
    expect(s.out()).toContain(ENABLE_MOUSE);
    m.teardown();
  });

  test("R10: alt-screen 未开鼠标时 SIGCONT 不打开鼠标跟踪", async () => {
    const s = ttyStreams();
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    m.ink.setAltScreenActive(true, false);
    s.clear();
    process.emit("SIGCONT" as NodeJS.Signals);
    expect(s.out()).toContain(ENTER_ALT);
    expect(s.out()).not.toContain(ENABLE_MOUSE);
    m.teardown();
  });

  test("R10: 主屏下 SIGCONT 不进 alt-screen，只作废帧缓存（不立即写字节）", async () => {
    const s = ttyStreams();
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    s.clear();
    process.emit("SIGCONT" as NodeJS.Signals);
    expect(s.out()).toBe("");
    m.teardown();
  });

  test("R10: 卸载后摘掉 SIGCONT 监听", async () => {
    const before = process.listenerCount("SIGCONT");
    const s = ttyStreams();
    const m = mountTTY(<Text>x</Text>, s);
    expect(process.listenerCount("SIGCONT")).toBe(before + 1);
    m.teardown();
    expect(process.listenerCount("SIGCONT")).toBe(before);
  });
});

describe("L5 交互判定只看 stdout.isTTY", () => {
  test("L5: CI=true 但 stdout 是 TTY → 仍按交互模式（隐藏光标、挂 SIGCONT）", async () => {
    setEnv("CI", "true");
    setEnv("CLAUDE_CODE_ACCESSIBILITY", undefined);
    const before = process.listenerCount("SIGCONT");
    const s = ttyStreams();
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    expect(s.out()).toContain(HIDE_CURSOR);
    expect(process.listenerCount("SIGCONT")).toBe(before + 1);
    m.teardown();
  });

  test("L5: stdout 非 TTY → 不隐藏光标、不挂 SIGCONT（与 CI 变量无关）", async () => {
    setEnv("CI", undefined);
    const before = process.listenerCount("SIGCONT");
    const s = ttyStreams({ stdoutTTY: false });
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    expect(s.out()).not.toContain(HIDE_CURSOR);
    expect(process.listenerCount("SIGCONT")).toBe(before);
    m.teardown();
  });
});

describe("I1b readable 回调抛错后的恢复", () => {
  test("I1b: 回调抛错且监听被摘掉 → 重新挂上，后续按键照常送达", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const s = ttyStreams({ stdoutTTY: false });
    const log: string[] = [];
    function C() {
      useInput((input) => {
        log.push(input);
        if (input === "x") {
          // 模拟 Bun 在回调抛错后摘掉监听
          s.stdin.removeAllListeners("readable");
          throw new Error("boom");
        }
      });
      return <Text>x</Text>;
    }
    const m = mountTTY(<C />, s);
    await tick();
    s.stdin.write("a");
    await tick();
    s.stdin.write("x");
    await tick();
    expect(s.stdin.listenerCount("readable")).toBe(1);
    s.stdin.write("b");
    await tick();
    m.teardown();
    err.mockRestore();
    expect(log).toEqual(["a", "x", "b"]);
  });
});

describe("I1c stdin 静默后的模式重申", () => {
  async function gapRun(gapMs: number) {
    const s = ttyStreams();
    const m = mountTTY(<Keys />, s);
    await tick();
    m.ink.setAltScreenActive(true, true);
    const real = Date.now;
    const t0 = real();
    const now = spyOn(Date, "now").mockImplementation(() => t0 + gapMs);
    s.clear();
    s.stdin.write("a");
    await tick();
    now.mockRestore();
    const out = s.out();
    m.teardown();
    return out;
  }

  test("I1c: 静默 > 5s 后的首次输入 → 重新打开鼠标跟踪", async () => {
    expect(await gapRun(6000)).toContain(ENABLE_MOUSE);
  });

  test("I1c: 静默 < 5s 不重申", async () => {
    expect(await gapRun(1000)).not.toContain(ENABLE_MOUSE);
  });

  test("I1c: 重申不擦屏（stdin 静默不是 alt-screen 丢失的强信号）", async () => {
    expect(await gapRun(6000)).not.toContain(ERASE_SCREEN);
  });
});

describe("I5 drainStdin", () => {
  test("I5: TTY stdin 的已缓冲字节全部读掉丢弃，raw mode 恢复原状", () => {
    const s = ttyStreams();
    s.stdin.pause();
    s.stdin.push("leftover-mouse-bytes");
    expect(s.stdin.readableLength).toBeGreaterThan(0);
    drainStdin(s.stdin);
    expect(s.stdin.readableLength).toBe(0);
    expect(s.stdin.isRaw).toBe(false);
  });

  test("I5: 非 TTY stdin 不动", () => {
    const s = ttyStreams();
    (s.stdin as unknown as { isTTY: boolean }).isTTY = false;
    s.stdin.pause();
    s.stdin.push("piped");
    drainStdin(s.stdin);
    expect(s.stdin.readableLength).toBe(5);
  });
});

describe("I6 exitOnCtrlC", () => {
  test("I6: exitOnCtrlC=false 时 Ctrl+C 交给 useInput，应用不退出", async () => {
    const s = ttyStreams({ stdoutTTY: false });
    const log: string[] = [];
    const m = mountTTY(<Keys log={log} />, s, { exitOnCtrlC: false });
    let exited = false;
    void m.inst.waitUntilExit().then(() => (exited = true));
    await tick();
    s.stdin.write("\x03");
    await tick();
    expect(log).toEqual(["ctrl+c"]);
    expect(exited).toBe(false);
    m.teardown();
  });

  test("I6: exitOnCtrlC=true 时底座吞掉 Ctrl+C 并退出，useInput 收不到", async () => {
    const s = ttyStreams({ stdoutTTY: false });
    const log: string[] = [];
    const m = mountTTY(<Keys log={log} />, s, { exitOnCtrlC: true });
    let exited = false;
    void m.inst.waitUntilExit().then(() => (exited = true));
    await tick();
    s.stdin.write("\x03");
    await tick();
    expect(log).toEqual([]);
    expect(exited).toBe(true);
    m.teardown();
  });
});

describe("M5 选区背景色", () => {
  const level = chalk.level;
  afterEach(() => {
    chalk.level = level;
  });

  async function selectHello(color: string | null) {
    chalk.level = 3;
    const s = ttyStreams();
    const m = mountTTY(
      <Box flexDirection="column">
        <Text>hello world</Text>
      </Box>,
      s,
    );
    await tick();
    m.ink.setAltScreenActive(true, false);
    if (color !== null) m.ink.setSelectionBgColor(color);
    m.ink.selection.anchor = { col: 0, row: 0 };
    m.ink.selection.focus = { col: 4, row: 0 };
    s.clear();
    m.ink.forceRedraw();
    await tick();
    const out = s.out();
    const text = m.ink.copySelectionNoClear();
    m.teardown();
    return { out, text };
  }

  test("M5: 设了颜色 → 选区用该背景色", async () => {
    const { out, text } = await selectHello("#ff0000");
    expect(out).toContain("\x1b[48;2;255;0;0mhello");
    expect(text).toBe("hello");
  });

  test("M5: 没设颜色 → 回退反色", async () => {
    const { out } = await selectHello(null);
    expect(out).toContain("\x1b[7mhello");
  });
});

describe("O5 CLAUDE_CODE_ACCESSIBILITY", () => {
  test("O5: 无障碍模式下不隐藏光标（屏幕放大器要跟踪它）", async () => {
    setEnv("CLAUDE_CODE_ACCESSIBILITY", "1");
    const s = ttyStreams();
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    expect(s.out()).not.toContain(HIDE_CURSOR);
    m.teardown();
  });

  test("O5: 默认隐藏光标", async () => {
    setEnv("CLAUDE_CODE_ACCESSIBILITY", undefined);
    const s = ttyStreams();
    const m = mountTTY(<Text>x</Text>, s);
    await tick();
    expect(s.out()).toContain(HIDE_CURSOR);
    m.teardown();
  });
});

describe("E3 stdout EIO / EPIPE 护栏（CLI 侧）", () => {
  // 处理器绑死 process.stdout，进程内测会把测试进程的 stdout 销毁 —— 放子进程里测
  const PROCESS_TS = join(REPO, "packages/shared/src/utils/process.ts");
  const script = (register: boolean, code: string) => `
    ${
      register
        ? `const { registerProcessOutputErrorHandlers } = await import(${JSON.stringify(PROCESS_TS)});
    registerProcessOutputErrorHandlers();`
        : ""
    }
    const e = Object.assign(new Error("x"), { code: ${JSON.stringify(code)} });
    process.stdout.emit("error", e);
    await new Promise((r) => setTimeout(r, 20));
    process.stderr.write("alive");
  `;
  const run = (register: boolean, code: string) => {
    const p = Bun.spawnSync(["bun", "-e", script(register, code)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, err: p.stderr.toString() };
  };

  for (const code of ["EIO", "EPIPE"]) {
    test(`E3: 注册后 stdout 的 ${code} 不变成 uncaughtException，进程继续跑`, () => {
      const r = run(true, code);
      expect(r.code).toBe(0);
      expect(r.err).toContain("alive");
    });
  }

  test("E3: 对照组 —— 不注册时同样的错误会让进程崩溃（证明上面不是空测）", () => {
    const r = run(false, "EIO");
    expect(r.code).not.toBe(0);
    expect(r.err).not.toContain("alive");
  });

  test("E3: fullscreen.ts 在 render() 之前注册（底座一 render 就开始写 stdout）", () => {
    const src = readFileSync(join(REPO, "packages/cli/src/ui/fullscreen.ts"), "utf8");
    const reg = src.indexOf("registerProcessOutputErrorHandlers();");
    const rend = src.indexOf("await render(");
    expect(reg).toBeGreaterThan(0);
    expect(rend).toBeGreaterThan(reg);
  });
});

describe("X4 detachForShutdown", () => {
  test("X4: 标记卸载、退出 raw mode、drain stdin，且不写任何终端序列；之后的提交不再出帧", async () => {
    const s = ttyStreams();
    let setN: (n: number) => void = () => {};
    function C() {
      const [n, set] = useState(0);
      setN = set;
      useInput(() => {});
      return <Text>n={n}</Text>;
    }
    const m = mountTTY(<C />, s);
    await tick();
    expect(s.stdin.isRaw).toBe(true);
    s.clear();
    m.ink.detachForShutdown();
    expect(s.out()).toBe("");
    expect(s.stdin.isRaw).toBe(false);
    expect(s.stdin.readableLength).toBe(0);
    setN(1);
    await tick(50);
    expect(s.out()).toBe("");
    m.teardown(); // 已标记卸载，unmount 早退 —— 也不写 fd 1
  });
});
