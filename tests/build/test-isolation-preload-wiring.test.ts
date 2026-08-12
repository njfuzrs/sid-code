/**
 * 隔离兜底接线门禁 —— P1-2 测试迁进各 package 后新增的防线。
 *
 * ## 治的是什么
 *
 * `tests/preload-isolate-sid-home.ts` 是**进程级兜底**：很多落盘组件在调用链深处
 * 被无参构造（`PermissionChecker` 里 `new AuditLogger()`，`permission/checker.ts:360`），
 * 测试作者看不见它，所以隔离必须是默认值而不是"记得写"。
 *
 * P1-2 把 650 个测试从根 `tests/` 迁进 `packages/<pkg>/tests/` 之后，这道兜底出现
 * 一个新的失效面：根 `bunfig.toml` 的 `preload` 只在**以仓库根为 cwd** 跑 bun test 时生效。
 * 一旦有人 `cd packages/core && bun test`，读不到根 bunfig → 兜底消失 → 直接写用户真实
 * `~/.sid-code/`。这正是 2026-08-03 那次「单测把 6 万行假数据灌进 cache-breaks.jsonl
 * 且全绿」事故的复发条件。
 *
 * 修法是给每个含 tests/ 的包放一份 `bunfig.toml` 指回根的预载文件。本门禁断言那份
 * 接线**始终存在且指对**——新增一个包、或有人清理"看起来重复"的 bunfig 时会红。
 *
 * ## 为什么不能只靠"跑一次测试看绿"
 *
 * `CLAUDE.md` 记着这句：污染时测试也全绿。缺了 preload 的唯一症状是数据静静写进用户
 * 家目录，没有任何断言会失败。所以必须用静态接线检查把它钉死。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PRELOAD_FILE = join(REPO_ROOT, "tests", "preload-isolate-sid-home.ts");

/** 收集所有含 tests/ 目录的 package（即需要自带 bunfig 的包）。 */
function packagesWithTests(): string[] {
  const packagesRoot = join(REPO_ROOT, "packages");
  return readdirSync(packagesRoot)
    .filter((name) => {
      const testsDir = join(packagesRoot, name, "tests");
      return existsSync(testsDir) && statSync(testsDir).isDirectory();
    })
    .sort();
}

/** 从一份 bunfig.toml 里抠出 [test] 段的 preload 路径（够用的极简解析）。 */
function parsePreload(tomlPath: string): string[] {
  const text = readFileSync(tomlPath, "utf-8");
  // preload = ["a", "b"] 或 preload = "a"
  const m = /^\s*preload\s*=\s*(.+)$/m.exec(text);
  if (!m) return [];
  const raw = m[1]!.trim();
  return [...raw.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
}

describe("隔离兜底接线（P1-2 测试分包后的防复发门禁）", () => {
  test("预载文件本身存在——它是所有接线指向的目标", () => {
    expect(existsSync(PRELOAD_FILE)).toBe(true);
  });

  test("仓库根 bunfig.toml 配了 preload（根 cwd 跑全量测试的路径）", () => {
    const rootBunfig = join(REPO_ROOT, "bunfig.toml");
    expect(existsSync(rootBunfig)).toBe(true);
    const preloads = parsePreload(rootBunfig).map((p) => resolve(REPO_ROOT, p));
    expect(preloads).toContain(PRELOAD_FILE);
  });

  test("扫描面非空——包目录改名/结构变动导致空扫时本门禁不得静默通过", () => {
    // 迁移后至少 core / cli / shared / tui-renderer 四个包有 tests/
    expect(packagesWithTests().length).toBeGreaterThanOrEqual(4);
  });

  test("每个含 tests/ 的 package 都有 bunfig.toml 且 preload 指向根预载文件", () => {
    const missing: string[] = [];
    const misconfigured: Array<{ pkg: string; preloads: string[] }> = [];

    for (const pkg of packagesWithTests()) {
      const bunfig = join(REPO_ROOT, "packages", pkg, "bunfig.toml");
      if (!existsSync(bunfig)) {
        missing.push(pkg);
        continue;
      }
      // 相对路径按该 bunfig 所在目录解析（bun 的语义）
      const pkgDir = join(REPO_ROOT, "packages", pkg);
      const preloads = parsePreload(bunfig).map((p) => resolve(pkgDir, p));
      if (!preloads.includes(PRELOAD_FILE)) {
        misconfigured.push({ pkg, preloads: preloads.map((p) => relative(REPO_ROOT, p)) });
      }
    }

    expect(
      missing,
      `以下 package 有 tests/ 但缺 bunfig.toml —— 在包内跑 \`bun test\` 时读不到根 bunfig，\n` +
        `隔离兜底失效，测试会写用户真实 ~/.sid-code/（且全绿，不会有任何断言失败）。\n` +
        `修法：在包根建 bunfig.toml，内容为\n` +
        `  [test]\n  preload = ["../../tests/preload-isolate-sid-home.ts"]\n` +
        `缺失的包：${missing.join(", ")}`,
    ).toEqual([]);

    expect(
      misconfigured,
      `以下 package 的 bunfig.toml 存在但 preload 没指向 tests/preload-isolate-sid-home.ts`,
    ).toEqual([]);
  });
});
