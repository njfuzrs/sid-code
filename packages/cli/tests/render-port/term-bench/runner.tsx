/**
 * 差分测试台的子进程入口（B9 / T0.4）。由 harness.ts 以
 * `bun runner.tsx <场景名>` 启动，fd 1 与 fd 2 都指向同一个文件 —— 模拟真实终端里
 * stdout / stderr 落在同一块屏幕上（E1 patchStderr 就靠这个才看得见）。
 *
 * 为什么必须是子进程：旧底座卸载时用 `writeSync(1, …)` 直写 fd 1（契约 X3），
 * 不经过 stdout 流对象，进程内用 PassThrough 截不到。fd 级重定向才能拿到完整字节，
 * 而 `process.stdout.write` 与 `writeSync(1)` 写同一个文件时顺序保持（2026-10-03 实测）。
 *
 * 步骤边界用 `OSC 7777` 标记直接写进同一字节流（xterm 忽略未知 OSC），
 * harness 按标记切段、逐段喂给 xterm 并拍快照。
 */
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import { SCENARIOS, type ScenarioCtx } from "./scenarios.tsx";
import { ENGINE_SCENARIOS } from "./engine-scenarios.tsx";

const name = process.argv[2]!;
// S* 是 App 级场景（基线文件），E* 是引擎级场景（T3.2，两套底座当场比较）
const scenario = SCENARIOS[name] ?? ENGINE_SCENARIOS[name];
const cols = Number(process.env.BENCH_COLS ?? 80);
const rows = Number(process.env.BENCH_ROWS ?? 24);

// 让底座把 process.stdout 当成 TTY（真实路径：fullscreen.ts 传的就是 process.stdout）
const out = process.stdout as unknown as Record<string, unknown>;
Object.defineProperty(out, "isTTY", { value: true, configurable: true });
Object.defineProperty(out, "columns", { value: cols, configurable: true, writable: true });
Object.defineProperty(out, "rows", { value: rows, configurable: true, writable: true });

const marker = (body: string) => writeSync(1, `\x1b]7777;${body}\x07`);

const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
Object.assign(stdin, {
  isTTY: true,
  isRaw: false,
  setRawMode(v: boolean) {
    (stdin as unknown as { isRaw: boolean }).isRaw = v;
    return stdin;
  },
  ref: () => stdin,
  unref: () => stdin,
});

// 帧耗时只在内存里攒，结束时一次性写出：渲染中途写标记可能插进同步输出块里
const frames: number[] = [];

const ctx: ScenarioCtx = {
  stdin,
  onFrame: (e) => {
    frames.push(e.durationMs);
  },
  cols,
  rows,
  step: (label) => marker(`step=${label}`),
  note: (key, value) => marker(`note=${key}=${encodeURIComponent(value)}`),
  settle: (ms = 120) => new Promise((r) => setTimeout(r, ms)),
  type: (s) => {
    (stdin as unknown as PassThrough).write(s);
  },
  resize: (c, r) => {
    marker(`resize=${c}x${r}`);
    out.columns = c;
    out.rows = r;
    process.stdout.emit("resize");
  },
};

if (!scenario) {
  marker(`error=${encodeURIComponent(`未知场景 ${name}`)}`);
  process.exit(2);
}
try {
  await scenario.run(ctx);
  marker(`perf=${encodeURIComponent(JSON.stringify({ frames }))}`);
  marker("done");
  process.exit(0);
} catch (e) {
  marker(`error=${encodeURIComponent(e instanceof Error ? (e.stack ?? e.message) : String(e))}`);
  process.exit(1);
}
