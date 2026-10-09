/**
 * 契约 M4 补充（B9 / T8.1a）：按探查回复认出 xterm.js 后，alt-screen 里单击链接不由我们打开。
 *
 * 覆盖 SSH 进 VS Code 集成终端（`TERM_PROGRAM` 不传）的情形。期望值是 2026-10-09 对 legacy 的黑盒探针
 * （35 个变体，D-5，没读旧代码），探针备份在 `~/Backups/sid-code-t67-probe-results-20261008/T8.1a/`。
 * 两套底座跑同一份断言（`SID_TUI_RENDERER` 选底座）。识别结果是进程级的，每条用例一个子进程。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const E = "\x1b";
const XV = `${E}P>|xterm.js(6.1.0)${E}\\`;
const IV = `${E}P>|iTerm2 3.5${E}\\`;
const DA1 = `${E}[?1;2c`;
const FIXTURE = join(import.meta.dir, "fixtures", "xterm-identity-app.tsx");

/** [名字, 各实例收到的回复（"" = 等 100ms，模拟分块到达）, 各实例打开链接的次数] */
const CASES: Array<[string, string[][], number[]]> = [
  ["没有回复 → 照开", [[]], [1]],
  ["只有 XTVERSION（没等到 DA1）→ 照开", [[XV]], [1]],
  ["XTVERSION + DA1 同块 → 不开", [[XV + DA1]], [0]],
  ["XTVERSION 与 DA1 分两块到 → 不开", [[XV, "", DA1]], [0]],
  ["BEL 结尾的 XTVERSION 也算", [[`${E}P>|xterm.js(6.1.0)\x07${DA1}`]], [0]],
  [
    "名字只要以 xterm.js 开头：无版本号 / 带空格 / 带后缀都算",
    [[`${E}P>|xterm.jsX${E}\\${DA1}`]],
    [0],
  ],
  ["区分大小写：XTERM.JS 不算", [[`${E}P>|XTERM.JS(6.1.0)${E}\\${DA1}`]], [1]],
  ["名字不以 xterm.js 开头（myxterm.js）不算", [[`${E}P>|myxterm.js 1${E}\\${DA1}`]], [1]],
  ["别的终端名 → 照开", [[IV + DA1]], [1]],
  ["DA1 先到、XTVERSION 后到 → 照开（这个实例已定案为「不是」）", [[DA1 + XV]], [1]],
  ["DA1 先到就定案：之后再来 XTVERSION + DA1 也不改 → 照开", [[DA1, XV, DA1]], [1]],
  ["只有 DA2 不定案 → 照开", [[XV, `${E}[>1;10;0c`]], [1]],
  ["DA1 参数随意（?1c、?62;22c）都定案", [[`${XV}${E}[?62;22c`]], [0]],
  [
    "DA2 / DECRPM / 别的 DCS 不定案，之后的 DA1 才定案",
    [[XV, `${E}[>1;10;0c`, `${E}P1$r0m${E}\\`, DA1]],
    [0],
  ],
  ["只认实例收到的第一条 XTVERSION：先 iTerm 后 xterm.js → 照开", [[IV, XV, DA1]], [1]],
  ["先 xterm.js 后 iTerm → 不开", [[XV, IV, DA1]], [0]],
  ["进程级：定案后新实例不回复也不开", [[XV + DA1], []], [0, 0]],
  ["进程级：定案后再也改不回来", [[XV + DA1], [IV + DA1]], [0, 0]],
  ["进程级：先定案为别的终端，后面的实例认出 xterm.js 也不改", [[IV + DA1], [XV + DA1]], [1, 1]],
  ["只有 DA1 的实例不定案，后面的实例还能认出", [[DA1], [XV + DA1]], [1, 0]],
  [
    "XTVERSION 不跨实例：前一个实例只收到 XTVERSION，后一个只收到 DA1 → 照开",
    [[XV], [IV + DA1]],
    [1, 1],
  ],
];

describe("M4 × XTVERSION：认出 xterm.js 时不开链接", () => {
  test("子进程逐条对拍", async () => {
    const runs = CASES.map(async ([name, replies, want]) => {
      const p = Bun.spawn(["bun", FIXTURE], {
        env: { ...process.env, XID_CASE: JSON.stringify(replies) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      const m = /XID (\[.*\])/.exec(out);
      return { name, want, got: m ? (JSON.parse(m[1]!) as number[]) : null };
    });
    const results = await Promise.all(runs);
    // 子进程没打印结果（崩了）算失败，不当零断言放过
    expect(results.filter((r) => r.got === null).map((r) => r.name)).toEqual([]);
    expect(results.map((r) => [r.name, r.got])).toEqual(results.map((r) => [r.name, r.want]));
  }, 60000);
});
