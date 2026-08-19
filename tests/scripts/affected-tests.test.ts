/**
 * affected-tests / change-scope 的正确性 + 反漂移门禁（2026-08-19，P0-2 选择性测试）。
 *
 * ## 这道门禁存在的理由
 *
 * 选择性测试有一个**比"跑得慢"糟糕得多的失败模式**：选出一个错的范围，然后全绿。
 * 三种具体形态，本文件逐一断言：
 *
 * 1. **选空集然后全绿** —— 映射漏了某类路径 → 改了代码却一个测试都没跑，
 *    退出码 0，看起来"验证过了"。这是本仓反复出现的「建好未接线」病灶的变体。
 * 2. **选错范围但看起来对** —— bun 的位置参数是**完整路径子串过滤**而非目录：
 *    `bun test tests/` 实测搜 692 个文件（匹配所有路径含 "tests/" 的），
 *    `bun test ./tests/` 才是 38 个。少一个 `./` 就等于偷偷跑了全量，
 *    表现为"选测又慢又没省"，从而让人误判方案无效。
 * 3. **选出不存在的路径** —— `bun test <不存在的路径>` 退出码是 **1**
 *    （"had no matches"）。所以一个正常改动会**红在与改动无关的地方**。
 *
 * ## 为什么用「真路径存在性」而不是快照
 *
 * 下面几组断言刻意去 `existsSync` 真实目录、真实读 `package.json`，而不是比对
 * 硬编码的期望列表。因为目录约定本身会漂移（新增 domain、删掉 domain），
 * 快照式断言在漂移时只会告诉你"快照不一致"，不会告诉你"选测已经开始漏测了"。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decide, mapPathToTests } from "../../scripts/affected-tests.ts";
import { computeChangeScope, parseArgs } from "../../scripts/change-scope.ts";

const ROOT = join(import.meta.dir, "../..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** 把映射结果里的 `./x/` 还原成仓库相对路径，供存在性检查。 */
function toRepoPath(target: string): string {
  return target.replace(/^\.\//, "").replace(/\/$/, "");
}

function dirsOf(rel: string): string[] {
  return readdirSync(join(ROOT, rel), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

describe("路径映射：输出的每个目标都必须真的能跑", () => {
  test("所有映射产出的路径都存在（bun test 对不存在的路径退出码是 1）", () => {
    // 覆盖面取真实目录，而不是手写清单——手写清单必漂移。
    const samples: string[] = [
      ...dirsOf("packages/core/src").map((d) => `packages/core/src/${d}/x.ts`),
      ...dirsOf("packages/core/tests").map((d) => `packages/core/tests/${d}/x.test.ts`),
      ...dirsOf("packages").map((p) => `packages/${p}/src/x.ts`),
      "scripts/trace-digest.ts",
      "tests/release-flow-contract.test.ts",
      ".github/workflows/ci.yml",
      "website/index.md",
      "changelog/curated/v0.1.600.json",
      "evals/cases/case_001.yaml",
      "scripts/eval/list-evals.ts",
    ];

    const missing: string[] = [];
    for (const s of samples) {
      const r = mapPathToTests(s);
      if (r === "full") continue;
      for (const t of r) {
        if (!existsSync(join(ROOT, toRepoPath(t)))) missing.push(`${s} → ${t}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("所有映射产出的路径都带 ./ 前缀（少了它 bun 会子串匹配到全仓）", () => {
    const bad: string[] = [];
    for (const d of dirsOf("packages/core/src")) {
      const r = mapPathToTests(`packages/core/src/${d}/x.ts`);
      if (r === "full") continue;
      for (const t of r) if (!t.startsWith("./")) bad.push(`${d} → ${t}`);
    }
    for (const p of dirsOf("packages")) {
      const r = mapPathToTests(`packages/${p}/src/x.ts`);
      if (r === "full") continue;
      for (const t of r) if (!t.startsWith("./")) bad.push(`${p} → ${t}`);
    }
    expect(bad).toEqual([]);
  });

  test("生成的命令里每个位置参数都带 ./（含 full 与 selective 两条路径）", () => {
    const v = decide(["packages/core/src/telemetry/a.ts", "packages/shared/src/b.ts"]);
    expect(v.decision).toBe("selective");
    // 位置参数（非 -- 开头、非引号内容）必须都是 ./ 开头
    const positional = v.command
      .replace(/--test-name-pattern\s+'[^']*'/, "")
      .split(/\s+/)
      .filter((s) => s && s !== "bun" && s !== "test");
    expect(positional.length).toBeGreaterThan(0);
    for (const p of positional) expect(p.startsWith("./")).toBe(true);
  });
});

describe("路径映射：core domain 的 src ↔ tests 对应关系", () => {
  test("每个有同名 tests/ 目录的 src domain 都精确映射到该目录，不回退整包", () => {
    const wrong: string[] = [];
    for (const d of dirsOf("packages/core/src")) {
      if (!existsSync(join(ROOT, `packages/core/tests/${d}`))) continue;
      const r = mapPathToTests(`packages/core/src/${d}/x.ts`);
      if (JSON.stringify(r) !== JSON.stringify([`./packages/core/tests/${d}/`])) {
        wrong.push(`${d} → ${JSON.stringify(r)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("src 独有目录（无同名 tests/）回退整包，而不是产出空集或不存在的路径", () => {
    for (const d of dirsOf("packages/core/src")) {
      if (existsSync(join(ROOT, `packages/core/tests/${d}`))) continue;
      // 这几个目录当前确实缺测试（bootstrap / command-contract / coordinator），
      // 回退整包是"宁可多跑"，绝不能是空集——空集意味着改了代码零验证。
      expect(mapPathToTests(`packages/core/src/${d}/x.ts`)).toEqual(["./packages/core/"]);
    }
  });

  test("tests/ 下的共享设施目录回退整包（helpers 被大量测试 import）", () => {
    // helpers/fixtures 不是某个 domain 的测试，改它们影响面不限于同名目录。
    for (const d of ["helpers", "fixtures", "guard"]) {
      if (!existsSync(join(ROOT, `packages/core/tests/${d}`))) continue;
      expect(mapPathToTests(`packages/core/tests/${d}/x.ts`)).toEqual(["./packages/core/"]);
    }
  });
});

describe("逃逸阀：仓库级改动必须走全量", () => {
  // 判据是「改了它，任意测试的行为都可能变」。
  const REPO_LEVEL = [
    "bunfig.toml",
    "packages/core/bunfig.toml",
    "packages/cli/bunfig.toml",
    "package.json",
    "bun.lock",
    "Makefile",
    "tsconfig.json",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    "tests/build/package-boundary.test.ts",
    "tests/preload-isolate-sid-home.ts",
    "scripts/release.sh",
  ];

  for (const p of REPO_LEVEL) {
    test(`${p} → 全量`, () => {
      expect(mapPathToTests(p)).toBe("full");
    });
  }

  test("bunfig.toml 逃逸阀是落盘隔离兜底的挂载点，漏了它测试会写真实 ~/.sid-code/", () => {
    // 这一条单列，因为它的后果是"全绿 + 污染用户真实数据"，不是"红"。
    const v = decide(["packages/core/src/telemetry/a.ts", "bunfig.toml"]);
    expect(v.decision).toBe("full");
    expect(v.reason).toContain("bunfig.toml");
  });

  test("同时改 ≥3 个包 → 全量（跨包导入改写的特征）", () => {
    const v = decide([
      "packages/core/src/llm/a.ts",
      "packages/cli/src/b.ts",
      "packages/shared/src/c.ts",
    ]);
    expect(v.decision).toBe("full");
    expect(v.touchedPackages).toEqual(["cli", "core", "shared"]);
  });

  test("只改 2 个包 → 仍走选择性（阈值不能是 2，否则选测基本失效）", () => {
    const v = decide(["packages/core/src/llm/a.ts", "packages/shared/src/c.ts"]);
    expect(v.decision).toBe("selective");
  });
});

describe("空集与无测试改动：必须能区分「不用跑」和「漏了」", () => {
  test("纯文档改动 → none，命令是 true（显式的「无需跑」而非静默空集）", () => {
    const v = decide(["CLAUDE.md", "README.md", "CONTRIBUTING.md", "NOTICE"]);
    expect(v.decision).toBe("none");
    expect(v.command).toBe("true");
  });

  test("但 website/ 下的文档**要**触发（它是从源码生成的，有反漂移门禁守着）", () => {
    // website/ref/ 6 页由 docs-gen-reference 生成，tests/website/gen-reference.test.ts
    // 断言它与源码一致。所以改它不是"纯文档改动"，不能划进 none。
    expect(mapPathToTests("website/ref/tools.md")).toEqual(["./tests/website/"]);
  });

  test("无改动 → none，且理由能区分于「有改动但不涉及被测代码」", () => {
    expect(decide([]).reason).toBe("无改动");
    expect(decide(["README.md"]).reason).not.toBe("无改动");
  });

  test("选择性判定绝不产出空的目标列表", () => {
    const v = decide(["packages/core/src/telemetry/a.ts"]);
    expect(v.decision).toBe("selective");
    expect(v.targets.length).toBeGreaterThan(0);
  });
});

describe("与 package.json 的接线（反漂移）", () => {
  test("三个脚本都挂上了", () => {
    expect(PKG.scripts["change-scope"]).toContain("scripts/change-scope.ts");
    expect(PKG.scripts["affected-tests"]).toContain("scripts/affected-tests.ts");
    expect(PKG.scripts["affected-tests:run"]).toContain("affected-tests.ts");
  });

  test("affected-tests:run 过滤掉 # 注释行，否则 eval 会把说明当命令跑", () => {
    expect(PKG.scripts["affected-tests:run"]).toContain("grep -v '^#'");
  });

  test("生成的命令与 test 脚本同口径地排除慢标记", () => {
    // 不排除的话，选测在 llm 目录上会比 `bun run test` 还慢（那 4 条实测 22.1s），
    // 于是"更快"这个唯一收益就没了。
    const v = decide(["packages/core/src/llm/a.ts"]);
    expect(v.command).toContain("--test-name-pattern");
    expect(v.command).toContain("slow");
    expect(PKG.scripts.test).toContain("--test-name-pattern");
  });

  test("full 判定的命令也排除慢标记（本地快通道口径一致）", () => {
    // CI 与发布门禁跑裸 `bun test` 全量（由 tests/build/slow-test-suite-split.test.ts 守），
    // 本脚本是**本地**通道，所以这里排除是对的，不是漏。
    const v = decide(["bunfig.toml"]);
    expect(v.decision).toBe("full");
    expect(v.command).toContain("slow");
  });
});

describe("change-scope：四类路径分开报", () => {
  test("untracked 单独一类（新文件不在任何 diff 里，漏了就漏掉新增的测试）", () => {
    const scope = computeChangeScope("HEAD", "HEAD");
    expect(scope.paths).toHaveProperty("committed");
    expect(scope.paths).toHaveProperty("staged");
    expect(scope.paths).toHaveProperty("unstaged");
    expect(scope.paths).toHaveProperty("untracked");
    // 同一个 ref 比自己 → committed 必空，这是纯函数性质，不依赖工作区状态
    expect(scope.paths.committed).toEqual([]);
  });

  test("带 formatVersion（下游可判版本，不用猜结构）", () => {
    expect(computeChangeScope("HEAD", "HEAD").formatVersion).toBe(1);
  });

  test("base 解析不到时抛错，不静默降级", () => {
    // 猜错 base 的后果不是报错，是选测范围**静默变错**：
    // 猜太旧 → 膨胀成全量（选测白做）；猜太新 → 漏成空集（更危险）。
    expect(() => computeChangeScope("no-such-ref-zzz", "HEAD")).toThrow(/解析不到/);
  });

  test("默认 base 是 origin/main，且 --base/--head 能覆盖", () => {
    expect(parseArgs([]).base).toBe("origin/main");
    expect(parseArgs([]).head).toBe("HEAD");
    expect(parseArgs(["--base", "abc", "--head", "def"])).toEqual({ base: "abc", head: "def" });
  });
});
