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
 * 修法是给每个**能独立跑 `bun test` 的包**放一份 `bunfig.toml` 指回根的预载文件。
 * 本门禁断言那份接线**始终存在且指对**——新增一个包、或有人清理"看起来重复"的
 * bunfig 时会红。
 *
 * ## 判据为什么是「包内有 *.test.ts」而不是「包内有 tests/ 目录」（2026-08-16 修正）
 *
 * 原判据写的是 `existsSync(packages/<pkg>/tests/)`，抄的是上一段那句"给每个含 tests/
 * 的包放一份 bunfig"的**字面**。实测代价：`packages/eval-framework/` 的 4 个测试
 * 平铺在 `core/`、`sandbox/`、`graders/` 下，没有 `tests/` 目录 —— 于是整个包被门禁
 * **跳过**，且确实没有 bunfig。`cd packages/eval-framework && bun test` 读不到根
 * bunfig → 兜底消失 → 直接写用户真实 `~/.sid-code/`，而门禁一路绿灯。
 *
 * 真正要防的是"任何能独立跑 bun test 的包"，与测试文件摆在哪个子目录无关。
 * 所以判据改为**递归找 `*.test.ts`**（跳过 node_modules）。这条修正本身也是
 * 「门禁判据抄了文档措辞、而非抄了它要防的事」的一个实例。
 *
 * ## 为什么不能只靠"跑一次测试看绿"
 *
 * `CLAUDE.md` 记着这句：污染时测试也全绿。缺了 preload 的唯一症状是数据静静写进用户
 * 家目录，没有任何断言会失败。所以必须用静态接线检查把它钉死。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PRELOAD_FILE = join(REPO_ROOT, "tests", "preload-isolate-sid-home.ts");

/**
 * 包内是否存在任意 `*.test.ts`（递归，跳过 node_modules）。
 *
 * 判据刻意**不看目录名**：测试摆在 `tests/` 还是平铺在 `core/`、`sandbox/` 下，
 * 对「能不能 `cd` 进去跑 bun test」毫无影响 —— 而后者才是兜底失效的条件。
 * 找到第一个即返回（不必数全量，只需知道"有没有"）。
 */
function hasTestFile(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // 无权限/已删除，按"无测试"处理
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // node_modules 里全是依赖自带的测试，不是本包的；扫进去既慢又会误判
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (hasTestFile(join(dir, entry.name))) return true;
    } else if (entry.name.endsWith(".test.ts")) {
      return true;
    }
  }
  return false;
}

/** 收集所有含测试文件的 package（即能独立跑 bun test、需要自带 bunfig 的包）。 */
function packagesWithTests(): string[] {
  const packagesRoot = join(REPO_ROOT, "packages");
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => hasTestFile(join(packagesRoot, name)))
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
    // 迁移后至少 core / cli / shared / tui / eval-framework 五个包有测试文件。
    // eval-framework 是判据从"有 tests/ 目录"改成"有 *.test.ts"后新纳入的那个
    // （它的 4 个测试平铺在 core/、sandbox/、graders/ 下，旧判据整包跳过）。
    expect(packagesWithTests().length).toBeGreaterThanOrEqual(5);
  });

  test("判据自证：eval-framework 这类无 tests/ 目录的包必须被扫到", () => {
    // 这条是对上一次漏网的定点防复发。判据一旦被改回"看 tests/ 目录存在"，
    // 本条立刻红 —— 而只靠上面那个 >= 5 的下限，改回旧判据后新增任意一个
    // 带 tests/ 的包就能把数字凑够，漏网会再次静默。
    const pkgs = packagesWithTests();
    expect(existsSync(join(REPO_ROOT, "packages", "eval-framework", "tests"))).toBe(false);
    expect(
      pkgs,
      `eval-framework 有 *.test.ts（平铺在 core/、sandbox/、graders/、judge/ 下）但没有 tests/ 目录。\n` +
        `它必须在扫描面内 —— 漏掉它就等于允许 \`cd packages/eval-framework && bun test\` 写用户真实 ~/.sid-code/。`,
    ).toContain("eval-framework");
  });

  test("每个含 *.test.ts 的 package 都有 bunfig.toml 且 preload 指向根预载文件", () => {
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
      `以下 package 有 *.test.ts 但缺 bunfig.toml —— 在包内跑 \`bun test\` 时读不到根 bunfig，\n` +
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

/**
 * 子进程 env 门禁 —— preload 兜底管不到的第二个失效面（2026-10-12）。
 *
 * Bun 的 `Bun.spawn` / `Bun.spawnSync` **不继承运行时改过的 `process.env`**：
 * 不传 `env` 时子进程拿到的是进程启动那一刻的环境，preload 里设的 `SID_CONFIG_DIR`
 * 不在其中（实测：`process.env.X = "v"` 后 `Bun.spawnSync(["sh","-c","echo $X"])` 输出 unset；
 * node 的 `child_process` 则会继承）。于是起 `bun` 子进程（CLI 入口、生成器脚本）而不传 `env`
 * 的测试，子进程直接写用户真实 `~/.sid-code/`，且全绿。
 *
 * 实测命中：伪 HOME 全量跑后，伪 `~/.sid-code/app.json` 的 numStartups=2，
 * 来源是 `tests/website/gen-reference.test.ts` 里不带 env 的 `--dump-tools`。
 *
 * Bun 的 spawn 是不可配置属性，没法在 preload 里打补丁，只能静态卡住调用点。
 * 判据：调用参数里出现 `"bun"` 或 `process.execPath`（起的是 bun 进程），就必须带 `env`。
 */
const SPAWN_SCAN_DIRS = [
  "tests",
  ...readdirSync(join(REPO_ROOT, "packages")).map((p) => `packages/${p}/tests`),
];

function listTestSources(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "fixtures") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listTestSources(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 找出起 bun 子进程却没传 env 的 Bun.spawn / Bun.spawnSync 调用，返回 1 起始行号 */
export function findSpawnWithoutEnv(src: string): number[] {
  const hits: number[] = [];
  const re = /Bun\.spawn(Sync)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    const call = src.slice(m.index, j + 1);
    if (!/["']bun["']|process\.execPath/.test(call)) continue;
    if (/\benv\s*[:,}]/.test(call)) continue;
    hits.push(src.slice(0, m.index).split("\n").length);
  }
  return hits;
}

describe("子进程 env 门禁：起 bun 子进程必须显式传 env", () => {
  test("测试源码零违规", () => {
    const violations: string[] = [];
    for (const d of SPAWN_SCAN_DIRS) {
      for (const f of listTestSources(join(REPO_ROOT, d))) {
        // 本文件的变异自证用例里有违规写法的字符串字面量，不扫自己
        if (f === import.meta.path) continue;
        for (const line of findSpawnWithoutEnv(readFileSync(f, "utf-8"))) {
          violations.push(`${relative(REPO_ROOT, f)}:${line}`);
        }
      }
    }
    expect(
      violations,
      `以下调用起了 bun 子进程但没传 env —— Bun 子进程不继承运行时的 process.env，\n` +
        `preload 设的 SID_CONFIG_DIR 会丢，子进程写用户真实 ~/.sid-code/。\n` +
        `修法：加 \`env: { ...process.env }\`（或显式给一个隔离的 SID_CONFIG_DIR）。`,
    ).toEqual([]);
  });

  test("变异自证：违规写法能被抓到、合规写法不误报", () => {
    expect(
      findSpawnWithoutEnv(`Bun.spawnSync(["bun", "run", "x.ts"], { cwd: ROOT, stdout: "pipe" });`),
    ).toEqual([1]);
    expect(findSpawnWithoutEnv(`Bun.spawn({ cmd: [process.execPath, "x.ts"] });`)).toEqual([1]);
    expect(
      findSpawnWithoutEnv(`Bun.spawnSync(["bun", "x"], { env: { ...process.env } });`),
    ).toEqual([]);
    expect(findSpawnWithoutEnv(`Bun.spawnSync(["bun", "x"], { env });`)).toEqual([]);
    // 起的不是 bun（git / tar 等），不归本门禁管
    expect(findSpawnWithoutEnv(`Bun.spawnSync(["git", "log"], { cwd: ROOT });`)).toEqual([]);
  });
});
