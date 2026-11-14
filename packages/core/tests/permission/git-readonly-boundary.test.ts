/**
 * PR-1：只读 git 的「执行边界」（B1 / B2 / B4）
 *
 * 三件事各一组用例：
 * - **B1** 前导变量赋值只按白名单放行（`GIT_EXTERNAL_DIFF=… git diff` 曾零确认执行任意程序）；
 * - **B2** `-C` / `--git-dir` / `--work-tree` / `--bare` 不再被当成「安全全局选项」剥掉，
 *   只把 `git -C <本仓内目录>` 在权限层补回；
 * - **B4** 只读 git 必须作用在**本仓**（裸仓库形态、嵌套异仓、工作区外仓库一律确认）。
 *
 * 口径与 §6.1 的 PR-1 表格一致：default 模式 + `print: true`（无头，ask 落成拒绝），
 * 用真实 `PermissionChecker` + `BashTool.prototype.checkPermissions`（原型调用，不起登录 shell），
 * 写法照 `allow-list-pipeline-filter.test.ts`。落盘全部重定向到 tmpdir（CONTRIBUTING 测试约定）。
 *
 * ⚠️ 用例的**命令文本**一律写成 `cmd: () => string`：夹具路径来自 `beforeAll` 的 tmpdir，
 * 而 `describe` 回调、`for` 循环都在 beforeAll 之前执行，直接写成数组字面量会拿到 `undefined`
 * （实测踩过）。
 *
 * 「必须不变」那一半是护栏：这些命令修前的结果只是碰巧对，没有专门的检查在守它们。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

let configRoot: string;
let root: string;
/** 本仓根 */
let ws: string;
/** ws 内的嵌套独立仓库（第三方仓库 / 模型自己 clone 的） */
let nestedRepo: string;
/** ws 内的裸仓库形态目录：HEAD + objects/ + refs/，没有 .git */
let bareShape: string;
/** 本仓的 linked worktree，刻意建在 ws 之外 */
let worktree: string;
/** ws 之外完全无关的仓库 */
let otherRepo: string;
/** ws 内、但不属于任何仓库的普通目录 */
let prevConfigDir: string | undefined;

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...args], {
    cwd,
    stdio: "pipe",
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  // 空提交就够造出「有 HEAD、有 refs 的真实仓库」，省掉写文件 + add 两次 spawn
  git(["commit", "-q", "--allow-empty", "-m", "init"], dir);
}

// 夹具要 spawn 十几次 git，在慢机器上会超过 bun 默认的 5s hook 超时
const FIXTURE_TIMEOUT = 60_000;

beforeAll(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "sid-pr1-cfg-"));
  process.env.SID_CONFIG_DIR = configRoot;

  root = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr1-")));
  ws = join(root, "repo");
  initRepo(ws);
  nestedRepo = join(ws, "vendor", "evil");
  initRepo(nestedRepo);
  bareShape = join(ws, "vendor", "bare-shape");
  mkdirSync(join(bareShape, "objects"), { recursive: true });
  mkdirSync(join(bareShape, "refs"), { recursive: true });
  writeFileSync(join(bareShape, "HEAD"), "ref: refs/heads/main\n");
  worktree = join(root, "wt"); // 本仓的 linked worktree，落在 ws 外
  git(["worktree", "add", "-q", worktree, "-b", "wtb"], ws);
  otherRepo = join(root, "other");
  initRepo(otherRepo);
}, FIXTURE_TIMEOUT);

afterAll(async () => {
  // 落盘走 import().then() 的场景先让微任务跑干再恢复 env（CONTRIBUTING 测试约定）
  await new Promise((r) => setTimeout(r, 0));
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}, FIXTURE_TIMEOUT);

const bashTool = {
  name: "bash",
  checkPermissions: (i: unknown, c: unknown) =>
    (BashTool.prototype.checkPermissions as (i: unknown, c: unknown) => unknown).call({}, i, c),
};

/** 判定一条命令在 default 模式下的权限结果 */
async function judge(cmd: string, cwd: string = ws) {
  const checker = new PermissionChecker(
    {
      ...defaultConfig(),
      permissionMode: "default",
      print: true,
      allowedTools: ["Read", "Grep", "Glob"],
      allowedDirectories: [ws],
    } as never,
    undefined,
    ws,
  );
  return checker.check(
    { toolName: "bash", input: { command: cmd, cwd } } as never,
    bashTool as never,
  );
}

interface VerdictCase {
  /** test 名里用的稳定标签（不嵌路径，避免 beforeAll 之前求值） */
  label: string;
  /** 命令文本，**必须在 test 回调内求值** */
  cmd: () => string;
  /** 期望的权限结果 */
  allowed: boolean;
}

function runCases(cases: VerdictCase[]): void {
  for (const c of cases) {
    test(`${c.allowed ? "ALLOW" : "ASK"}: ${c.label}`, async () => {
      expect((await judge(c.cmd())).allowed).toBe(c.allowed);
    });
  }
}

describe("B1：前导环境变量只按白名单放行", () => {
  runCases([
    // §6.1 组1：修前全部 ALLOW（step=5.5），修后 ASK
    {
      label: "GIT_EXTERNAL_DIFF git diff",
      cmd: () => "GIT_EXTERNAL_DIFF=/tmp/x git diff",
      allowed: false,
    },
    {
      label: "GIT_CONFIG_COUNT git status",
      cmd: () =>
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=x git status",
      allowed: false,
    },
    {
      label: "GIT_CONFIG_PARAMETERS git status",
      cmd: () => `GIT_CONFIG_PARAMETERS="'core.fsmonitor=x'" git status`,
      allowed: false,
    },
    // 修前就 ASK（实测 2026-11-14）：`env` 剥离后程序位是 `GIT_…=…`，本来就不在只读表
    {
      label: "env GIT_EXTERNAL_DIFF",
      cmd: () => "env GIT_EXTERNAL_DIFF=/tmp/x git diff",
      allowed: false,
    },
    {
      label: "export GIT_EXTERNAL_DIFF",
      cmd: () => "export GIT_EXTERNAL_DIFF=/tmp/x; git diff",
      allowed: false,
    },
    // `GIT_DIR` 同时属于 B1 与 B2
    {
      label: "GIT_DIR=<异仓> git status",
      cmd: () => `GIT_DIR=${otherRepo}/.git git status`,
      allowed: false,
    },
    // 白名单外的一律不放行：PAGER / EDITOR / HOME 这类能改变程序行为
    { label: "GIT_PAGER git log", cmd: () => "GIT_PAGER=/tmp/x git log -1", allowed: false },
    {
      label: "EDITOR git commit",
      cmd: () => "EDITOR=/tmp/x git commit --amend -m x",
      allowed: false,
    },
    { label: "HOME git log", cmd: () => "HOME=/tmp/x git log -1", allowed: false },
    // `PATH` 本来就被 Step 2 的危险变量检测拦下，这里保证「不因为是前导赋值而放松」
    { label: "PATH 前导赋值", cmd: () => "PATH=/tmp:$PATH ls", allowed: false },

    // §6.1 组6：白名单内的变量保持放行
    { label: "LANG git log", cmd: () => "LANG=C git log -1", allowed: true },
    { label: "NO_COLOR ls", cmd: () => "NO_COLOR=1 ls", allowed: true },
    { label: "LC_ALL ls", cmd: () => "LC_ALL=C ls", allowed: true },
    { label: "LC_CTYPE ls", cmd: () => "LC_CTYPE=en_US.UTF-8 ls", allowed: true },
    { label: "RUST_LOG rg", cmd: () => "RUST_LOG=debug rg x", allowed: true },
    { label: "TERM git diff", cmd: () => "TERM=dumb git --no-pager diff", allowed: true },
  ]);

  test("独立赋值（不导出）不影响只读：`B=origin/x; git show $B:README.md`", async () => {
    // §6.1 组7 的原文用换行分隔，而换行在 Step 2 就被 [injection:newlines] 拦成确认
    // （修前修后一致，与 B1 无关）。这里用分号验证 B1 真正要守的语义：
    // 不带 export 的独立赋值只设 shell 变量，不进子进程环境。
    expect((await judge("B=origin/x; git show $B:README.md")).allowed).toBe(true);
  });

  test("独立赋值里的 GIT_* 判非只读（变量可能早就被导出过）", async () => {
    expect(isReadOnlyCommand(`GIT_DIR=${otherRepo}/.git; git status`)).toBe(false);
    expect((await judge(`GIT_DIR=${otherRepo}/.git; git status`)).allowed).toBe(false);
  });

  test("独立赋值里的普通变量名仍按只读处理（不误伤 `B=origin/x`）", () => {
    expect(isReadOnlyCommand("B=origin/x; git show $B:README.md")).toBe(true);
  });
});

describe("B2：git 换仓库选项不再被剥离", () => {
  runCases([
    // §6.1 组2：修前全部 ALLOW
    { label: "git -C <异仓> status", cmd: () => `git -C ${otherRepo} status`, allowed: false },
    {
      label: "git --git-dir=<异仓> log",
      cmd: () => `git --git-dir=${otherRepo}/.git log`,
      allowed: false,
    },
    {
      label: "git --work-tree=<异仓> status",
      cmd: () => `git --work-tree=${otherRepo} status`,
      allowed: false,
    },
    { label: "git --bare log", cmd: () => "git --bare log", allowed: false },
    // 嵌套异仓：在 ws 内，但仓库不是本仓
    { label: "git -C <嵌套异仓> status", cmd: () => `git -C ${nestedRepo} status`, allowed: false },
    // 非字面量目标不算「本仓内」：`$VAR` / `~` / 相对路径逃逸都不补回
    { label: "git -C $HOME status", cmd: () => "git -C $HOME status", allowed: false },
    { label: "git -C ~/x status", cmd: () => "git -C ~/x status", allowed: false },
    { label: "git -C ../outside status", cmd: () => "git -C ../outside status", allowed: false },
    // 剥掉 -C 之后仍然不是只读的，不补回
    {
      label: "git -C <本仓> -c log",
      cmd: () => `git -C ${ws} -c core.pager=x log`,
      allowed: false,
    },
    {
      label: "git -C <本仓> --git-dir=<异仓> log",
      cmd: () => `git -C ${ws} --git-dir=${otherRepo}/.git log`,
      allowed: false,
    },

    // §6.1 组5：补回「只对本仓生效的 -C」
    { label: "git -C <本仓> status", cmd: () => `git -C ${ws} status`, allowed: true },
    {
      label: "git -C <本仓子目录> log",
      cmd: () => `git -C ${join(ws, "vendor")} log -1`,
      allowed: true,
    },
    {
      label: "git -C <本仓 worktree> status",
      cmd: () => `git -C ${worktree} status`,
      allowed: true,
    },
    { label: "git -C<本仓> 连写", cmd: () => `git -C${ws} log -1`, allowed: true },
  ]);

  test("isReadOnlyCommand 对换仓库写法判非只读（§6.1 的「另加直接断言」）", () => {
    expect(isReadOnlyCommand(`git -C ${otherRepo} status`)).toBe(false);
    expect(isReadOnlyCommand("git --bare log")).toBe(false);
    expect(isReadOnlyCommand(`git --git-dir=${otherRepo}/.git log`)).toBe(false);
    // 补回只发生在权限层，不污染纯文本层的严格口径
    expect(isReadOnlyCommand(`git -C ${ws} status`)).toBe(false);
  });
});

describe("B4：只读 git 必须作用在本仓", () => {
  test("cwd 在本仓根 / 本仓子目录 / 本仓 worktree → ALLOW（§6.1 组4）", async () => {
    expect((await judge("git status", ws)).allowed).toBe(true);
    expect((await judge("git log -5", join(ws, "vendor"))).allowed).toBe(true);
    expect((await judge("git --no-pager diff", worktree)).allowed).toBe(true);
  });

  test("cwd 在嵌套异仓 → ASK", async () => {
    expect((await judge("git status", nestedRepo)).allowed).toBe(false);
  });

  test("cwd 在裸仓库形态目录 → ASK（这条链上唯一的拦截点）", async () => {
    expect((await judge("git log -1", bareShape)).allowed).toBe(false);
  });

  test("cwd 在其它仓库 → ASK", async () => {
    expect((await judge("git status", otherRepo)).allowed).toBe(false);
  });

  test("两步绕过：先 cd 到异仓（单独一条），再裸 git → ASK", async () => {
    // 第一条命令本身无害（`cd` 单独一条，不碰文件），重点在第二条：
    // 它看起来是裸 `git status`，但 cwd 已经在异仓里。
    expect((await judge(`cd ${nestedRepo}`)).allowed).toBe(false);
    expect((await judge("git status", nestedRepo)).allowed).toBe(false);
  });

  test("`echo x | xargs git log`（cwd=异仓）→ ASK", async () => {
    // xargs 不在只读表里，本来就落确认；这条守着「别为了放行 xargs 而放开仓库归属」
    expect((await judge("echo x | xargs git log", otherRepo)).allowed).toBe(false);
  });

  test("工作区外、且不属于本仓的目录（不在任何仓库里）→ ASK", async () => {
    const nowhere = join(root, "nowhere");
    mkdirSync(nowhere, { recursive: true });
    expect((await judge("git status", nowhere)).allowed).toBe(false);
  });
});

describe("连带消费者：命令含 git 段时仍然逐段只读", () => {
  test("非 git 段不因 git 判定而被放松", async () => {
    expect((await judge("git status | tee /tmp/x")).allowed).toBe(false);
  });

  test("git 段与非 git 段混合：全部只读才放行（§6.1 组8 的 `-c` 一例）", async () => {
    expect((await judge("git -c core.pager=x log")).allowed).toBe(false);
    expect((await judge("git status | head -5")).allowed).toBe(true);
  });
});
