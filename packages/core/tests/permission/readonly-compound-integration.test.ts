/**
 * PR-2（B3、B8）的权限矩阵：真实 `PermissionChecker` + `BashTool.prototype.checkPermissions`
 *
 * 与 `readonly-compound.test.ts` 的分工：那个测判定函数本身（纯逻辑，快）；
 * 这个测**接入**——Step 5.6 真的被走到、规则与模式硬约束仍然优先。
 * 写法照 `git-readonly-boundary.test.ts`（原型调用，不起登录 shell）。
 *
 * 用例来源：
 * - §6.1 的 PR-2 表格逐行；
 * - 「本会话 22 条原文」里的 21 条（`extract_prompts.py` 的截断版——取证会话的
 *   `raw.jsonl` 已被清理，完整原文取不到；截断只影响末尾，不影响命令形态）。
 *   路径统一替换成 `<ws>` 占位符，运行时展开成夹具目录，避免把本机绝对路径提交进仓库。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

let configRoot: string;
let root: string;
/** 本仓根（夹具） */
let ws: string;
/** ws 内的普通子目录（不属于任何仓库，但工作区内） */
let plainDir: string;
/** ws 内的嵌套独立仓库 */
let nestedRepo: string;
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
  git(["commit", "-q", "--allow-empty", "-m", "init"], dir);
}

const FIXTURE_TIMEOUT = 60_000;

beforeAll(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "sid-pr2i-cfg-"));
  process.env.SID_CONFIG_DIR = configRoot;

  root = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr2i-")));
  ws = join(root, "repo");
  initRepo(ws);
  plainDir = join(ws, "docs");
  mkdirSync(plainDir, { recursive: true });
  nestedRepo = join(ws, "vendor", "evil");
  initRepo(nestedRepo);
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

type Mode = "default" | "acceptEdits";

/** 判定一条命令在指定模式下的权限结果 */
async function judge(
  cmd: string,
  opts: {
    cwd?: string;
    mode?: Mode;
    allowRules?: string[];
    askRules?: string[];
    denyRules?: string[];
  } = {},
) {
  const cfg = defaultConfig();
  // 规则走构造器的第二个参数（PermissionRule，规则串是 `Bash(...)` 形式）；
  // 塞进 config 对象是无效的——那个字段 checker 不读（第一版就踩了这个坑）。
  const checker = new PermissionChecker(
    {
      ...cfg,
      permissionMode: opts.mode ?? "default",
      print: true,
      allowedTools: ["Read", "Grep", "Glob"],
      allowedDirectories: [ws],
    } as never,
    {
      allow: opts.allowRules ?? [],
      ask: opts.askRules ?? [],
      deny: opts.denyRules ?? [],
    },
    ws,
  );
  return checker.check(
    { toolName: "bash", input: { command: cmd, cwd: opts.cwd ?? ws } } as never,
    bashTool as never,
  );
}

/** 把夹具占位符展开成真实路径 */
function c(cmd: string): string {
  return cmd.replaceAll("<ws>", ws);
}

describe("变放行：工作区内 cd + 只读主体（default 与 acceptEdits 各一遍）", () => {
  const cases = [
    "cd <ws> && git log -5",
    "cd <ws>/packages && ls", // 目录不存在不影响判定，只判权限
    "cd <ws>; grep -rn foo . 2>/dev/null",
    "cd <ws> && cd <ws>/docs && ls",
    "cd <ws>/docs && git log -1",
    "cd <ws> && ls -la",
    "cd <ws> && cat README.md",
    "cd <ws> && git status --short",
    // B8
    "git worktree list",
    "git grep -n foo",
  ];

  for (const mode of ["default", "acceptEdits"] as Mode[]) {
    for (const raw of cases) {
      test(`[${mode}] ALLOW: ${raw}`, async () => {
        expect((await judge(c(raw), { mode })).allowed).toBe(true);
      });
    }
  }
});

describe("必须仍拦（§6.1 表格逐行）", () => {
  const mustAsk = [
    // cd 目标越界 / 非字面量
    "cd /tmp && ls",
    "cd ~ && ls",
    "cd - && ls",
    "cd $HOME && ls",
    "cd && ls",
    // 主体不是只读
    "cd <ws> && rm x",
    "cd <ws> && ls > out.txt",
    "cd <ws> && cat < rel.txt",
    // 不支持的分隔符与子 shell
    "cd <ws> || ls",
    "cd <ws> & ls",
    "(cd <ws> && ls)",
    "pushd <ws> && ls",
    // 异仓 / 裸仓库形态 / 剥不掉的 -c
    "cd <ws>/vendor/evil && git status",
    "cd <ws> && git -c core.pager=x log",
    // B8 的拦截侧
    "git grep -O vim foo",
    "git worktree prune",
    "git ls-remote origin",
  ];

  for (const raw of mustAsk) {
    test(`ASK: ${raw}`, async () => {
      expect((await judge(c(raw))).allowed).toBe(false);
    });
  }

  test("ASK: cwd=嵌套异仓时 `cd <ws>; git status`（cd 失败会在异仓继续跑）", async () => {
    // `;` 连接：cd 成功才在 ws，失败则留在 nestedRepo；两个 cwd 都要是本仓才能放行
    expect((await judge(c("cd <ws>; git status"), { cwd: nestedRepo })).allowed).toBe(false);
  });

  test("ASK: `cd <ws> && for p in 1 2; do git log; done`（B10 不放宽循环）", async () => {
    expect((await judge(c("cd <ws> && for p in 1 2; do git log; done"))).allowed).toBe(false);
  });
});

describe("规则与模式优先", () => {
  test("ask 规则命中时不因只读放行：`Bash(git log *)` + `cd <ws> && git log -1`", async () => {
    const d = await judge(c("cd <ws> && git log -1"), { askRules: ["Bash(git log *)"] });
    expect(d.allowed).toBe(false);
  });

  test("deny 规则照旧拦截", async () => {
    const d = await judge(c("cd <ws> && git log -1"), { denyRules: ["Bash(git log *)"] });
    expect(d.allowed).toBe(false);
  });

  test("deny-write 模式下 cd 复合只读也被拒（模式硬约束不越过）", async () => {
    const d = await judge(c("cd <ws> && git log -1"), { mode: "deny-write" as never });
    expect(d.allowed).toBe(false);
  });

  test("守卫：isReadOnlyCommand 的纯函数口径不变", () => {
    // 补回只发生在权限层 Step 5.6，工具层与另外 4 个消费者看到的仍是严格口径
    expect(isReadOnlyCommand("cd x && ls")).toBe(false);
    expect(isReadOnlyCommand(`cd ${ws} && ls`)).toBe(false);
  });
});

describe("本会话 21 条原文：工作区内 cd + 只读主体全部 ALLOW", () => {
  // 取证会话 20261114-053106-7a748063 的 59 条 bash 确认里，按附录 A.2/A.3 分到
  // 「工作区内 cd + 只读主体」的 21 条（该会话 raw.jsonl 已被清理，只能用
  // PreToolUse 的截断版；截断只影响末尾，不影响命令形态）。
  // 路径统一替换成 <ws>，避免把本机绝对路径提交进仓库；命令不执行，只判权限。
  const sessionCommands = [
    "cd <ws> && git log --oneline -40",
    'cd <ws> && ls .agents/notes/implemented/bug-fix/ | tail -25 && echo "--- rejected ---" && ls .agents/notes/rejected/*/ 2>/dev/null | tail -30',
    'cd <ws> && git log --oneline --all --grep="前台 sleep" -15 && echo "--- 736 ---" && git log --oneline --all --grep="#736" -5',
    'cd <ws> && ls tests/smoke/cases/ && echo "--- git status ---" && git status --short | head -20',
    'cd <ws> && grep -c "" packages/core/tests/config/scheduling-waiting-no-contradiction.test.ts && grep -n "describe\\|it(" packages/core/tests/config/scheduling-waiting',
    'cd <ws> && sed -n \'596,640p\' packages/core/src/tool/bash.ts | grep -n "ForegroundSleep\\|withForegroundSleepNotice" ; echo "--- 调用点 ---"; grep -rn "withForegroundSlee',
    'cd <ws> && grep -n "^export \\(async \\)\\?function\\|^export const\\|^export interface" scripts/verify-monitor.ts | head -40',
    "cd <ws> && sed -n '1,80p' /tmp/sid-poll-probe/sim.ts; echo \"=== replay-n8 ===\"; cat /tmp/sid-poll-probe/replay-n8.ts",
    "cd <ws> && sed -n '520,620p' scripts/verify-monitor.ts",
    'cd <ws> && grep -n "task-notification\\|不会再自动回报" packages/core/tests/task/background-await.test.ts 2>/dev/null | head -10; echo "=== N4 note 判据 ==="; sed -n \'1,60p\' .',
    'cd <ws> && grep -rn "UnchangedObservationRun\\|StuckGuard\\|StallGuard\\|stopReason.*stuck\\|terminate" packages/core/src/query/*.ts | grep -o \'"\\(UnchangedObservationRu',
    'cd <ws> && grep -rn "UnchangedObservationRun" packages/core/src packages/core/tests | head -8; echo "=== stuck/stall 事件 ==="; grep -rn "StuckGuard\\|StuckEscalation\\|',
    "cd <ws> && sed -n '1039,1060p' packages/core/src/query/loop.ts; echo \"=== UnchangedObservationRun 事件写入点 ===\"; grep -rn '\"UnchangedObservationRun\"' packages/ | head -",
    "cd <ws> && sed -n '1060,1085p' packages/core/src/query/loop.ts; echo \"=== UnchangedObservationRun data ===\"; sed -n '6440,6470p' packages/core/src/query/loop.ts",
    "cd <ws> && sed -n '7451,7475p' packages/core/src/query/loop.ts",
    "cd <ws> && awk 'NR>=1050 && NR<=1066' packages/core/src/query/loop.ts; echo \"=== 止损相关事件名（全仓）===\"; grep -rhoE 'event: \"(Stuck[A-Za-z]*|Stall[A-Za-z]*|RepeatedReadonly",
    'cd <ws> && grep -rn "registerWait(" packages/core/src --include=*.ts | grep -v "wait-registry.ts" | head -12; echo "=== registerWait 签名 ==="; grep -n "export functio',
    'cd <ws> && echo "=== 调度段与等待段去矛盾 note 尾部 ==="; tail -25 .agents/notes/implemented/bug-fix/2026-11-10-调度段与等待段去矛盾.md; echo; echo "=== 唤醒排完要结束本轮 note 尾部 ==="; tail -20 .',
    'cd <ws> && grep -n "argv\\|--case\\|--binary\\|--runs\\|DEFAULT_BINARY\\|resolveBinary" scripts/verify-monitor.ts | head -20',
    "cd <ws> && sed -n '1,54p' scripts/verify-monitor.ts",
    'cd <ws> && git status --short | head -20; echo "---"; git branch --show-current',
  ];

  for (const [i, raw] of sessionCommands.entries()) {
    test(`#${i + 1} ALLOW: ${raw.slice(0, 60)}`, async () => {
      const d = await judge(c(raw));
      expect(d.allowed, raw).toBe(true);
    });
  }
});
