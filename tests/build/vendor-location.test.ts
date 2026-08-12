/**
 * vendor 位置与 ignore 锚点门禁 —— P2-3 的防复发防线。
 *
 * ## 治的是什么
 *
 * P2-3（2026-08-12）把 `vendor/ripgrep/`（4 平台二进制，18MB）从**仓库根**下沉到
 * `packages/core/vendor/`：rg 只有 core 包在用，谁用谁带（对齐 gemini-cli 的
 * `packages/core/vendor/ripgrep/`）。入库这个决定本身不变（离线优先），只动位置。
 *
 * 这次迁移有两个钩子，其中第二个是**静默**的：
 *
 * 钩子 1（显式失败，不需要门禁）：`packages/core/src/tool/rg-embedded.ts` 用相对路径
 *   `import ... with { type: "file" }` 引 rg-embed。路径错了 `bun build --compile`
 *   直接失败。注意 `bun run` / `bun test` **不会**暴露它 —— dev 模式根本不加载该模块。
 *
 * 钩子 2（静默，正是本门禁的靶子）：`.gitignore` 里 `/vendor/rg-*` 的前导 `/`
 *   把规则**锚定在仓库根**。迁移后构建物落在 `packages/core/vendor/rg-embed` 等位置，
 *   旧规则不再匹配 → 5 个构建物（21MB：darwin-arm64 3.9M / darwin-x64 4.2M /
 *   rg-embed 3.9M / linux-arm64 4.3M / linux-x64 5.2M）出现在 git status 里，
 *   且**极易被 `git add -A` 误入库**（大规模迁移时恰恰推荐用 `-A` 避免漏文件）。
 *   两条叠加就是「21MB 二进制被静默提交」。
 *
 * ## 为什么"跑一次测试看绿"测不出来
 *
 * 锚点失效不产生任何断言失败：编译照样过、测试照样绿、脚本照样跑。唯一的症状是
 * `git status` 里多了 5 个文件，而那正是最容易被 `-A` 一把带走的时刻。
 * 所以必须静态断言 ignore 规则与 vendor 实际位置对齐。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const VENDOR_DIR = join(REPO_ROOT, "packages", "core", "vendor");

/** 跑 git 命令，返回 stdout（trim 过）。 */
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

describe("vendor 位置与 ignore 锚点（P2-3）", () => {
  test("入库的 ripgrep 二进制在 packages/core/vendor/ 下，仓库根不再有 vendor/", () => {
    const inPackage = git("ls-files", "packages/core/vendor").split("\n").filter(Boolean);
    const inRoot = git("ls-files", "vendor").split("\n").filter(Boolean);

    // 4 个平台的二进制（darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64）
    expect(inPackage.length).toBe(4);
    expect(inRoot).toEqual([]);

    // 路径形态也钉一下：必须是 ripgrep/<version>/rg-<platform>
    for (const p of inPackage) {
      expect(p).toMatch(/^packages\/core\/vendor\/ripgrep\/[\d.]+\/rg-(darwin|linux)-(arm64|x64)$/);
    }
  });

  test("构建物 rg-* 被 .gitignore 挡住（锚点已随迁移更新）", () => {
    // 这是本门禁的核心断言。用 `git check-ignore` 而不是自己解析 .gitignore ——
    // 前导 `/`、`*` 通配、目录不下降这些语义只有 git 自己算得准。
    const artifacts = [
      "rg-embed",
      "rg-darwin-arm64",
      "rg-darwin-x64",
      "rg-linux-arm64",
      "rg-linux-x64",
    ];

    const notIgnored: string[] = [];
    for (const name of artifacts) {
      const rel = `packages/core/vendor/${name}`;
      try {
        // check-ignore 命中时 exit 0；未命中 exit 1 → 抛异常
        git("check-ignore", "-q", rel);
      } catch {
        notIgnored.push(rel);
      }
    }

    expect(notIgnored).toEqual([]);
  });

  test("旧的仓库根锚点仍保留（回滚/切分支时不暴露构建物）", () => {
    // 切回迁移前的提交时，根 vendor/ 会重新出现。删掉旧规则会让那 5 个构建物
    // 在旧分支上暴露出来 —— 两条规则并存的成本是零，收益是回滚安全。
    const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf-8");
    expect(gitignore).toContain("/vendor/rg-*");
    expect(gitignore).toContain("/packages/core/vendor/rg-*");
  });

  test("rg-embedded.ts 的嵌入 import 指向本包内 vendor", () => {
    // 编译期路径。这条断言不能替代 `make build`（真正的证据是编译通过），
    // 但能在改错后立刻给出可读的失败原因，而不是让人对着 bun build 的报错猜。
    const src = readFileSync(
      join(REPO_ROOT, "packages", "core", "src", "tool", "rg-embedded.ts"),
      "utf-8",
    );

    // 从 packages/core/src/tool/ 回到 packages/core/ 是两层
    expect(src).toContain('from "../../vendor/rg-embed"');
    // 迁移前的四层路径必须已消失
    expect(src).not.toContain("../../../../vendor/rg-embed");
  });

  test("fetch-ripgrep.ts 与 release.sh 的落盘路径已跟着迁移", () => {
    const fetchSrc = readFileSync(join(REPO_ROOT, "scripts", "fetch-ripgrep.ts"), "utf-8");
    expect(fetchSrc).toContain('join(ROOT, "packages", "core", "vendor")');

    const releaseSrc = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf-8");
    expect(releaseSrc).toContain('VENDOR_DIR="$ROOT/packages/core/vendor"');
    // release.sh 里不该再有指向仓库根 vendor 的运行时路径。
    // （注释里的措辞不算，所以只查带 $ROOT/ 前缀的实际路径拼接。）
    expect(releaseSrc).not.toContain('"$ROOT/vendor/');
  });

  test("工作区里的构建物确实躺在新位置（本机可用性回归）", () => {
    // 这条只在本机跑过 make build 后才有意义：fresh clone 上 vendor/rg-* 不存在。
    // 所以做成"存在则校验，不存在则跳过"，避免 CI 上无意义地红。
    if (!existsSync(VENDOR_DIR)) return;
    const entries = readdirSync(VENDOR_DIR);
    // ripgrep/ 是入库目录，必须在
    expect(entries).toContain("ripgrep");
  });
});
