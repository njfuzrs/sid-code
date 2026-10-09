/**
 * 契约 I4 归属表「CLI：开 / 关」两列（B9 / T5.3b）：CLI 自己写 stdout 的终端模式序列（设计文档 §1.5 / D-4）。两套底座都跑。
 *
 * 走生产入口 createFullScreen + 真实 KeypressProvider / MouseProvider，底座与 CLI 写同一个 process.stdout，
 * 夹具按调用栈把每次写入归给 `cli` 或 `base`（fixtures/cli-modes-app.tsx）。
 * 结论（2026-10-09 实测）：CLI 直写全部留在 CLI（归属表方案 ②），没有新增端口符号 —— next 上 CLI 那几段
 * 与 legacy 逐字节一致，夹在底座写入之间的位置也一致，移进底座反而会改写入时序。
 * 卸载之后的底座写入不比：next 用 stdout.write、legacy 用 writeSync(1) 再关一次，相对顺序归 X3（T7.1b）。
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURE = join(import.meta.dir, "fixtures/cli-modes-app.tsx");
const MODE =
  /\x1b\[(\?(2004|1004|7|1000|1002|1003|1006|1007)[hl]|>4;[02]m|>4m|>\d+u|<u|>4;\?m|\?u)|\x1b\]11;\?/g;

type Renderer = "legacy" | "next";

/** 逐次写入 → `owner:模式序列`（非模式字节丢掉，整次写入不含模式的丢掉），夹着 `<<标记>>` */
function run(renderer: Renderer, scenario: string, env: Record<string, string>) {
  const r = Bun.spawnSync([process.execPath, FIXTURE, scenario], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SID_CONFIG_DIR: process.env.SID_CONFIG_DIR ?? "",
      SID_TUI_RENDERER: renderer,
      ...env,
    },
  });
  const err = r.stderr.toString();
  const i = err.indexOf("JSON:");
  if (r.exitCode !== 0 || i < 0)
    throw new Error(`${renderer} ${scenario} 夹具失败（rc=${r.exitCode}）：${err}`);
  const log = JSON.parse(err.slice(i + 5).split("\n")[0]!) as string[];
  const out: string[] = [];
  for (const x of log) {
    if (x.startsWith("<<")) {
      out.push(x);
      continue;
    }
    const sep = x.indexOf(":");
    const seq = (x.slice(sep + 1).match(MODE) ?? []).join("");
    if (seq) out.push(`${x.slice(0, sep)}:${seq.replaceAll("\x1b", "E")}`);
  }
  return out;
}

const cliOnly = (xs: string[]) => xs.filter((x) => x.startsWith("cli:") || x.startsWith("<<"));
const untilUnmount = (xs: string[]) => xs.slice(0, xs.indexOf("<<unmount>>"));

const PLAIN = { TERM: "xterm-256color" };
const KITTY = { TERM_PROGRAM: "kitty" };

const MOUSE_ON = "cli:E[?1000hE[?1002hE[?1006hE[?1007h";
const MOUSE_OFF = "cli:E[?1007lE[?1006lE[?1002lE[?1000l";
const DEAD = "<<exit-cleanup=false>>";

describe("I4: CLI 直写（归属表 CLI 两列）", () => {
  test.each([
    ["主屏、普通终端", "main", PLAIN],
    ["主屏、kitty", "main", KITTY],
  ] as const)("I4: %s —— CLI 只开 ?2004h，不开扩展键、不关任何模式", (_n, scenario, env) => {
    const want = ["cli:E[?2004h", "<<mounted>>", "<<unmount>>", "<<exited>>", DEAD];
    for (const r of ["legacy", "next"] as const)
      expect(cliOnly(run(r, scenario, env))).toEqual(want);
  });

  test("I4: alt-screen —— 鼠标随 MouseProvider 开关、?7 随 createFullScreen 关 / 恢复；Copy Mode 切换各写一次", () => {
    const want = [
      MOUSE_ON,
      "cli:E[?2004h",
      "cli:E[?7l",
      "<<mounted>>",
      MOUSE_OFF,
      "<<copy-on>>",
      MOUSE_ON,
      "<<copy-off>>",
      "<<unmount>>",
      MOUSE_OFF,
      "cli:E[?7h",
      "<<exited>>",
      DEAD,
    ];
    for (const r of ["legacy", "next"] as const)
      expect(cliOnly(run(r, "alt-copy", KITTY))).toEqual(want);
  });

  test.each([
    ["main", PLAIN],
    ["main", KITTY],
    ["alt", PLAIN],
    ["alt-copy", KITTY],
  ] as const)(
    "I4: %s %j —— 卸载前 CLI 与底座交错写入的完整模式序列两套底座逐条一致",
    (scenario, env) => {
      expect(untilUnmount(run("next", scenario, env))).toEqual(
        untilUnmount(run("legacy", scenario, env)),
      );
    },
  );

  test("I4: 卸载时 CLI 关鼠标、恢复 ?7 都写在底座关模式之后，?7h 是最后一笔", () => {
    for (const r of ["legacy", "next"] as const) {
      const xs = run(r, "alt-copy", KITTY);
      const tail = xs.slice(xs.indexOf("<<unmount>>") + 1, xs.indexOf("<<exited>>"));
      const firstBase = tail.findIndex((x) => x.startsWith("base:"));
      expect([r, firstBase >= 0 && tail.indexOf(MOUSE_OFF) > firstBase, tail.at(-1)]).toEqual([
        r,
        true,
        "cli:E[?7h",
      ]);
    }
  });
});
