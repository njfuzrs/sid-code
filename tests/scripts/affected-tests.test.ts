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
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_TEST_PATHS, decide, mapPathToTests } from "../../scripts/affected-tests.ts";
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
      // 这三个目录已在 2026-10-13 补上测试（PR-E）；
      // 本用例保留，用于覆盖将来新增的、没有测试目录的 src 目录。
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
  test("白名单内的无读取者文档 → none，命令是 true（显式的「无需跑」而非静默空集）", () => {
    const v = decide(["LICENSE", "README.en.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]);
    expect(v.decision).toBe("none");
    expect(v.command).toBe("true");
  });

  test("被测试读取的根文件不再判 none（X3-01：它们原先和 LICENSE 同档）", () => {
    // 逐条对应 X3-01 点名的「确有测试读取、却判零测试」的路径。
    // 变异自证：把兜底改回 `return []`，这一条与下一组全红。
    for (const p of [
      ".bun-version",
      "CLAUDE.md",
      "CONTRIBUTING.md",
      "CHANGELOG.md",
      ".gitignore",
      ".agents/notes/README.md",
      "README.md",
    ]) {
      expect(mapPathToTests(p), `${p} 被判成零测试`).not.toEqual([]);
    }
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

describe("兜底方向：清单漏一个文件的后果是「多跑全量」，不是「零测试」（X3-01）", () => {
  test("未登记的未知路径 → full（兜底是「跑」，不是「跳过」）", () => {
    // 这一条就是 X3-01 的变异哨兵：把 mapPathToTests 末尾改回 `return []` 它必红。
    expect(mapPathToTests("docs/some-unknown-note.md")).toBe("full");
    expect(mapPathToTests("unknown-dir/file.txt")).toBe("full");
    // 前缀相同但不是白名单项（`LICENSE-extra` 不是 `LICENSE`）也必须全量
    expect(mapPathToTests("LICENSE-extra")).toBe("full");
  });

  test("真实 git ls-files 里，判空集的路径全部能指到 NO_TEST_PATHS", () => {
    // 守的是「清单完整性」：兜底改成 full 之后，空集只可能来自白名单；
    // 这条把「白名单项写得过宽」也钉住（例如误写 `README` 前缀会吞掉 README.md）。
    const files = spawnSync("git", ["ls-files"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .stdout.split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(1000);
    const unexplained = files.filter((f) => {
      const r = mapPathToTests(f);
      if (!Array.isArray(r) || r.length > 0) return false;
      return !NO_TEST_PATHS.some((n) => f === n || (n.endsWith("/") && f.startsWith(n)));
    });
    expect(unexplained).toEqual([]);
  });

  test("白名单里的每一项都必须真的返回空集（写错前缀 = 白名单静默失效）", () => {
    // 变异自证：往 NO_TEST_PATHS 加 "CLAUDE.md"（它会被 ROOT_FILE_TESTS 先命中），
    // 这条立刻变红——白名单项写了却不生效，是最难发现的一类空转。
    for (const item of NO_TEST_PATHS) {
      expect(mapPathToTests(item), `${item} 在白名单里但不返回空集`).toEqual([]);
    }
  });

  test("白名单准入判据：没有任何测试读取白名单里的路径", () => {
    // 判据是可执行的，与 scripts/affected-tests.ts 的注释一一对应：
    //   grep -rlF '"<路径>"' tests packages/<pkg>/tests   → 零命中
    // 排除判据自身的测试文件（它必然提到白名单项）。
    const SELF = "tests/scripts/affected-tests.test.ts";
    const testRoots = [
      "tests",
      ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/tests`),
    ].filter((d) => existsSync(join(ROOT, d)));

    const offenders: string[] = [];
    for (const item of NO_TEST_PATHS) {
      for (const dir of testRoots) {
        const r = spawnSync("grep", ["-rlF", "--", `"${item}"`, dir], {
          cwd: ROOT,
          encoding: "utf8",
        });
        const hits = (r.stdout ?? "")
          .split("\n")
          .filter(Boolean)
          .filter((f) => f !== SELF);
        if (hits.length > 0) offenders.push(`${item} ← ${hits.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("根文件映射的目标必须真实存在（映射指向不存在的路径会让 bun test 退出码 1）", () => {
    const samples = [
      ".bun-version",
      "CLAUDE.md",
      "CONTRIBUTING.md",
      "CHANGELOG.md",
      ".gitignore",
      ".agents/notes/README.md",
      ".pr-batch/plan.json",
      "northstar/v0.1.601.json",
      "README.md",
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

  /**
   * X3-15：接线不能吞掉脚本的退出码。
   *
   * 旧写法 `eval "$(bun run scripts/affected-tests.ts | grep -v '^#')"` 里，
   * 命令替换丢弃内部退出码：base 解析失败时 stdout 为空，`eval ""` 返回 0 ——
   * **零测试、exit 0**，和「没有改动」长得一模一样。影响所有改动、不限文件类型。
   *
   * 这两条是行为断言（真跑整条 `sh -c` 接线），不是文本断言：
   * 文本断言（`toContain("affected-tests.ts")`）在旧写法下也是绿的，它证明不了接线有效。
   */
  test("base 解析失败时，整条接线必须非 0 退出（不能「零测试然后全绿」）", () => {
    const r = spawnSync("sh", ["-c", PKG.scripts["affected-tests:run"]], {
      cwd: ROOT,
      encoding: "utf8",
      // 注入不存在的 base：这是 X3-15 唯一的失效形态，而接线层原先把它吞掉了。
      env: { ...process.env, AFFECTED_TESTS_BASE: "no-such-ref-zzz-for-x3-15" },
    });
    // 变异自证：把 package.json 那行改回 `eval "$(... | grep -v '^#')"`，本条必红。
    expect(r.status, `接线退出码应为非 0，实际 ${r.status}\nstderr: ${r.stderr}`).not.toBe(0);
    // 不只是非 0：失败原因要能被人看见（否则「非 0 但没说为什么」仍然难归因）。
    expect(r.stderr).toContain("no-such-ref-zzz-for-x3-15");
  });

  test("base 正常时接线会把脚本输出当命令执行（正常路径没被串联弄坏）", () => {
    // 为什么用 stub `bun` 而不是真跑：真跑会真的执行选出的 `bun test …`
    // （工作区有未提交改动时必然选出非空集），一条单测变成几十秒的选测。
    // stub 只验证**接线**这一段：脚本输出经 grep 过滤后被 eval 执行。
    const bin = mkdtempSync(join(tmpdir(), "x3-15-bin-"));
    try {
      const fakeBun = join(bin, "bun");
      writeFileSync(
        fakeBun,
        ["#!/bin/sh", "echo '# 判定：none —— stub'", "echo 'echo __EVAL_RAN__'", "exit 0"].join(
          "\n",
        ),
      );
      chmodSync(fakeBun, 0o755);
      const r = spawnSync("sh", ["-c", PKG.scripts["affected-tests:run"]], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(r.status, `接线应成功\nstderr: ${r.stderr}`).toBe(0);
      // 脚本输出被真的 eval 了（注释行被 grep 滤掉，剩下那行命令被执行）
      expect(r.stdout).toContain("__EVAL_RAN__");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
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

describe("eval-framework/judge 搬家后不得漏测", () => {
  test("改 packages/eval-framework/judge/ 选出非空集（整包，不是空、也不是全仓）", () => {
    // 11a PR-C：calibrate-pairwise.test.ts 从 evals/_judge/ 搬进包内。
    // 若映射漏掉这个包，选测会「全绿但什么都没跑」—— 5 条变异自证要防的正是这个。
    const r = mapPathToTests("packages/eval-framework/judge/calibrate-pairwise.test.ts");
    expect(r).not.toBe("full");
    expect(r).toEqual(["./packages/eval-framework/"]);
    expect(existsSync(join(ROOT, "packages/eval-framework"))).toBe(true);
  });

  test("改 packages/eval-framework/judge/prompt-v2.md 同样命中整包（prompt 不是纯文档）", () => {
    const r = mapPathToTests("packages/eval-framework/judge/prompt-v2.md");
    expect(r).toEqual(["./packages/eval-framework/"]);
  });
});

describe("仓内插件 plugins/ 不得漏测（内置 skill 下沉方案 P1）", () => {
  // 变异自证：删掉 ROOT_TEST_AREAS 里 `/^plugins\//` 那一行，下面三条全红 ——
  // plugins/ 会落到 mapPathToTests 末尾的 `return []`，即「改插件零验证且全绿」。
  const cases = [
    "plugins/ops/plugin.json",
    "plugins/compliance/skills/security-audit/SKILL.md",
    "plugins/ops/skills/ci-heal/scripts/parse-ci-log.ts",
    "plugins/tests/ci-self-heal.test.ts",
  ];
  for (const p of cases) {
    test(`${p} → ./plugins/`, () => {
      expect(mapPathToTests(p)).toEqual(["./plugins/"]);
    });
  }

  test("映射目标真实存在且含测试文件（不是一个空目录）", () => {
    expect(existsSync(join(ROOT, "plugins/tests"))).toBe(true);
    const tests = readdirSync(join(ROOT, "plugins/tests")).filter((f) => f.endsWith(".test.ts"));
    expect(tests.length).toBeGreaterThanOrEqual(6);
  });

  test("改打包脚本 scripts/plugins-pack.ts 跑插件套件，而不是只跑根 tests/", () => {
    expect(mapPathToTests("scripts/plugins-pack.ts")).toEqual(["./plugins/"]);
  });

  test("只改插件的 diff 判定为选择性且目标非空", () => {
    const d = decide(["plugins/github-pr/skills/comments/SKILL.md"]);
    expect(d.decision).toBe("selective");
    expect(d.targets).toEqual(["./plugins/"]);
  });
});
