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
 * 5. **兜底方向是「全量」，不是「零测试」**（X3-01，2026-11-07 翻转）：
 *    原先「所有规则都不命中」就 `return []`，于是映射清单漏一个文件的结果是
 *    **零测试且全绿**——最典型的受害者是根目录那些被测试读取的文件
 *    （`.bun-version` 决定跑测试的运行时本身，却和 `LICENSE` 同档）。
 *    现在只有 `NO_TEST_PATHS` 里显式登记、并被机械断言守住「零读取者」的路径
 *    才返回 `[]`，其余一律 `"full"`。漏登记的代价从「静默漏测」变成「多跑一次全量」，
 *    方向反了过来。
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
 * `src/` 独有、没有同名 `tests/` 目录的 core domain。
 * 改到它们回退整包，而不是输出一个不存在的路径或空集。
 *
 * 2026-10-13：bootstrap / command-contract / coordinator 三个目录已补测试（PR-E），
 * 名单清空。新增无测试目录时由下方 existsSync 兜底回退整包，不需要手动加进来。
 */
const CORE_SRC_WITHOUT_TESTS = new Set<string>([]);

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
  // 仓内插件（内置 skill 下沉方案 P1）：plugins/<name>/ 与 plugins/tests/ 都由 plugins/tests/ 守。
  // 不列这一行，plugins/ 前缀会落到末尾的 `return []` —— 改插件时选测是空集、零验证且全绿。
  { when: /^plugins\//, run: "./plugins/" },
  // 打包脚本的产物契约由 plugins/tests/plugins-pack.test.ts 守
  { when: /^scripts\/plugins-pack\.ts$/, run: "./plugins/" },
];

/**
 * 被测试**真实读取**的仓库根文件/目录 → 精确测试目标。
 *
 * 为什么不能一律走全量：改一句 `README.md` 就跑 127s，门禁贵到一定程度人就会绕过它。
 * 为什么不能落进 `NO_TEST_PATHS`：判据是「有没有测试读它」，不是「它看起来像文档」。
 * `.bun-version` 最典型——它决定跑测试的运行时本身，按「改了它任意测试行为都可能变」
 * 的收录判据只能走全量。
 *
 * 每一条的来源都是 `grep -rnF '"<路径>"' tests packages/<pkg>/tests` 的真实命中，
 * 并由 `tests/scripts/affected-tests.test.ts` 的「被读文件必须映射到非空目标」守着重算。
 */
const ROOT_FILE_TESTS: Array<{ when: RegExp; run: MapResult }> = [
  // 运行时时版本：不是「某个测试读它」，而是它决定所有测试跑在哪个 bun 上
  { when: /^\.bun-version$/, run: "full" },
  // 两份 agent/贡献者约定：`tests/build-target-naming.test.ts` 读构建目标命名段，
  // `tests/release-channel.test.ts` 断言发布口径出现在 CLAUDE.md 里
  {
    when: /^CLAUDE\.md$/,
    run: ["./tests/build-target-naming.test.ts", "./tests/release-channel.test.ts"],
  },
  // bun 版本钉住说明与发布流程契约
  {
    when: /^CONTRIBUTING\.md$/,
    run: ["./tests/build/bun-version-pin.test.ts", "./tests/release-flow-contract.test.ts"],
  },
  // changelog 生成器与发布流程契约都读它
  {
    when: /^CHANGELOG\.md$/,
    run: ["./tests/website/changelog-integration.test.ts", "./tests/release-flow-contract.test.ts"],
  },
  // .gitignore 的排除条目是「落盘隔离」「vendor 定位」「pr-batch 路径派生」三组门禁的事实源
  {
    when: /^\.gitignore$/,
    run: [
      "./tests/scripts/pr-batch-path-derivation.test.ts",
      "./tests/build/vendor-location.test.ts",
    ],
  },
  // 已入库的 Agent Note 由这条测试遍历校验形态
  { when: /^\.agents\//, run: ["./tests/build/agent-note-gate.test.ts"] },
  // .pr-batch 的入库文件清单由路径派生测试读，plan.json 由 fork 接线测试读
  {
    when: /^\.pr-batch\//,
    run: [
      "./tests/scripts/pr-batch-path-derivation.test.ts",
      "./tests/scripts/pr-batch-fork-wiring.test.ts",
    ],
  },
  // 发版产物快照：northstar 聚合与发布流程契约相关
  {
    when: /^northstar\//,
    run: ["./tests/scripts/northstar-snapshot.test.ts", "./tests/release-flow-contract.test.ts"],
  },
  // 仓库门面文档：没有测试读其内容，但改它属于仓库级改动，跑根套件（38 文件、秒级）
  { when: /^README\.md$/, run: ["./tests/"] },
];

/**
 * 确认**没有任何测试读取**的仓库根路径 —— 只有它们返回 `[]`（零测试）。
 *
 * 准入判据是机械的，由 `tests/scripts/affected-tests.test.ts` 执行：
 *
 *     grep -rlF '"<路径>"' tests packages/<pkg>/tests   → 零命中
 *     （排除判据自身的测试文件，它必然提到白名单项）
 *
 * 任何一条命中都说明有测试在读它，必须改成 `ROOT_FILE_TESTS` 的精确映射或走全量。
 * 2026-11-07 用这条判据实测，下面每一项都是零读取者。
 */
export const NO_TEST_PATHS: string[] = [
  "LICENSE",
  "NOTICE",
  "README.en.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  ".mailmap",
  ".git-blame-ignore-revs",
  ".editorconfig",
  ".gitattributes",
  // 团队 skill 目录：测试里出现的 `.claude/skills` 全是 tmpdir 里自造的路径，不读仓库这份
  ".claude/skills/",
];

/** 路径是否被显式登记为「零测试读取」。 */
function isNoTestPath(p: string): boolean {
  return NO_TEST_PATHS.some((n) => p === n || (n.endsWith("/") && p.startsWith(n)));
}

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

    // 其余包体量小（shared 8 文件 / eval-framework 含 judge 下 calibrate-pairwise 等 /
    // tui、cli 中等），直接整包跑，省掉一张会漂移的映射表。
    // ⚠️ eval-framework 的测试平铺在 core/ sandbox/ graders/ judge/，没有 tests/ 目录 ——
    // 整包跑才能覆盖 judge/ 搬家后的单测；空集 = 改 prompt / calibration 零验证。
    return [`./packages/${pkg}/`];
  }

  // ── 仓库根 ──────────────────────────────────────────────────────────
  for (const area of ROOT_TEST_AREAS) {
    if (area.when.test(p)) return [area.run];
  }
  for (const f of ROOT_FILE_TESTS) {
    if (f.when.test(p)) return f.run;
  }
  // scripts/ 与 tests/ 自身：跑仓库级套件
  if (p.startsWith("scripts/") || p.startsWith("tests/")) return ["./tests/"];
  // .github/workflows：由 release-flow-contract 与 slow-test-suite-split 守（都在根 tests/）
  if (p.startsWith(".github/")) return ["./tests/"];
  // 白名单：确认没有任何测试读取它，改它才真的不用跑单测
  if (isNoTestPath(p)) return [];

  // ── 兜底：全量 ───────────────────────────────────────────────────────
  // 方向必须是「宁可多跑」。返回 [] 意味着「改了它零测试且全绿」——清单漏一个文件
  // 就静默失效（X3-01）。返回 "full" 时漏登记的代价只是多跑一次，而且看得出原因。
  return "full";
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
      reason:
        changed.length === 0
          ? "无改动"
          : "改动全部落在 NO_TEST_PATHS 白名单内（已机械确认没有任何测试读取）",
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
