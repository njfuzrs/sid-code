#!/usr/bin/env bun
/**
 * affected-tests —— 把改动路径映射成「要跑哪些测试」，替代无条件全量。
 *
 * ## 它解决的问题
 *
 * 全量 `bun test` 实测 202.87s（P0-1 修完 ~95s）；而 `bun test ./packages/core/tests/telemetry/`
 * 只搜 19 个文件、0.3s 量级。改一个 telemetry 文件却要等 95s，这个成本会直接
 * 反映成「agent 跳过验证」——门禁贵到一定程度就会被绕过。
 *
 * ⚠️ **这一步拿「更安全」换「更快」**，补偿必须成对存在：CI 在**合并前**跑全量。
 * 只做本地选测而不做合并前全量，等于把风险从本地挪到 main 上。
 *
 * ## 为什么用路径映射，而不是依赖图分析
 *
 * `packages/core/` 的 `src/` 与 `tests/` 目录名重名命中 **33/36**（实测，见下方常量），
 * 这个约定本身就是一张现成的映射表。DSH 那类项目用 `vitest related`（真依赖图）是因为
 * 它们没有这个目录约定。依赖图更准，但要维护解析器、要处理动态 import、要跟着构建工具走——
 * 在 33/36 命中率下，那些复杂度买不到相应的准确率。
 *
 * ## 四个实测事实，改这个脚本前必须知道
 *
 * 1. **bun 的位置参数是「完整路径子串过滤」，不是目录**：
 *    ```
 *    bun test tests/    → 搜 692 个文件 ❌（匹配所有路径含 "tests/" 的文件）
 *    bun test ./tests/  → 搜  38 个文件 ✅
 *    bun test telemetry → 搜  22 个文件（跨包！core 与 cli 都匹配）
 *    ```
 *    所以本脚本输出的路径**一律带 `./` 前缀**。漏了它，「我只跑了 telemetry」实际会
 *    跑掉整个仓库——而且看起来又慢又没省，从而让人误判「选测方案无效」。
 *
 * 2. **`bun test <不存在的路径>` 退出码是 1**（"had no matches"）。所以映射结果
 *    必须逐个 `existsSync` 过滤，否则一个正常改动会让选测**红在无关的地方**。
 *    这是本脚本里唯一一处「必须访问文件系统」的理由。
 *
 * 3. `packages/core/tests/` 下有 **4 个 tests 独有目录**（`src/` 没有同名）：
 *    `fixtures` / `guard` / `helpers` / `integration`。前三个不是「某个 domain 的测试」，
 *    改到它们不能只跑同名目录（`helpers/` 被大量测试 import，`fixtures/` 是 VCR 数据）。
 *
 * 4. **`src/` 有 3 个目录没有对应 tests/**：`bootstrap` / `command-contract` / `coordinator`。
 *    改到它们回退跑整个 core 包，而不是输出空集——空集会让选测「全绿但什么都没测」。
 *
 * ## 输出形态
 *
 * 默认打印一行可执行的命令（外加 `#` 开头的判定说明），供 `eval "$(...)"` 消费。
 * `--json` 输出结构化结果，供测试与其它脚本消费。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeChangeScope, parseArgs } from "./change-scope.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * 命中即全量：这些文件的改动是**仓库级**的，选测在它们身上没有意义。
 *
 * 收录判据是「改了它，任意一个测试的行为都可能变」，不是「它看起来很重要」：
 *   · bunfig.toml / packages/{*}/bunfig.toml —— preload 兜底（tests/preload-isolate-sid-home.ts）
 *     的挂载点。改错了会让全仓测试往真实 ~/.sid-code/ 写，而**测试仍然全绿**。
 *   · package.json —— 依赖与 test/test:slow 脚本定义本身。
 *   · Makefile / scripts/release.sh —— 构建与发布链路，tests/build/ 与
 *     tests/release-flow-contract.test.ts 直接读它们。
 *   · tests/build/** —— 仓库级门禁（包边界、preload 接线、slow 套件拆分）。
 *   · tests/preload-isolate-sid-home.ts —— 落盘隔离兜底本体。
 *   · tsconfig / oxlint / oxfmt 配置 —— 影响全仓解析与门禁口径。
 */
const FORCE_FULL_PATTERNS: RegExp[] = [
  /^bunfig\.toml$/,
  /^packages\/[^/]+\/bunfig\.toml$/,
  /^package\.json$/,
  /^bun\.lock(b)?$/,
  /^Makefile$/,
  /^tsconfig(\.[^/]+)?\.json$/,
  /^\.oxlintrc\.json$/,
  /^\.oxfmtrc\.json$/,
  /^tests\/build\//,
  /^tests\/preload-isolate-sid-home\.ts$/,
  /^scripts\/release\.sh$/,
];

/**
 * 同时改动 ≥ 该数量的包 → 视为跨包重构，走全量。
 *
 * 依据是本仓真实事故：`5acda521`「补回 212 个文件的跨包导入改写 —— 8ae3472e 漏提交，
 * HEAD 构建不出来」。跨包改写的特征就是同时碰多个包，此时按包选测必然漏掉
 * 「A 包改了导出、B 包的测试才会红」这类跨包断裂。
 */
const CROSS_PACKAGE_FULL_THRESHOLD = 3;

/**
 * `src/` 独有、没有同名 `tests/` 目录的 core domain（实测 2026-08-19）。
 * 改到它们回退整包，而不是输出一个不存在的路径或空集。
 *
 * ⚠️ 这三个目录**缺测试**本身是个真实缺口（`bootstrap` 是无头入口之一），
 * 不属于本脚本的职责范围，但别把这里的回退当成「已覆盖」。
 */
const CORE_SRC_WITHOUT_TESTS = new Set(["bootstrap", "command-contract", "coordinator"]);

/**
 * `packages/core/tests/` 下**不是 domain 测试**的目录 —— 它们是被别的测试消费的
 * 共享设施，改动影响面不限于同名目录，所以一律回退整包。
 *
 * `integration` 例外：它是真测试目录（`goal-loop.test.ts`），改它只跑它自己就够。
 */
const CORE_TESTS_SHARED_DIRS = new Set(["fixtures", "guard", "helpers"]);

/**
 * 仓库根 `tests/` 的分区映射：改一个域不必跑全部 38 个文件。
 * 未列出的子目录与散文件回退到 `./tests/`（整个仓库级套件，38 文件仍是秒级）。
 */
const ROOT_TEST_AREAS: Array<{ when: RegExp; run: string }> = [
  // 官网/文档生成：website/ 与 changelog/ 的改动由 tests/website/ 守
  { when: /^website\//, run: "./tests/website/" },
  { when: /^changelog\//, run: "./tests/website/" },
  // evals 数据与 eval 脚本：由 tests/eval/ 守
  { when: /^evals\//, run: "./tests/eval/" },
  { when: /^scripts\/eval\//, run: "./tests/eval/" },
];

export type MapResult = string[] | "full";

/** 单个路径 → 要跑的测试目标（带 ./ 前缀）。返回 "full" 表示必须全量。 */
export function mapPathToTests(p: string): MapResult {
  if (FORCE_FULL_PATTERNS.some((re) => re.test(p))) return "full";

  // ── 包内 ────────────────────────────────────────────────────────────
  const m = /^packages\/([^/]+)\/(.+)$/.exec(p);
  if (m) {
    const [, pkg, rest] = m;

    if (pkg === "core") {
      const inSrc = /^src\/(.+)$/.exec(rest);
      const inTests = /^tests\/(.+)$/.exec(rest);
      const seg = (inSrc ?? inTests)?.[1]?.split("/")[0];

      // core 根下的散文件（如 package.json、index.ts）：整包
      if (!seg) return ["./packages/core/"];

      if (inTests && CORE_TESTS_SHARED_DIRS.has(seg)) return ["./packages/core/"];
      if (inSrc && CORE_SRC_WITHOUT_TESTS.has(seg)) return ["./packages/core/"];

      const target = `packages/core/tests/${seg}/`;
      // src 里新增了一个 domain、tests 还没跟上 → 回退整包而不是输出不存在的路径
      // （bun test 对不存在的路径退出码是 1）。
      if (!existsSync(join(REPO_ROOT, target))) return ["./packages/core/"];
      return [`./${target}`];
    }

    // 其余包体量小（shared 8 文件 / eval-framework 4 文件 / tui-renderer、cli 中等），
    // 直接整包跑，省掉一张会漂移的映射表。
    return [`./packages/${pkg}/`];
  }

  // ── 仓库根 ──────────────────────────────────────────────────────────
  for (const area of ROOT_TEST_AREAS) {
    if (area.when.test(p)) return [area.run];
  }
  // scripts/ 与 tests/ 自身：跑仓库级套件
  if (p.startsWith("scripts/") || p.startsWith("tests/")) return ["./tests/"];
  // .github/workflows：由 release-flow-contract 与 slow-test-suite-split 守（都在根 tests/）
  if (p.startsWith(".github/")) return ["./tests/"];

  // 文档、LICENSE、.editorconfig 等：不触发单测
  return [];
}

/**
 * 与 `package.json` 的 `test` 脚本同口径地排除 `[slow]` 标记的 case。
 *
 * 必须带上它，否则「选择性测试」在 llm 目录上会比 `bun run test` 还慢——
 * 那 4 条 `[slow]` case 正是 P0-1 认定「受源码硬编码常量地板约束、缩放零收益」
 * 才移出默认套件的（实测 22.1s）。实测位置参数与 `--test-name-pattern` 可叠加：
 * `bun test ./packages/core/tests/llm/ --test-name-pattern '^(?!.*\[slow\])'`
 * → `4 filtered out`，其余 1347 条照跑。
 *
 * ⚠️ 这里刻意重复写出 pattern 而不是去调 `bun run test`：`bun run test` 不接受
 * 追加位置参数做目录过滤，而裸 `bun test` 不读 package.json 的 scripts。
 * 反漂移由 `tests/scripts/affected-tests.test.ts` 断言两处 pattern 一致。
 */
const EXCLUDE_SLOW = String.raw`--test-name-pattern '^(?!.*\[slow\])'`;

export interface Verdict {
  decision: "full" | "selective" | "none";
  reason: string;
  targets: string[];
  command: string;
  changedCount: number;
  touchedPackages: string[];
}

export function decide(changed: string[]): Verdict {
  const touchedPackages = [
    ...new Set(
      changed
        .map((p) => /^packages\/([^/]+)\//.exec(p)?.[1])
        .filter((x): x is string => Boolean(x)),
    ),
  ].sort();

  if (touchedPackages.length >= CROSS_PACKAGE_FULL_THRESHOLD) {
    return {
      decision: "full",
      reason: `跨 ${touchedPackages.length} 个包（≥${CROSS_PACKAGE_FULL_THRESHOLD}）→ 按跨包重构处理`,
      targets: [],
      command: `bun test ${EXCLUDE_SLOW}`,
      changedCount: changed.length,
      touchedPackages,
    };
  }

  const targets = new Set<string>();
  for (const p of changed) {
    const r = mapPathToTests(p);
    if (r === "full") {
      return {
        decision: "full",
        reason: `仓库级文件改动：${p}`,
        targets: [],
        command: `bun test ${EXCLUDE_SLOW}`,
        changedCount: changed.length,
        touchedPackages,
      };
    }
    for (const t of r) targets.add(t);
  }

  if (targets.size === 0) {
    return {
      decision: "none",
      reason: changed.length === 0 ? "无改动" : "改动不涉及任何被测代码（文档 / 配置 / 资源）",
      targets: [],
      command: "true",
      changedCount: changed.length,
      touchedPackages,
    };
  }

  const sorted = [...targets].sort();
  return {
    decision: "selective",
    reason: `${sorted.length} 个测试目标`,
    targets: sorted,
    command: `bun test ${sorted.join(" ")} ${EXCLUDE_SLOW}`,
    changedCount: changed.length,
    touchedPackages,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const { base, head } = parseArgs(argv);

  let verdict: Verdict;
  try {
    const scope = computeChangeScope(base, head);
    // untracked 也算进来：新增的测试文件不在任何 diff 里，漏掉它就会「新写的测试没跑」。
    const changed = [
      ...scope.paths.committed,
      ...scope.paths.staged,
      ...scope.paths.unstaged,
      ...scope.paths.untracked,
    ];
    verdict = decide([...new Set(changed)]);
  } catch (e) {
    console.error(`[affected-tests] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    // 注释走 stdout 而非 stderr：`eval "$(... | grep -v '^#')"` 是约定消费方式，
    // 人直接跑时也应该看见判定理由。
    console.log(`# 判定：${verdict.decision} —— ${verdict.reason}`);
    console.log(verdict.command);
  }
}
