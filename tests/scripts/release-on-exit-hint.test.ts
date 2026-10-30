/**
 * release.sh 失败收尾提示：必须按「bump 提交 / beta 指针」的真实状态给出重跑方式。
 *
 * 起因（v0.1.613 发版实测）：bump 提交之后的上传 scp 断开，on_exit 仍打印
 * 「版本号已回滚，无需 --no-bump」—— 而 package.json 实际停在 0.1.613、bump 提交也还在。
 *   - 照提示直接重跑 → 再 bump 一次，白烧一个版本号；
 *   - 改用 --no-bump 重跑 → 被 G2 拦下（构建时 HEAD = bump 提交本身，G2 期望 v<ver>^）。
 * 两条路都走不通，唯一能通过的是撤掉本地 bump 提交与 tag 后从干净状态重跑。
 *
 * 这里不跑整条 release.sh（要 5 平台构建 + 服务器），而是把 on_exit 函数体原样切出来，
 * 注入几种状态组合执行，断言的是**它实际打印了什么**，不是源码里有没有某个字面量。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "../..");
const RELEASE_SH = readFileSync(join(REPO_ROOT, "scripts/release.sh"), "utf8");

/** 切出 `on_exit() { ... }` 整段（到行首的 `}` 为止） */
function sliceOnExit(): string {
  const m = RELEASE_SH.match(/^on_exit\(\) \{\n[\s\S]*?\n\}\n/m);
  if (!m) throw new Error("release.sh 里找不到 on_exit() 函数体 —— 函数被改名或格式变了");
  return m[0];
}

interface State {
  BUMP_APPLIED?: boolean;
  BUMP_COMMITTED?: boolean;
  BETA_PUBLISHED?: boolean;
  DO_BUMP?: boolean;
}

/** 以给定状态、退出码 1 触发 on_exit，返回它写到 stderr 的提示 */
function runOnExit(state: State): string {
  const v = (b: boolean | undefined, d: boolean) => String(b ?? d);
  const script = [
    "set -euo pipefail",
    // 外部依赖打桩：不碰 rg-embed、不跑 bun、不碰真实 git 状态
    "restore_rg_embed() { :; }",
    'info() { echo "  $*"; }',
    'warn() { echo "  ⚠️  $*" >&2; }',
    'bun() { echo "0.1.999"; }',
    "git() { return 1; }",
    "RELEASE_OK=false",
    "ROLLBACK_FILES=()",
    'BETA_NOTE_CREATED=""',
    `BUMP_APPLIED=${v(state.BUMP_APPLIED, false)}`,
    `BUMP_COMMITTED=${v(state.BUMP_COMMITTED, false)}`,
    `BETA_PUBLISHED=${v(state.BETA_PUBLISHED, false)}`,
    `DO_BUMP=${v(state.DO_BUMP, true)}`,
    "VERSION=0.1.999",
    "TAG=v0.1.999",
    'ROOT="$PWD"',
    sliceOnExit(),
    "trap on_exit EXIT",
    "exit 1",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
}

describe("release.sh on_exit：失败后的重跑提示与真实状态一致", () => {
  test("bump 未提交前失败：照旧提示直接重跑、无需 --no-bump", () => {
    const out = runOnExit({ BUMP_APPLIED: true });
    expect(out).toContain("无需 --no-bump");
    expect(out).not.toContain("git reset --keep");
  });

  test("【回归】bump 已提交后失败：不得再说「版本号已回滚」，要给出撤 bump 的命令", () => {
    const out = runOnExit({ BUMP_COMMITTED: true });
    expect(out).not.toContain("版本号已回滚");
    expect(out).not.toContain("无需 --no-bump");
    expect(out).toContain("没有**回滚");
    expect(out).toContain("git tag -d v0.1.999");
    expect(out).toContain("git reset --keep HEAD^");
    // 「重跑会复用本地 tag」与「先删 tag」互相矛盾，bump 已提交时不能同时出现
    expect(out).not.toContain("重跑本脚本会复用它");
  });

  test("beta 已上线后失败：禁止提示撤 bump（线上版本的提交不能从历史里消失）", () => {
    const out = runOnExit({ BUMP_COMMITTED: true, BETA_PUBLISHED: true });
    expect(out).toContain("已上线 beta");
    expect(out).not.toContain("git reset");
    expect(out).not.toContain("无需 --no-bump");
  });

  test("--no-bump 运行失败：提示重跑时继续带 --no-bump", () => {
    const out = runOnExit({ DO_BUMP: false });
    expect(out).toContain("仍加 --no-bump");
    expect(out).not.toContain("无需 --no-bump");
  });

  test("两个状态位在真实执行点被置位（不是只声明不赋值）", () => {
    // 置位必须分别紧跟在 bump 提交成功、beta.txt 写成功之后，否则 on_exit 永远走旧分支
    expect(RELEASE_SH).toMatch(/git commit -q -m "bump \$\{TAG\}"[\s\S]{0,600}BUMP_COMMITTED=true/);
    expect(RELEASE_SH).toMatch(/\/beta\.txt"\n\s*BETA_PUBLISHED=true/);
  });
});
