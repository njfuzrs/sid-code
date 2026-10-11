/**
 * 契约 I4（B9 / T5.3a）：底座侧的输入终端模式 —— bracketed paste `?2004`、focus `?1004`、
 * 扩展键（kitty `>1u` / modifyOtherKeys `>4;2m`）跟着 raw mode 计数的开关。两套底座都跑。
 *
 * 期望值全部是 2026-10-08 对拍 legacy 的黑盒探针实测（`_probe_i4*`，约 1600 组环境变量组合 + 场景矩阵，
 * 备份在 `~/Backups/sid-code-t5x-probe-results-20261008/t53a/`），没有读旧底座代码（设计文档 D-5）。
 * 必须是子进程：扩展键开不开在底座模块加载时按环境变量判定一次。
 * 只比 I4 那几段字节与 stdin 调用记录；首帧、光标、探查（I2）、进度 / tab 清除（O3）不比，
 * 卸载时这些与「再关一次」的相对顺序归 X3（T7.1b）。CLI 自己写的模式序列归 T5.3b。
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURE = join(import.meta.dir, "fixtures/terminal-modes-app.tsx");
const E = "\x1b";

/** 宿主终端的识别变量会影响扩展键判定，子进程只给 PATH / HOME 与矩阵里的变量 */
function spawn(scenario: string, env: Record<string, string>) {
  return Bun.spawnSync([process.execPath, FIXTURE, scenario], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SID_CONFIG_DIR: process.env.SID_CONFIG_DIR ?? "",
      ...env,
    },
  });
}

const KEEP = new Set([
  `${E}[?2004h`,
  `${E}[?1004h`,
  `${E}[>1u`,
  `${E}[>4;2m`,
  `${E}[>4m`,
  `${E}[<u`,
  `${E}[?1004l`,
  `${E}[?2004l`,
  `${E}[<u${E}[>1u${E}[>4;2m`,
]);

/** 场景的 I4 视图：逐次写入里只留模式序列（转成 `E[…`）、`<<标记>>` 与 `{stdin 调用}`，空格连接 */
function modes(scenario: string, env: Record<string, string>) {
  const r = spawn(scenario, env);
  const err = r.stderr.toString();
  const i = err.indexOf("JSON:");
  if (r.exitCode !== 0 || i < 0)
    throw new Error(`${scenario} 夹具失败（rc=${r.exitCode}）：${err}`);
  const log = JSON.parse(err.slice(i + 5).split("\n")[0]!) as string[];
  return log
    .filter((x) => KEEP.has(x) || x.startsWith("<<") || x.startsWith("{"))
    .map((x) => x.replaceAll(E, "E"))
    .join(" ");
}

const PLAIN = { TERM: "xterm-256color" };
const KITTY = { TERM_PROGRAM: "kitty" };
const KITTY_PIPE = { TERM_PROGRAM: "kitty", FIXTURE_TTY: "0" };

const ON = "{ref} {raw:true} E[?2004h E[?1004h";
const ON_EXT = `${ON} E[>1u E[>4;2m`;
const OFF = "E[>4m E[<u E[?1004l E[?2004l {raw:false} {unref}";

function both(scenario: string, env: Record<string, string>, expected: string) {
  expect(modes(scenario, env)).toBe(expected);
}

describe("I4: 跟着 raw mode 计数开关", () => {
  test("I4: 0 → 1 在 ref + setRawMode(true) 之后写 ?2004h、?1004h（扩展键再加 >1u、>4;2m），各一次写入；归零时先关模式再关 raw mode", () => {
    both("mount", PLAIN, `${ON} <<mounted>> <<unmount>> ${OFF}`);
    both("mount", KITTY, `${ON_EXT} <<mounted>> <<unmount>> ${OFF}`);
  });

  test("I4: stdout 非 TTY 照样写", () => {
    both("mount", KITTY_PIPE, `${ON_EXT} <<mounted>> <<unmount>> ${OFF}`);
  });

  test("I4: 同一组件两个 useInput 只开一次", () => {
    both("two", KITTY, `${ON_EXT} <<mounted>> <<unmount>> ${OFF}`);
  });

  test("I4: 手动 setRawMode：1 → 2、2 → 1 不写；负数期间不写；补回到 1 时再开", () => {
    for (const [env, on] of [
      [PLAIN, ON],
      [KITTY, ON_EXT],
    ] as const) {
      both(
        "raw-count",
        env,
        `<<mounted>> ${on} <<r1>> <<r2>> <<f1>> ${OFF} <<f0>> <<neg>> <<back0>> ${on} <<on>> <<unmount>> ${OFF}`,
      );
    }
  });

  test("I4: isActive 关了再开 = 一次关、一次开", () => {
    both(
      "active",
      KITTY,
      `${ON_EXT} <<mounted>> ${OFF} <<off>> ${ON_EXT} <<on>> <<unmount>> ${OFF}`,
    );
  });

  test("I4: 终端探查的回复不影响扩展键（只看环境变量）", () => {
    both("probe-reply", PLAIN, `${ON} <<mounted>> ${OFF} <<off>> ${ON} <<on>> <<unmount>> ${OFF}`);
    both(
      "probe-reply",
      KITTY,
      `${ON_EXT} <<mounted>> ${OFF} <<off>> ${ON_EXT} <<on>> <<unmount>> ${OFF}`,
    );
  });

  test("I4: useApp().exit() 时关一次模式", () => {
    // TTY 下 legacy 在退出路径上还多调一对 setRawMode(true/false)，那是 X 组（T7.1b）的事，这里只比非 TTY
    both("raw-exit", KITTY_PIPE, `<<mounted>> ${ON_EXT} <<on>> ${OFF} <<exited>> <<unmount>>`);
  });
});

describe("I4: Ctrl+Z 挂起与恢复（与 I7 共用的那几段）", () => {
  test("I4: 恢复时计数 > 0 重开整套（含扩展键）；TTY 再补一次 ?1004h", () => {
    const stop = `${OFF} {kill:SIGSTOP} <<stopped>>`;
    both("suspend", PLAIN, `${ON} <<mounted>> ${stop} ${ON} E[?1004h <<cont>> <<unmount>> ${OFF}`);
    both(
      "suspend",
      KITTY,
      `${ON_EXT} <<mounted>> ${stop} ${ON_EXT} E[?1004h <<cont>> <<unmount>> ${OFF}`,
    );
    both(
      "suspend",
      KITTY_PIPE,
      `${ON_EXT} <<mounted>> ${stop} ${ON_EXT} <<cont>> <<unmount>> ${OFF}`,
    );
  });

  test("I4: 挂起期间计数降到 0：恢复时不开输入模式（TTY 只有那次 ?1004h），之后 0 → 1 照常开", () => {
    const head = `${ON_EXT} <<mounted>> ${OFF} {kill:SIGSTOP} <<stopped>> <<cnt0>>`;
    both("suspend-drop", KITTY, `${head} E[?1004h <<cont>> ${ON_EXT} <<on>> <<unmount>> ${OFF}`);
    both("suspend-drop", KITTY_PIPE, `${head} <<cont>> ${ON_EXT} <<on>> <<unmount>> ${OFF}`);
  });

  test("I4: 挂起期间卸载：不再写模式、不碰 stdin，之后的 SIGCONT 什么都不做", () => {
    both(
      "suspend-unmount",
      KITTY,
      `${ON_EXT} <<mounted>> ${OFF} {kill:SIGSTOP} <<stopped>> <<unmounted>> <<cont>>`,
    );
  });
});

describe("I4: stdin 静默 > 5s 后的第一块输入重申扩展键（I1c 的一部分）", () => {
  test("I4: 扩展键开着、TTY：主屏与 alt 都整段写 `<u >1u >4;2m`（一次写入）；没开扩展键 / 非 TTY / 不到 5s 不写", () => {
    const tail = `<<after>> <<unmount>> ${OFF}`;
    both("silence", KITTY, `${ON_EXT} <<mounted>> <<before>> E[<uE[>1uE[>4;2m ${tail}`);
    both("silence-alt", KITTY, `${ON_EXT} <<mounted>> <<before>> E[<uE[>1uE[>4;2m ${tail}`);
    both("silence", PLAIN, `${ON} <<mounted>> <<before>> ${tail}`);
    both("silence", KITTY_PIPE, `${ON_EXT} <<mounted>> <<before>> ${tail}`);
    both("silence-short", KITTY, `${ON_EXT} <<mounted>> <<before>> ${tail}`);
  });
});

describe("I4: 卸载时再关一次", () => {
  const DISABLE = `${E}[>4m${E}[<u${E}[?1004l${E}[?2004l`;
  const count = (env: Record<string, string>) => {
    const out = spawn("unmount-fd1", env).stdout.toString();
    const seg = out.slice(out.indexOf("<UNMOUNT>"), out.indexOf("<END>"));
    return seg.split(DISABLE).length - 1;
  };
  // 次数 = raw mode 归零那次（用了 useInput 才有）+ TTY 下卸载时无条件再关一次；位置归 X3
  test.each([
    ["TTY + useInput", { ...KITTY }, 2],
    ["TTY、没用 useInput", { ...KITTY, FIXTURE_INPUT: "0" }, 1],
    ["非 TTY + useInput", { ...KITTY, FIXTURE_TTY: "0" }, 1],
    ["非 TTY、没用 useInput", { ...KITTY, FIXTURE_TTY: "0", FIXTURE_INPUT: "0" }, 0],
  ] as const)("I4: %s", (_name, env, n) => {
    expect(count(env)).toBe(n);
  });
});

describe("I4: 扩展键判定（只看环境变量）", () => {
  // 期望值是 legacy 子进程实测；全量矩阵（纯函数逐条）在 `packages/tui/tests/extended-keys.test.ts`，
  // 这里跑子进程抽样，确认底座真的按判定结果写字节
  const MATRIX: [Record<string, string>, boolean][] = [
    [{}, false],
    [{ TERM_PROGRAM: "kitty" }, true],
    [{ TERM_PROGRAM: "Ghostty" }, false],
    [{ TERM: "xterm-ghostty" }, true],
    [{ KITTY_WINDOW_ID: "" }, false],
    [{ TERM_PROGRAM: "vscode", TMUX: "/x" }, false],
    [{ STY: "1", TMUX: "/x" }, true],
    [{ SSH_TTY: "1", WT_SESSION: "1" }, true],
    [{ CURSOR_TRACE_ID: "1", TERM: "xterm-kitty" }, false],
    [{ VSCODE_GIT_ASKPASS_MAIN: "/a/Cursor.app/b", TERM_PROGRAM: "kitty" }, true],
  ];

  test("I4: 子进程抽样", () => {
    for (const [env, want] of MATRIX) {
      const expected = `${want ? ON_EXT : ON} <<mounted>> <<unmount>> ${OFF}`;
      expect([env, modes("mount", env)]).toEqual([env, expected]);
    }
  });
});
