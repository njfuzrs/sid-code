/**
 * 契约 E1 / E2（B9 / T7.1a）：裸 `process.stderr.write` 护栏与它的重入守卫。
 *
 * 期望值是 2026-10-09 冻结基线的黑盒实测（探针备份在 `~/Backups/sid-code-t67-probe-results-20261008/T7.1a/`）。
 * 每个用例跑一个子进程：断言冻结的行为基线（`fixtures/frozen-baseline/`）等于写死的期望，
 * 再断言当前实现与基线一致。
 * 必须是子进程：护栏换的是全局 `process.stderr.write`，`SID_CODE_DEBUG` 又在底座模块加载时读。
 *
 * ⚠️ 与 SPEC 旧描述不符：「alt-screen 下强制全量重绘」实测**不存在**。冻结基线里吞掉 stderr 后一个字节都不写，
 * 下一帧照常增量 diff（主屏、alt 都是）。这里按实测钉成「不擦屏、不重绘」。
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { frozenKey, frozenBaseline } from "./fixtures/frozen-baseline.ts";

const ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURE = join(import.meta.dir, "fixtures/stderr-guard-app.tsx");
const CLEAR = new Set([
  "SID_CODE_DEBUG",
  "FIXTURE_ALT",
  "FIXTURE_TTY",
  "FIXTURE_CE",
  // 终端识别类：决定 alt 帧包不包 DEC 2026（R14），宿主值会漏进断言
  "TERM",
  "TERM_PROGRAM",
  "TMUX",
  "STY",
  "KITTY_WINDOW_ID",
  "WT_SESSION",
  "ZED_TERM",
  "VTE_VERSION",
]);
/**
 * 冻结基线采集时的宿主终端（VS Code 集成终端）。alt-screen 那条的 frame 段因此带同步包裹；
 * 不钉住的话 CI（没有 TERM_PROGRAM）必然对不上。
 */
const FROZEN_HOST = { TERM: "xterm-256color", TERM_PROGRAM: "vscode" };

type Run = { notes: Record<string, unknown>; segments: Record<string, string>; fd2: string };

function run(scenario: string, env: Record<string, string | undefined>): Run {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !CLEAR.has(k)) base[k] = v;
  Object.assign(base, FROZEN_HOST);
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  const r = Bun.spawnSync([process.execPath, FIXTURE, scenario], {
    cwd: ROOT,
    env: base,
  });
  const s = r.stdout.toString();
  if (r.exitCode !== 0 || !s.includes("<<END>>")) {
    throw new Error(`${scenario} 夹具失败（rc=${r.exitCode}）：${r.stderr.toString()}`);
  }
  const notes: Record<string, unknown> = {};
  for (const m of s.matchAll(/<<([^@=>][^=>]*)=(.*?)>>/g)) notes[m[1]!] = JSON.parse(m[2]!);
  // 步骤标记之间的终端字节（剔掉观测记录本身）
  const segments: Record<string, string> = {};
  const parts = s.split(/<<@([^>]+)>>/);
  for (let i = 1; i < parts.length; i += 2) {
    segments[parts[i]!] = (parts[i + 1] ?? "").replace(/<<[^>]*>>/g, "");
  }
  return { notes, segments, fd2: r.stderr.toString() };
}

function both(scenario: string, env: Record<string, string | undefined> = {}) {
  const baseline = frozenBaseline<Run>("stderr-guard", frozenKey(scenario, env));
  return { baseline, actual: run(scenario, env) };
}

const LOG = (t: string) => [`[ink] [stderr] ${t}`, { level: "warn" }];
const BASIC_LOG = [LOG("A\n"), LOG("B\n"), LOG("68690a"), LOG("中文\n"), LOG("中"), LOG("")];

describe("E1 裸 stderr 护栏", () => {
  const envs: [string, Record<string, string>][] = [
    ["主屏", {}],
    ["alt-screen", { FIXTURE_ALT: "1" }],
    ["stdout 非 TTY", { FIXTURE_TTY: "0" }],
  ];
  for (const [name, env] of envs) {
    test(`E1: ${name}下吞掉、返回 true、回调同步无参、不擦屏不重绘、卸载后还原`, () => {
      const { baseline, actual } = both("basic", { ...env, SID_CODE_DEBUG: "1" });
      expect(baseline.notes.patched).toBe(true);
      expect(baseline.notes.ret).toEqual([true, true]);
      // 回调在 write 返回之前同步调用，不带参数（没有 error 位）
      expect(baseline.notes.cb).toEqual(["cb1:0", "after1", "cb2:0"]);
      expect(baseline.notes.restored).toBe(true);
      // 吞掉：write → 下一帧之间终端上 0 字节，stderr 管道里也没有
      expect(baseline.segments.write).toBe("");
      expect(baseline.fd2).toBe("AFTER\n");
      // 卸载之后 stderr 原样落地
      expect(baseline.segments["after-unmount"]).toBe("");
      for (const k of ["patched", "ret", "cb", "restored"])
        expect(actual.notes[k]).toEqual(baseline.notes[k]);
      expect(actual.segments.write).toBe(baseline.segments.write);
      // 吞掉之后的下一帧与冻结基线同字节（增量，不是整帧重画）
      expect(actual.segments.frame).toBe(baseline.segments.frame);
      expect(actual.fd2).toBe(baseline.fd2);
    });
  }

  test("E1: SID_CODE_DEBUG=1 时进 debug 日志：字符串忽略 encoding，其余按 UTF-8 解码，空串也记", () => {
    const { baseline, actual } = both("basic", { SID_CODE_DEBUG: "1" });
    expect(baseline.notes.log).toEqual(BASIC_LOG);
    expect(actual.notes.log).toEqual(baseline.notes.log);
  });

  const debugValues: [string, string | undefined, boolean][] = [
    ["1", "1", true],
    ["true", "true", true],
    ["0", "0", false],
    ["TRUE（大小写敏感）", "TRUE", false],
    [" 1（不去空白）", " 1", false],
    ["yes", "yes", false],
    ["未设置", undefined, false],
  ];
  for (const [name, value, logs] of debugValues) {
    test(`E1: SID_CODE_DEBUG=${name} → ${logs ? "记日志" : "不记日志"}，吞掉不受影响`, () => {
      const { baseline, actual } = both("basic", { SID_CODE_DEBUG: value });
      expect(baseline.notes.log).toEqual(logs ? BASIC_LOG : []);
      expect(baseline.segments.write).toBe("");
      expect(actual.notes.log).toEqual(baseline.notes.log);
      expect(actual.segments.write).toBe("");
    });
  }

  test("E1: 非法 chunk（对象 / null / undefined）先调回调、再抛 TypeError", () => {
    const { baseline, actual } = both("basic", { SID_CODE_DEBUG: "0" });
    for (const k of ["bad:object", "bad:null", "bad:undefined"]) {
      expect(baseline.notes[k]).toEqual(["cb", "threw:TypeError"]);
      expect(actual.notes[k]).toEqual(baseline.notes[k]);
    }
  });

  test("E1: 只换全局 process.stderr；多实例按挂载顺序各自还原，乱序卸载留下拦截器；别人换掉的不覆盖；卸载期间清理函数的 stderr 落地", () => {
    const { baseline, actual } = both("lifecycle", { SID_CODE_DEBUG: "1" });
    expect(baseline.notes.steps).toEqual([
      "a:true",
      "custom-untouched:true",
      "b-new:true",
      "b-off->pa:true",
      "a-off->orig:true",
      "a2-off-still-patched:true",
      "b2-off-still-patched:true",
      "foreign-kept:true",
    ]);
    // 自定义 stderr 选项不拦，原样写
    expect(baseline.notes.custom).toEqual(["C\n"]);
    // 卸载一开始就还原，React 清理里写的 stderr 直接落地、不进日志
    expect(baseline.notes.log).toEqual([]);
    expect(baseline.fd2).toBe("CLEANUP\n");
    for (const k of ["steps", "custom", "log"]) expect(actual.notes[k]).toEqual(baseline.notes[k]);
    expect(actual.fd2).toBe(baseline.fd2);
  });
});

describe("E2 重入守卫", () => {
  test("E2: 日志路径里再写 stderr 时直接放行到原始 write，不递归、不再记日志", () => {
    const { baseline, actual } = both("reenter", { SID_CODE_DEBUG: "1", FIXTURE_CE: "loop" });
    expect(baseline.notes.res).toEqual(["cb:R1", "true", "cb:R2", "true"]);
    expect(baseline.notes.log).toEqual([LOG("R1\n"), LOG("R2\n")]);
    expect(baseline.fd2).toBe("inner:1\ninner:2\n");
    expect(baseline.notes.restored).toBe(true);
    for (const k of ["res", "log", "restored"]) expect(actual.notes[k]).toEqual(baseline.notes[k]);
    expect(actual.fd2).toBe(baseline.fd2);
  });

  test("E2: 日志抛错时回调照调、错误向上抛，守卫复位（下一次写照常进日志）", () => {
    const { baseline, actual } = both("reenter", { SID_CODE_DEBUG: "1", FIXTURE_CE: "throw" });
    expect(baseline.notes.res).toEqual(["cb:R1", "threw:boom", "cb:R2", "threw:boom"]);
    expect(baseline.notes.log).toEqual([LOG("R1\n"), LOG("R2\n")]);
    expect(baseline.fd2).toBe("");
    for (const k of ["res", "log", "restored"]) expect(actual.notes[k]).toEqual(baseline.notes[k]);
    expect(actual.fd2).toBe(baseline.fd2);
  });
});
