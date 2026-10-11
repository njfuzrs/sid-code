/**
 * B9 / T2.3：termio 端口面与旧底座逐字节一致（契约 O4 / O6 / O7 / M3）。
 *
 * 做法：同一段探针脚本只经端口 `render-port/termio.ts` 调用，在子进程里跑，环境矩阵逐条与
 * T9.1 删除旧底座前冻结的 legacy 输出（`fixtures/legacy-frozen/contracts-termio.json`）比较。
 * 子进程是必须的：osc 的终止符在模块加载时判定。
 *
 * 剪贴板用 PATH 前置的假命令（记录调用、按文件决定成败），不碰真实剪贴板。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { frozenKey, legacyFrozen } from "./fixtures/legacy-frozen.ts";

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
// 预热：每个假命令先执行一次。新写出的可执行文件第一次执行有一次性开销（空载实测 ~300ms，
// 满载时会越过下面探针里 400ms 的等待），而本机剪贴板那一路是「发出去不等」的——
// 没预热时，矩阵第一条（「O6: 默认」）会偶发漏记 pbcopy，看起来像与基线不一致。
// 这里同步付掉这笔开销，探针里的 400ms 只需要覆盖热启动（实测 6–14ms）。
const warmLog = join(work, "warmup.log");
for (const cmd of ["pbcopy", "clip", "wl-copy", "xclip", "xsel", "tmux"]) {
  Bun.spawnSync([join(BIN, cmd)], {
    stdin: new TextEncoder().encode("warm"),
    env: { PATH: "/usr/bin:/bin", FAKE_LOG: warmLog, FAKE_FAIL: join(work, "warmup.fail") },
  });
}
// 防空预热：六个假命令都真的跑过（否则这段预热静默失效，偶发失败会原样回来）
const warmed = readFileSync(warmLog, "utf8").split("\n").filter(Boolean).length;
if (warmed !== 6) throw new Error(`假命令预热只跑了 ${warmed}/6 个`);

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
];

function probe(env: Record<string, string>, tag: string) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !CLEAR.includes(k)) base[k] = v;
  const r = Bun.spawnSync([process.execPath, join(work, "probe.ts")], {
    cwd: resolve(import.meta.dir, "../../../.."),
    env: {
      ...base,
      PATH: `${BIN}:/usr/bin:/bin:${dirname(process.execPath)}`,
      FAKE_LOG: join(work, `${tag}.log`),
      FAKE_FAIL: join(work, `${tag}.fail`),
      ...env,
    },
  });
  if (r.exitCode !== 0) throw new Error(`探针失败：${r.stderr.toString()}`);
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

describe("termio 端口：与冻结的 legacy 输出逐字节一致", () => {
  MATRIX.forEach(([name, env], i) => {
    test(`O6: ${name}`, () => {
      // 冻结键用矩阵名：env 里有一条 PATH 含 bun 安装路径，跨机器会变
      const legacy = legacyFrozen<{ clip: unknown[]; OSC: object }>(
        "contracts-termio",
        frozenKey(name),
      );
      const next = probe(env, `m${i}`);
      expect(next).toEqual(legacy);
      // 防空对拍：基线真的有内容
      expect(legacy.clip.length).toBeGreaterThan(0);
      expect(Object.keys(legacy.OSC).length).toBe(19);
    });
  });
});
