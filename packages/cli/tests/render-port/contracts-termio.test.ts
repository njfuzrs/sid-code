/**
 * B9 / T2.3：termio 端口面在 legacy / next 两套底座上逐字节一致（契约 O4 / O6 / O7 / M3）。
 *
 * 做法：同一段探针脚本只经端口 `render-port/termio.ts` 调用，分别在 `SID_TUI_RENDERER=legacy|next`
 * 的子进程里跑，环境矩阵逐条比较输出。子进程是必须的：osc 的终止符在模块加载时判定，
 * 底座也只能在加载时选一次（select.ts）。
 *
 * 剪贴板用 PATH 前置的假命令（记录调用、按文件决定成败），不碰真实剪贴板。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PORT = resolve(import.meta.dir, "../../src/ui/render-port/termio.ts");
const work = mkdtempSync(join(tmpdir(), "termio-diff-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// 假命令：读完 stdin，记一行「命令 参数」，若命令名出现在 fail 文件里就退 1
const BIN = join(work, "bin");
Bun.spawnSync(["mkdir", "-p", BIN]);
for (const cmd of ["pbcopy", "clip", "wl-copy", "xclip", "xsel", "tmux"]) {
  const p = join(BIN, cmd);
  writeFileSync(
    p,
    `#!/bin/sh\ncat >/dev/null\necho "${cmd} $*" >> "$FAKE_LOG"\ngrep -qx "${cmd}" "$FAKE_FAIL" 2>/dev/null && exit 1\nexit 0\n`,
  );
  chmodSync(p, 0o755);
}

const PROBE = `
if (process.env.PLAT) Object.defineProperty(process, "platform", { value: process.env.PLAT });
const t = await import(${JSON.stringify(PORT)});
const fs = await import("node:fs");
// 本机剪贴板是发出去不等的，tmux 是等的，两者谁先落日志是竞态：分开记，各自保序（linux 的试探顺序是契约）
const log = () => {
  let lines = [];
  try { lines = fs.readFileSync(process.env.FAKE_LOG, "utf8").split("\\n").map((l) => l.trim()).filter(Boolean); } catch {}
  return { native: lines.filter((l) => !l.startsWith("tmux")), tmux: lines.filter((l) => l.startsWith("tmux")) };
};
const out = {
  OSC: t.OSC,
  BEL: t.BEL,
  osc: [t.osc(), t.osc(0, "t"), t.osc(52, "c", "QQ=="), t.osc("a", 1, ""), t.osc(8, "", "")],
  wrap: ["\\x1b]0;t\\x07", "\\x1b]9;a\\x1b\\\\", "", "x\\x1by"].map((s) => t.wrapForMultiplexer(s)),
  hyper: [t.supportsHyperlinks({ env: {} }), t.supportsHyperlinks()],
  clip: [],
};
for (const [i, fail] of (process.env.STEPS ?? "none").split(",").entries()) {
  fs.writeFileSync(process.env.FAKE_FAIL, fail.split("+").join("\\n") + "\\n");
  const seq = await t.setClipboard(process.env.TEXT ?? "hi");
  await new Promise((r) => setTimeout(r, 400)); // 本机剪贴板是发出去不等的
  out.clip.push({ seq, calls: log() });
  fs.writeFileSync(process.env.FAKE_LOG, "");
}
process.stdout.write(JSON.stringify(out));
`;
writeFileSync(join(work, "probe.ts"), PROBE);

const CLEAR = [
  "TMUX",
  "STY",
  "TERM",
  "TERM_PROGRAM",
  "KITTY_WINDOW_ID",
  "LC_TERMINAL",
  "SSH_CONNECTION",
  "FORCE_HYPERLINK",
  "WT_SESSION",
  "VTE_VERSION",
  "CI",
  "SID_TUI_RENDERER",
];

function probe(renderer: "legacy" | "next", env: Record<string, string>, tag: string) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !CLEAR.includes(k)) base[k] = v;
  const r = Bun.spawnSync([process.execPath, join(work, "probe.ts")], {
    cwd: resolve(import.meta.dir, "../../../.."),
    env: {
      ...base,
      PATH: `${BIN}:/usr/bin:/bin:${dirname(process.execPath)}`,
      FAKE_LOG: join(work, `${tag}-${renderer}.log`),
      FAKE_FAIL: join(work, `${tag}-${renderer}.fail`),
      SID_TUI_RENDERER: renderer,
      ...env,
    },
  });
  if (r.exitCode !== 0) throw new Error(`${renderer} 探针失败：${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}

const MATRIX: [string, Record<string, string>][] = [
  ["默认", {}],
  ["kitty TERM", { TERM: "xterm-kitty" }],
  ["kitty TERM_PROGRAM", { TERM_PROGRAM: "kitty" }],
  ["KITTY_WINDOW_ID", { KITTY_WINDOW_ID: "1" }],
  ["KITTY_WINDOW_ID 空", { KITTY_WINDOW_ID: "" }],
  ["tmux", { TMUX: "x" }],
  ["tmux + iTerm2", { TMUX: "x", LC_TERMINAL: "iTerm2" }],
  ["tmux + kitty", { TMUX: "x", TERM: "xterm-kitty" }],
  ["tmux 空", { TMUX: "" }],
  ["screen", { STY: "x" }],
  ["tmux + screen", { TMUX: "x", STY: "x" }],
  ["tmux 失败", { TMUX: "x", STEPS: "tmux" }],
  ["tmux 不存在", { TMUX: "x", PATH: `/usr/bin:/bin:${dirname(process.execPath)}` }],
  ["SSH", { SSH_CONNECTION: "1 2 3 4" }],
  ["SSH + tmux", { SSH_CONNECTION: "1", TMUX: "x" }],
  ["darwin pbcopy 失败后重试", { STEPS: "pbcopy,none" }],
  ["win32", { PLAT: "win32" }],
  ["linux 首选成功", { PLAT: "linux", STEPS: "none,wl-copy" }],
  ["linux 回落并记住", { PLAT: "linux", STEPS: "wl-copy,xclip,none" }],
  ["linux 全失败后不再试", { PLAT: "linux", STEPS: "wl-copy+xclip+xsel,none" }],
  ["freebsd", { PLAT: "freebsd" }],
  ["多字节内容", { TEXT: "a b\n中" }],
  ["iTerm 超链接", { TERM_PROGRAM: "iTerm.app" }],
  ["FORCE_HYPERLINK", { FORCE_HYPERLINK: "1" }],
  ["Apple Terminal", { TERM_PROGRAM: "Apple_Terminal" }],
];

describe("termio 端口：legacy 与 next 逐字节一致", () => {
  MATRIX.forEach(([name, env], i) => {
    test(`O6: ${name}`, () => {
      const legacy = probe("legacy", env, `m${i}`);
      const next = probe("next", env, `m${i}`);
      expect(next).toEqual(legacy);
      // 防空对拍：探针真的产出了东西
      expect(legacy.clip.length).toBeGreaterThan(0);
      expect(Object.keys(legacy.OSC).length).toBe(19);
    });
  });
});
