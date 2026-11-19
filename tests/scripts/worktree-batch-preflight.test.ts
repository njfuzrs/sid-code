/**
 * worktree 批量编排前置检查（scripts/worktree-batch-preflight.ts，B1）。
 *
 * 这个闸门唯一的失效形态是「本该死的东西全绿」——2026-11-19 实测 4 个并行 agent 里 3 个
 * 因为缺 `node_modules/@sid-code/tui` 无法提交，而当时没有任何检查提前发现。所以要测：
 *   ① 缺链接真的判缺（不是数不到依赖就当通过）；
 *   ② 悬空 symlink 判缺（lstat 看得见、模块解析失败的正是这一类）；
 *   ③ worktree 模式两个探测位置（包内 / 根）任一可解析即通过；
 *   ④ 空集不能冒充通过（packages/ 不存在时不能报「0 个依赖全通过」）。
 *
 * 全部用 tmpdir 造目录，**不跑真实 install**、不碰 ~/.sid-code/。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { preflight, scanWorkspaceDeps } from "../../scripts/worktree-batch-preflight.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/worktree-batch-preflight.ts");

/** 在 dir 里写一个包；links 是相对该包 node_modules 的依赖名→目标 */
function writePkg(
  root: string,
  name: string,
  deps: Record<string, string>,
  linkInto?: { base: string; map: Record<string, string> },
) {
  const dir = join(root, "packages", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `@x/${name}`, dependencies: deps }),
  );
  if (!linkInto) return;
  mkdirSync(linkInto.base, { recursive: true });
  for (const [dep, target] of Object.entries(linkInto.map)) {
    const link = join(linkInto.base, dep);
    symlinkSync(target, link);
  }
}

/** 造一个最小仓库：packages/a、packages/b（b 依赖 @x/a: workspace:*），目标目录指向 packages/a */
function makeRepo(): { root: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), "wf-preflight-"));
  writePkg(root, "a", {});
  writePkg(root, "b", { "@x/a": "workspace:*" });
  return { root, target: join(root, "packages", "a") };
}

const linkDep = (root: string, scopeDir: string, dep: string, target: string) => {
  // dep 可能是 `@scope/name`：链接本身的父目录（@scope）也要建
  mkdirSync(dirname(join(scopeDir, dep)), { recursive: true });
  symlinkSync(target, join(scopeDir, dep));
};

describe("scanWorkspaceDeps", () => {
  test("只收 workspace: 前缀的依赖，并记住声明它的包", () => {
    const { root } = makeRepo();
    try {
      writePkg(root, "c", { lodash: "^4.0.0", "@x/a": "workspace:*" });
      const scan = scanWorkspaceDeps(root);
      expect(scan.hasPackagesDir).toBe(true);
      expect(scan.deps).toEqual([
        { dep: "@x/a", declaredBy: "b" },
        { dep: "@x/a", declaredBy: "c" },
      ]);
      expect(scan.deps.some((d) => d.dep === "lodash")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("packages/ 不存在 → hasPackagesDir=false，deps 为空（不能当成全通过）", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-preflight-empty-"));
    try {
      const scan = scanWorkspaceDeps(root);
      expect(scan.hasPackagesDir).toBe(false);
      expect(scan.deps).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("跳过 packages/node_modules 下的 package.json", () => {
    const { root } = makeRepo();
    try {
      writePkg(root, "node_modules", { "@x/ghost": "workspace:*" });
      expect(scanWorkspaceDeps(root).deps.some((d) => d.dep === "@x/ghost")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("preflight 主仓模式", () => {
  test("只建 node_modules/@x/a 以外的位置 → 缺 1 项，带依赖名与修复命令", () => {
    const { root, target } = makeRepo();
    try {
      // 复刻实测现场：链接只长在包内（packages/a/node_modules），根上一条都没有
      linkDep(root, join(root, "packages", "a", "node_modules"), "@x/a", target);
      const r = preflight(root);
      expect(r.ok).toBe(false);
      expect(r.missing.map((m) => m.dep)).toEqual(["@x/a"]);
      expect(r.messages[0]).toBe("✗ worktree 批量编排前置检查未通过（1 项）：");
      expect(r.messages.join("\n")).toContain(
        "缺 @x/a —— pre-commit 的 docs:gen-reference --check 会失败",
      );
      expect(r.messages.join("\n")).toContain(
        `ln -sfn ../../packages/a ${join(root, "node_modules", "@x/a")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("全部链接就位 → ok === true，报依赖数", () => {
    const { root, target } = makeRepo();
    try {
      linkDep(root, join(root, "node_modules"), "@x/a", target);
      const r = preflight(root);
      expect(r.ok).toBe(true);
      expect(r.missing).toEqual([]);
      expect(r.checked).toBe(1);
      expect(r.messages).toEqual(["✓ 前置检查通过：1 个 workspace 依赖均可解析"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("悬空 symlink（指向不存在目录）→ 判缺失", () => {
    const { root } = makeRepo();
    try {
      // 关键：lstat 看得见这条链接，只有 existsSync（跟随 symlink）才判缺。
      // 改成 lstat 且不加 isDirectory 校验时这条会变绿 —— 而 docs:gen-reference 照样崩。
      linkDep(root, join(root, "node_modules"), "@x/a", join(root, "packages", "does-not-exist"));
      const r = preflight(root);
      expect(r.ok).toBe(false);
      expect(r.missing.map((m) => m.dep)).toEqual(["@x/a"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("包内 node_modules 有链接但根没有 → 主仓模式仍判缺（主仓只认根）+ 逐包给出正确修复命令", () => {
    const { root } = makeRepo();
    try {
      writePkg(root, "c", { "@x/a": "workspace:*" });
      mkdirSync(join(root, "packages", "c", "node_modules", "@x"), { recursive: true });
      symlinkSync(join(root, "packages", "a"), join(root, "packages", "c", "node_modules", "@x/a"));
      const r = preflight(root);
      expect(r.ok).toBe(false);
      // b 与 c 各声明一次，两条都要报（声明位置不同，修的是同一条根链接但来源要人知道）
      expect(r.missing.map((m) => m.declaredBy).sort()).toEqual(["b", "c"]);
      expect(r.messages.filter((l) => l.trim().startsWith("ln -sfn"))).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("packages/ 不存在 → 不通过（空集不能冒充通过）", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-preflight-bad-"));
    try {
      const r = preflight(root);
      expect(r.ok).toBe(false);
      expect(r.messages[0]).toContain("packages");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("preflight --worktree 模式", () => {
  /** 造主仓 + 一个独立的 worktree 目录（worktree 模式只读目录结构，不需要是真 git worktree） */
  function setup(): { root: string; wt: string; target: string } {
    const { root } = makeRepo();
    const wt = join(root, ".sid-code", "worktrees", "wf_a");
    mkdirSync(wt, { recursive: true });
    writePkg(wt, "a", {});
    writePkg(wt, "b", { "@x/a": "workspace:*" });
    return { root, wt, target: join(wt, "packages", "a") };
  }

  test("包内 node_modules 可解析 → ok", () => {
    const { root, wt, target } = setup();
    try {
      mkdirSync(join(wt, "node_modules"), { recursive: true });
      linkDep(wt, join(wt, "packages", "b", "node_modules"), "@x/a", target);
      const r = preflight(root, { worktree: ".sid-code/worktrees/wf_a" });
      expect(r.ok).toBe(true);
      expect(r.checked).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree 根 node_modules 可解析 → ok（相对路径入参）", () => {
    const { root, wt, target } = setup();
    try {
      linkDep(wt, join(wt, "node_modules"), "@x/a", target);
      const r = preflight(root, { worktree: ".sid-code/worktrees/wf_a" });
      expect(r.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("两处都缺 → 报缺，修复命令是 cd <wt> && bun install", () => {
    const { root, wt } = setup();
    try {
      mkdirSync(join(wt, "node_modules"), { recursive: true });
      const r = preflight(root, { worktree: wt });
      expect(r.ok).toBe(false);
      expect(r.missing.map((m) => m.dep)).toEqual(["@x/a"]);
      expect(r.messages.join("\n")).toContain(`cd ${wt} && bun install`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree 根 node_modules 整体不存在 → 只报一条，不逐包刷屏", () => {
    const { root, wt } = setup();
    try {
      writePkg(wt, "core", { "@sid-code/shared": "workspace:*" });
      writePkg(wt, "shared", {});
      const r = preflight(root, { worktree: wt });
      expect(r.ok).toBe(false);
      expect(r.noNodeModules).toBe(true);
      expect(r.missing).toEqual([]);
      const lines = r.messages.filter((l) => l.includes("worktree 未安装依赖"));
      expect(lines).toHaveLength(1);
      expect(r.messages.join("\n")).not.toContain("缺 @x/a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("悬空 symlink 在 worktree 模式同样判缺", () => {
    const { root, wt } = setup();
    try {
      linkDep(wt, join(wt, "node_modules"), "@x/a", join(wt, "packages", "nope"));
      expect(preflight(root, { worktree: wt }).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("脚本端到端：参数与退出码", () => {
  const run = (cwd: string, args: string[]) => {
    const r = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("--help 退 0 并打印判据与退出码", () => {
    const r = run(process.cwd(), ["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "退出码：0 = 通过；1 = 有依赖解析不了（逐项打印并给修复命令）；2 = 参数错误",
    );
  });

  test("未知参数 → 退 2", () => {
    const r = run(process.cwd(), ["--nope"]);
    expect(r.code).toBe(2);
  });

  test("缺依赖时退 1，通过时退 0（默认模式走 git rev-parse 取根）", () => {
    const { root } = makeRepo();
    try {
      const sh = (args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      sh(["init", "-q"]);
      const before = run(join(root, "packages", "b"), []);
      expect(before.code).toBe(1);
      expect(before.out).toContain("✗ worktree 批量编排前置检查未通过");

      linkDep(root, join(root, "node_modules"), "@x/a", join(root, "packages", "a"));
      const after = run(join(root, "packages", "b"), []);
      expect(after.code).toBe(0);
      expect(after.out).toContain("✓ 前置检查通过：1 个 workspace 依赖均可解析");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
