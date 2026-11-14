/**
 * PR-3（B5）的权限矩阵：真实 `PermissionChecker` + `BashTool.prototype.checkPermissions`
 *
 * 与 `readonly-read-paths.test.ts` 的分工：那个测提取器与豁免判定本身（纯逻辑，快）；
 * 这个测**接入**——Step 5.5 / 5.6 真的做了读路径校验、Step 2 的「路径遍历」真的让位、
 * 危险确认与模式硬约束仍然优先。
 *
 * 用例逐行对齐方案 §6.1 的 PR-3 表格。工作区在 tmpdir 里现造，
 * 落盘全部重定向到 tmpdir（CONTRIBUTING 测试约定）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";

let configRoot: string;
let root: string;
/** 工作区（本仓） */
let ws: string;
/** 工作区内的子目录，`cat ../README.md` 的 cwd */
let pkgDir: string;
/** 工作区外的一个目录 */
let outsideDir: string;
let prevConfigDir: string | undefined;

const FIXTURE_TIMEOUT = 60_000;

beforeAll(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "sid-pr3i-cfg-"));
  process.env.SID_CONFIG_DIR = configRoot;

  root = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr3i-")));
  ws = join(root, "repo");
  pkgDir = join(ws, "packages");
  outsideDir = join(root, "elsewhere");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(ws, "README.md"), "x");
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

async function judge(cmd: string, opts: { cwd?: string; mode?: Mode; allowRules?: string[] } = {}) {
  const cfg = defaultConfig();
  const checker = new PermissionChecker(
    {
      ...cfg,
      permissionMode: opts.mode ?? "default",
      // ⚠️ 必须留在交互模式：`print: true` 是 headless，`needsConfirmation` 会被
      // 自动转成 deny 并换掉 `decisionReason`（type 变 "other"、step 变 "headless:N"），
      // 于是「到底是 pathValidation 还是 dangerousCommand」就判不出来了（实测踩过）。
      print: false,
      allowedTools: ["Read", "Grep", "Glob"],
      allowedDirectories: [ws],
    } as never,
    { allow: opts.allowRules ?? [], ask: [], deny: [] },
    ws,
  );
  return checker.check(
    { toolName: "bash", input: { command: cmd, cwd: opts.cwd ?? ws } } as never,
    bashTool as never,
  );
}

describe("变放行：工作区内 `../` 不再报「路径遍历」", () => {
  const cases = [
    "cat ../README.md",
    "ls ../",
    "grep -rn foo ../packages",
    "cat packages/../README.md",
  ];
  for (const mode of ["default", "acceptEdits"] as Mode[]) {
    for (const cmd of cases) {
      test(`[${mode}] ALLOW: ${cmd}（cwd=<ws>/packages）`, async () => {
        const r = await judge(cmd, { cwd: pkgDir, mode });
        expect(r.allowed, JSON.stringify(r)).toBe(true);
      });
    }
  }
});

describe("变确认：工作区外的读取要问（pathValidation，不是危险样式）", () => {
  test("绝对路径在工作区外", async () => {
    const r = await judge(`cat ${join(outsideDir, "x.txt")}`);
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("pathValidation");
  });

  test("`ls /tmp` 这类系统目录", async () => {
    const r = await judge("ls /tmp");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("pathValidation");
  });

  test("cd 复合只读也按该段 cwd 判：`cd <ws> && cat <工作区外>`", async () => {
    const r = await judge(`cd ${ws} && cat ${join(outsideDir, "x.txt")}`);
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("pathValidation");
  });

  test("cd 进工作区子目录后 `../` 仍在工作区内 → 放行", async () => {
    const r = await judge(`cd ${pkgDir} && cat ../README.md`);
    expect(r.allowed).toBe(true);
  });
});

describe("必须不变：危险确认与既有口径", () => {
  test("`cat ~/.ssh/id_rsa` 仍是危险确认（不是 pathValidation）", async () => {
    const r = await judge("cat ~/.ssh/id_rsa");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
  });

  test("J3：非只读命令上的 `../` 仍报「路径遍历」危险确认", async () => {
    const r = await judge("python3 ../analyze.py", { cwd: pkgDir });
    expect(r.allowed).toBe(false);
    expect(r.decisionReason?.type).toBe("dangerousCommand");
    expect(JSON.stringify(r.decisionReason)).toContain("路径遍历");
  });

  test("工作区内的只读命令没有 `../` 时照旧放行", async () => {
    expect((await judge("ls")).allowed).toBe(true);
    expect((await judge("cat README.md")).allowed).toBe(true);
  });
});

describe("J4 豁免：sid 自己让模型去读的路径", () => {
  test("任务输出文件放行", async () => {
    const tasksDir = join(configRoot, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "abc.output"), "x");
    const r = await judge(`cat ${join(tasksDir, "abc.output")}`);
    expect(r.allowed, JSON.stringify(r)).toBe(true);
  });

  test("不豁免整个 ~/.sid-code：settings.json 仍要确认", async () => {
    writeFileSync(join(configRoot, "settings.json"), "{}");
    const r = await judge(`cat ${join(configRoot, "settings.json")}`);
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });
});

describe("会话规则：Read(<目录>/**) 让同一个目录只问一次", () => {
  test("命中会话 Read 规则的越界读放行；目录外的照旧确认", async () => {
    const target = join(outsideDir, "a.txt");
    // 未配规则 → 要确认
    expect((await judge(`cat ${target}`)).allowed).toBe(false);
    // 配了该目录的 Read 规则 → 放行
    const withRule = await judge(`cat ${target}`, { allowRules: [`Read(//${outsideDir}/**)`] });
    expect(withRule.allowed, JSON.stringify(withRule)).toBe(true);
    // 同目录以外的路径不受该规则影响
    const other = await judge("cat /etc/hosts", {
      allowRules: [`Read(//${outsideDir}/**)`],
    });
    expect(other.allowed).toBe(false);
  });
});
