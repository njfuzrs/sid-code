/**
 * scripts/ 依赖声明门禁 —— P2-2 的防复发防线。
 *
 * ## 治的是什么
 *
 * 改造前 `scripts/` 下有一棵 137MB / 153 个顶层包的 `node_modules`，而 `scripts/`
 * **没有 package.json**。它未被追踪（根 `.gitignore` 的 `node_modules/` 递归覆盖），
 * 所以这从来不是"入库问题"，是**不可复现问题**：装了什么、谁装的、什么版本，
 * 全都无从考证；新贡献者 clone 之后跑 `scripts/` 下的东西会缺依赖，
 * 且没有任何 `bun install` 能把它修回来 —— 因为没有 manifest 记录该装什么。
 *
 * 实测那 153 个包里真正被 import 的只有 3 个（yaml / glob / @anthropic-ai/sdk），
 * 且三者本就已在根 package.json 里声明、版本完全一致（2.8.2 / 13.0.6 / 0.79.0）。
 * 其余如 axios / @tavily / @babel 在 scripts 源码里零引用，是纯孤儿。
 * 所以 P2-2 的动作是「删掉孤儿树、依赖统一走根 workspace」，而不是新增一个 manifest。
 *
 * ## 为什么这需要一道门禁
 *
 * 孤儿树是这么长出来的：有人在 `scripts/` 目录里顺手跑了一次 `bun add` 或
 * `npm i`（cwd 在子目录 → 包管理器就地建 node_modules），装完脚本能跑、
 * 测试全绿、git status 干干净净（被 ignore 了），**没有任何信号**。
 * 几个月后它长到 137MB，且没人知道里面哪些是真依赖。
 *
 * 本门禁断言两件事，把这个静默过程变成一次明确的红：
 *   1. `scripts/` 下不存在自己的 node_modules / package.json / lockfile；
 *   2. `scripts/` 里 import 的每个外部包，都在根 package.json 里有声明。
 *
 * 第 2 条是真正的价值所在 —— 它同时也拦住反向的错误：有人在 scripts 里
 * import 了一个新包、靠自己本机恰好装过所以跑得通，但没写进 manifest。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

/** Node/Bun 内置模块前缀 —— 无需声明。 */
const BUILTIN = new Set([
  "bun",
  "fs",
  "path",
  "os",
  "util",
  "crypto",
  "process",
  "child_process",
  "url",
  "events",
  "stream",
  "readline",
  "zlib",
  "http",
  "https",
  "net",
  "tty",
  "assert",
  "buffer",
  "worker_threads",
  "perf_hooks",
  "string_decoder",
  "timers",
  "v8",
  "vm",
]);

/**
 * 工作区内部包 —— 由根 package.json 的 workspaces 字段解析，不算外部依赖。
 * `eval-framework` 是 workspace 包（devDependencies 里写着 workspace:*）。
 */
const WORKSPACE_PREFIXES = ["@sid-code/", "eval-framework"];

/** 递归收集 scripts/ 下的 .ts 文件（跳过任何 node_modules）。 */
function collectScripts(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectScripts(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * 剥掉注释后再抽 import —— 这一步不是洁癖，是实测必需。
 *
 * `scripts/pkg-boundary-scan.ts` 本身是个「扫描 import 的扫描器」，它的注释里
 * 引用了大量 import 语法示例（`from "spec"`、`import("x")`、`from 'ink'`）。
 * 不剥注释就会把 spec / x / ink 三个**不存在的包**当成真依赖上报 ——
 * 门禁一上线就红，而且红得毫无道理，最后必然被人加白名单绕过。
 *
 * 只做行注释与块注释的粗剥，够用：目标是让「注释里的示例代码」不被当成真 import，
 * 不需要完整 JS 词法分析。字符串里含 `//` 的情况（如 URL）会被误剥一部分内容，
 * 但那只可能让我们**少**认出 import，不会多认出 —— 而少认的风险由下方
 * `used.length` 与 files.length 的防空转断言兜住。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * 从源码里抠出外部包说明符。
 *
 * 覆盖三种形态：静态 `from "x"`、副作用 `import "x"`、动态 `import("x")`。
 * 相对路径（./ ../）与内置模块（含 node: 前缀）直接排除；
 * 作用域包取前两段（@scope/name），普通包取第一段（pkg/sub → pkg）。
 */
function externalSpecifiers(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];

  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf-8"));
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const raw = m[1];
        if (raw.startsWith(".") || raw.startsWith("/")) continue;
        if (raw.startsWith("node:")) continue;
        if (BUILTIN.has(raw)) continue;
        if (WORKSPACE_PREFIXES.some((p) => raw.startsWith(p))) continue;

        const pkg = raw.startsWith("@") ? raw.split("/").slice(0, 2).join("/") : raw.split("/")[0];
        if (BUILTIN.has(pkg)) continue;
        if (WORKSPACE_PREFIXES.some((p) => pkg.startsWith(p))) continue;

        const users = found.get(pkg) ?? [];
        const rel = file.slice(REPO_ROOT.length + 1);
        if (!users.includes(rel)) users.push(rel);
        found.set(pkg, users);
      }
    }
  }
  return found;
}

describe("scripts/ 依赖声明门禁（P2-2）", () => {
  test("scripts/ 下不得有自己的 node_modules / package.json / lockfile", () => {
    // 这三样任何一个出现，都意味着有人把 cwd 放在 scripts/ 跑了包管理器，
    // 或者有人想把 scripts/ 做成独立包 —— 后者已在 P2-2 裁决里明确否掉
    // （scripts/ 不是发布单元，做成包语义别扭，且多一棵依赖树要维护）。
    const forbidden = [
      "node_modules",
      "package.json",
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "yarn.lock",
    ];
    const present = forbidden.filter((name) => existsSync(join(SCRIPTS_DIR, name)));

    expect(present).toEqual([]);
  });

  test("scripts/ import 的每个外部包都在根 package.json 里声明", () => {
    const files = collectScripts(SCRIPTS_DIR);
    // 防空转：脚本目录本来有 70+ 个 .ts，收集器要是因为路径写错返回空，
    // 下面的断言会恒真。这一条守的是"门禁自己没瘸"。
    expect(files.length).toBeGreaterThan(50);

    const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    const declared = new Set([
      ...Object.keys(rootPkg.dependencies ?? {}),
      ...Object.keys(rootPkg.devDependencies ?? {}),
      ...Object.keys(rootPkg.peerDependencies ?? {}),
      ...Object.keys(rootPkg.optionalDependencies ?? {}),
    ]);

    const used = externalSpecifiers(files);
    const missing = [...used.entries()]
      .filter(([pkg]) => !declared.has(pkg))
      .map(([pkg, users]) => `${pkg}（被 ${users.slice(0, 3).join(", ")} 引用）`);

    expect(missing).toEqual([]);
  });

  test("根 node_modules 里能解析到 scripts/ 用的外部包", () => {
    // 上一条只验"声明了"，这一条验"装得上"。两者都要：
    // 声明了但装不上（比如平台二进制走 optionalDependencies 而 CI 带 --omit=optional，
    // 见 .oxlintrc.json 里 oxlint 的同款教训）同样会让脚本在 CI 上炸。
    const files = collectScripts(SCRIPTS_DIR);
    const used = [...externalSpecifiers(files).keys()];
    expect(used.length).toBeGreaterThan(0);

    const unresolvable = used.filter((pkg) => {
      const dir = join(REPO_ROOT, "node_modules", pkg);
      return !existsSync(dir) || !statSync(dir).isDirectory();
    });

    expect(unresolvable).toEqual([]);
  });
});
