/**
 * frontmatter `paths:` 作用域在 monorepo 子包里的回归测试（bench_fix Q4）。
 *
 * 修复前的错误行为：被访问文件只换算成「相对项目根」的路径再做锚定 glob 匹配，
 * 规则文件所在目录完全不参与。于是 `packages/cli/src/ui/CLAUDE.md` 的
 * `paths: ["src/ui/**"]`（分包前写的、相对本包的写法）永远是 scope_skipped，
 * 本地 668 次 ui 访问 0 次注入。子包 `.claude/rules/*.md` 同款，主加载路径同款。
 *
 * 修复后的语义：glob 基准沿「规则所在目录 → 项目根」逐级尝试，任一级命中即命中。
 * 根相对写法（M3 / S1 / E1）必须继续成立 —— 只改成「相对所在目录」会把它们弄坏。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import { setCwd, getCwd } from "@sid-code/core/bootstrap/state.ts";
import { JitContextManager } from "@sid-code/core/config/jit-context.ts";
import {
  loadAllCLAUDEmd,
  resetLargeMemoryFiles,
  ruleOwnerDir,
  rulesPathsMatchFromOwner,
} from "@sid-code/core/config/rules.ts";

let base: string;
let root: string;
let originalCwd: string;
let originalStateCwd: string;
let originalSidConfigDir: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalStateCwd = getCwd();
  originalSidConfigDir = process.env.SID_CONFIG_DIR;
  // realpath：macOS tmpdir 在 /var → /private/var symlink 下，JIT 内部全走 realpath
  base = realpathSync(mkdtempSync(join(tmpdir(), "jit-q4-")));
  root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  process.env.SID_CONFIG_DIR = join(base, "sid-home");
  resetLargeMemoryFiles();
});

afterEach(() => {
  process.chdir(originalCwd);
  setCwd(originalStateCwd);
  if (originalSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalSidConfigDir;
  rmSync(base, { recursive: true, force: true });
  resetLargeMemoryFiles();
});

function put(rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function scoped(paths: string[], marker: string): string {
  return `---\npaths: ${JSON.stringify(paths)}\n---\n# 规则\n${marker}\n`;
}

/** monorepo 骨架：根和子包各一个 package.json，外加若干真实源文件 */
function monorepo(): void {
  put("package.json", "{}\n");
  put("packages/cli/package.json", "{}\n");
  put("packages/cli/src/ui/utils/clipboard-image.ts", "export {}\n");
  put("packages/cli/src/ui/components/Footer.tsx", "export {}\n");
}

async function jit(accessedRel: string) {
  process.chdir(root);
  setCwd(root);
  return new JitContextManager().discoverDetailed(join(root, accessedRel), root);
}

describe("JIT：paths 按规则所在目录 → 项目根逐级判定（02c 判定表）", () => {
  test("M1 子包 CLAUDE.md 写相对本包的 src/ui/** → 命中", async () => {
    monorepo();
    put("packages/cli/src/ui/CLAUDE.md", scoped(["src/ui/**"], "M1_MARKER"));
    const r = await jit("packages/cli/src/ui/utils/clipboard-image.ts");
    expect(r.scopeSkipped).toBe(0);
    expect(r.loaded.map((l) => l.relPath)).toEqual(["packages/cli/src/ui/CLAUDE.md"]);
    expect(r.loaded[0].reason).toBe("path_glob_match");
    expect(r.text).toContain("M1_MARKER");
  });

  test("M2 同一规则，访问 .tsx 组件 → 命中", async () => {
    monorepo();
    put("packages/cli/src/ui/CLAUDE.md", scoped(["src/ui/**"], "M2_MARKER"));
    const r = await jit("packages/cli/src/ui/components/Footer.tsx");
    expect(r.scopeSkipped).toBe(0);
    expect(r.loaded[0]?.reason).toBe("path_glob_match");
  });

  test("M3 根相对写法 packages/cli/src/ui/** 继续命中（不退化）", async () => {
    monorepo();
    put("packages/cli/src/ui/CLAUDE.md", scoped(["packages/cli/src/ui/**"], "M3_MARKER"));
    const r = await jit("packages/cli/src/ui/utils/clipboard-image.ts");
    expect(r.scopeSkipped).toBe(0);
    expect(r.loaded[0]?.reason).toBe("path_glob_match");
  });

  test("M4 负对照：**/*.tsx 对 .ts 文件仍不命中", async () => {
    monorepo();
    put("packages/cli/src/ui/CLAUDE.md", scoped(["**/*.tsx"], "M4_MARKER"));
    const r = await jit("packages/cli/src/ui/utils/clipboard-image.ts");
    expect(r.scopeSkipped).toBe(1);
    expect(r.loaded).toEqual([]);
    expect(r.text).toBeNull();
  });

  test("M5 子包 .claude/rules/ui.md 写 src/ui/** → 命中（CC rules 口径）", async () => {
    monorepo();
    put("packages/cli/.claude/rules/ui.md", scoped(["src/ui/**"], "M5_MARKER"));
    const r = await jit("packages/cli/src/ui/utils/clipboard-image.ts");
    expect(r.scopeSkipped).toBe(0);
    expect(r.loaded.map((l) => l.relPath)).toEqual(["packages/cli/.claude/rules/ui.md"]);
    expect(r.loaded[0].reason).toBe("path_glob_match");
  });

  test("S1 单包 src/ui/CLAUDE.md 写 src/ui/** → 命中（根口径不退化）", async () => {
    put("package.json", "{}\n");
    put("src/ui/Footer.tsx", "export {}\n");
    put("src/ui/CLAUDE.md", scoped(["src/ui/**"], "S1_MARKER"));
    const r = await jit("src/ui/Footer.tsx");
    expect(r.scopeSkipped).toBe(0);
    expect(r.loaded[0]?.reason).toBe("path_glob_match");
  });

  test("E1 evals/CLAUDE.md 写 evals/** → 命中（根口径不退化）", async () => {
    put("package.json", "{}\n");
    put("evals/bench-runner/run.ts", "export {}\n");
    put("evals/CLAUDE.md", scoped(["evals/**", "tests/eval/**"], "E1_MARKER"));
    const r = await jit("evals/bench-runner/run.ts");
    expect(r.scopeSkipped).toBe(0);
    expect(r.loaded[0]?.reason).toBe("path_glob_match");
  });

  test("不误注入：子包规则不会因中间层前缀命中包外文件", async () => {
    monorepo();
    put("packages/core/src/x.ts", "export {}\n");
    // 子包 rules 目录的规则在访问另一个包时根本不在遍历链上，这里验证的是
    // 「同一份 src/** 规则放在 packages/cli 下」不会命中 packages/core/src/x.ts
    put("packages/cli/CLAUDE.md", scoped(["src/**"], "CLI_ONLY"));
    const r = await jit("packages/core/src/x.ts");
    expect(r.text ?? "").not.toContain("CLI_ONLY");
  });
});

describe("主加载路径：cwd = 子包启动时与 JIT 判定一致", () => {
  test("子包 .claude/rules 写相对本包的 glob → 启动期注入", async () => {
    // git 仓库是必需的：没有它 getCheckoutRoot 会把 startDir（子包）当工作树根，
    // 项目根就落不到仓库根，测不到「相对项目根」与「相对子包」的分叉。
    execFileSync("git", ["init", "-q"], { cwd: root });
    put("CLAUDE.md", "# root\n");
    put("packages/cli/.claude/rules/ui.md", scoped(["src/ui/**"], "MAIN_PKG_REL"));
    put(
      "packages/cli/.claude/rules/rootrel.md",
      scoped(["packages/cli/src/ui/**"], "MAIN_ROOT_REL"),
    );
    put("packages/cli/.claude/rules/miss.md", scoped(["src/nope/**"], "MAIN_MISS"));
    const r = await loadAllCLAUDEmd(join(root, "packages/cli"), {
      activeFiles: ["packages/cli/src/ui/x.ts"],
    });
    const loaded = (r?.loadedPaths ?? [])
      .filter((p) => p.startsWith(root))
      .map((p) => p.slice(root.length + 1));
    expect(loaded).toContain("packages/cli/.claude/rules/ui.md");
    expect(loaded).toContain("packages/cli/.claude/rules/rootrel.md");
    expect(loaded).not.toContain("packages/cli/.claude/rules/miss.md");
  });
});

describe("rulesPathsMatchFromOwner / ruleOwnerDir 单元", () => {
  test("逐级：所在目录、中间层、根三级都能命中", () => {
    const owner = "/r/packages/cli/src/ui";
    const f = ["packages/cli/src/ui/a.ts"];
    expect(rulesPathsMatchFromOwner(["a.ts"], f, owner, "/r")).toBe(true); // 所在目录
    expect(rulesPathsMatchFromOwner(["src/ui/**"], f, owner, "/r")).toBe(true); // 包根
    expect(rulesPathsMatchFromOwner(["packages/**"], f, owner, "/r")).toBe(true); // 项目根
    expect(rulesPathsMatchFromOwner(["src/nope/**"], f, owner, "/r")).toBe(false);
  });

  test("ownerDir 在项目根外 → 只按根一级判定（等价原行为）", () => {
    expect(rulesPathsMatchFromOwner(["src/**"], ["src/a.ts"], "/elsewhere", "/r")).toBe(true);
    expect(rulesPathsMatchFromOwner(["a.ts"], ["src/a.ts"], "/elsewhere", "/r")).toBe(false);
  });

  test("无 paths 恒命中；有 paths 无活动文件恒不命中", () => {
    expect(rulesPathsMatchFromOwner(undefined, [], "/r/x", "/r")).toBe(true);
    expect(rulesPathsMatchFromOwner(["**"], [], "/r/x", "/r")).toBe(false);
  });

  test("ruleOwnerDir 三种形态", () => {
    expect(ruleOwnerDir("/r/pkg/CLAUDE.md")).toBe("/r/pkg");
    expect(ruleOwnerDir("/r/pkg/.claude/CLAUDE.md")).toBe("/r/pkg");
    expect(ruleOwnerDir("/r/pkg/.claude/rules/a/b.md")).toBe("/r/pkg");
    expect(ruleOwnerDir("/r/pkg/.sid-code/rules/x.md")).toBe("/r/pkg");
  });
});
