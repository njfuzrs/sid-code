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
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
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

/**
 * ⑯ vendor 真实字节挪进 `.vendor-src/` + symlink —— 防线的形态门禁。
 *
 * ## 治的是什么
 *
 * 一次真实事故：`git rm --cached` + `.gitignore` 之后 125 个 vendor 文件从磁盘消失。
 * 机理是 `.gitignore` 只挡「未追踪文件不被 add」，**不挡「已记录删除的文件不被
 * checkout 删掉」** —— 仓库里 37+ 个分支仍把那两个路径记为已追踪。
 *
 * 根治办法是把真实字节挪到一个**在任何 ref 里都不存在**的路径（`.vendor-src/`），
 * 规范路径只留一个 symlink。这样 checkout 能动的只有那个几十字节的链接。
 *
 * ## 为什么这些断言不是形式主义 —— 三条都是**静默**失效
 *
 * 1. `.gitignore` 的尾斜杠只匹配目录、不匹配 symlink。写成 `.../src/` 时
 *    `git check-ignore` 不命中，两个 symlink 出现在 git status 里，
 *    而**构建、测试、脚本全都照样绿** —— 唯一症状是可能被 `git add -A` 带走。
 * 2. `.vendor-src/` 一旦被某个分支入库，整条防线当场失效，同样没有任何东西报错。
 * 3. `--pack` 少了 `tar -h` 只会把 2 个 symlink 打进包（而不是 125 个文件），
 *    tar 退出码 0、sha256 算得出、上传成功 —— 下一个 fresh clone 才炸。
 *
 * ⇒ 三条的共同点：跑一次测试看绿测不出来，必须静态断言。
 */
describe("vendor 真实字节与 symlink 防线（⑯）", () => {
  const CACHE_DIR = ".vendor-src";

  test(".gitignore 用不带尾斜杠的形态，能同时挡住真目录与 symlink", () => {
    // 核心断言。用 `git check-ignore` 而不是自己解析 .gitignore ——
    // 尾斜杠"只匹配目录"这类语义只有 git 自己算得准（这正是坑 2 的成因）。
    const paths = [
      "packages/tui-renderer/src",
      "packages/cli/src/command/commands/claude-api/reference",
      CACHE_DIR,
    ];
    const notIgnored: string[] = [];
    for (const rel of paths) {
      try {
        git("check-ignore", "-q", rel);
      } catch {
        notIgnored.push(rel);
      }
    }
    expect(notIgnored).toEqual([]);

    // 形态也钉一下：带尾斜杠的旧写法必须已消失，否则 symlink 会漏出来。
    const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf-8");
    expect(gitignore).toContain("/packages/tui-renderer/src\n");
    expect(gitignore).not.toContain("/packages/tui-renderer/src/\n");
  });

  test("`.vendor-src/` 在任何 ref 里都不存在 —— 这是整条防线的机理", () => {
    // 防线成立的**唯一前提**：git 的任何 ref 都不含这个路径，于是
    // checkout / merge / reset 都不会碰它。谁把它入库一次，防线就静默失效。
    const refs = git("for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags")
      .split("\n")
      .filter(Boolean);
    expect(refs.length).toBeGreaterThan(0); // 自证：真的扫到了 ref，不是空集全绿

    const polluted: string[] = [];
    for (const ref of refs) {
      let tree = "";
      try {
        tree = execFileSync("git", ["ls-tree", "-r", "--name-only", ref], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        continue; // 个别 ref（如指向非 commit 的 tag）读不到，跳过
      }
      if (tree.split("\n").some((l) => l.startsWith(`${CACHE_DIR}/`))) polluted.push(ref);
    }
    expect(polluted).toEqual([]);
  });

  test("fetch-vendor-src.ts 的 --pack 带 -h，否则只会打包 symlink 本身", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "fetch-vendor-src.ts"), "utf-8");
    // 只在**代码**里找，不在注释里找：注释里必然出现 "-h" 与 "tar" 这些词，
    // 拿全文做断言会让"把 -h 从参数表里删掉"仍然全绿
    //（同 evals/CLAUDE.md §4.4：判据读了不该读的文本）。
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    // runTar 的参数数组里必须有独立的 "-h" 这一项
    expect(code).toMatch(/"-h",/);
    expect(code).toContain('"--format=ustar"');
  });

  test("脚本把缓存目录与 symlink 目标定在 .vendor-src/，且解包不穿过 symlink", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "fetch-vendor-src.ts"), "utf-8");
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");

    expect(code).toContain(`const CACHE_DIR = "${CACHE_DIR}"`);
    // 相对 symlink（仓库整体搬家不断）：目标由 relative() 算，不是硬编码绝对路径
    expect(code).toContain("relative(join(ROOT, dirname(rel)), cacheAbs(rel))");
    // 坑 3：tar 必须解到 stage 临时目录，不能解到 ROOT
    expect(code).toContain('runTar(["-xzf", tmp], stage)');
    expect(code).not.toContain('runTar(["-xzf", tmp], ROOT)');
  });

  test("工作区里规范路径确实是指向缓存的 symlink（本机可用性回归）", () => {
    // fresh clone / CI 上跑过 vendor:fetch 之后才有意义；没有则跳过，避免无意义地红。
    const rel = join("packages", "tui-renderer", "src");
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) return;
    if (!lstatSync(abs).isSymbolicLink()) return; // 老克隆尚未迁移，vendor:fetch 会就地迁

    expect(readlinkSync(abs)).toBe(join("..", "..", CACHE_DIR, "tui-renderer-src"));
    // 经 symlink 必须真能读到内容（空目录比不存在更危险：grep 静默返回 0 命中）
    expect(readdirSync(abs).length).toBeGreaterThan(0);
  });
});
