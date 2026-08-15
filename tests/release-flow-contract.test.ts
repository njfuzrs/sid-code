/**
 * 发布流程契约的反漂移测试（2026-08-01）。
 *
 * 这些断言对应一次审计里查出的真实缺陷，每条都有过实测证据：
 *
 *   ① tag 错位一位：旧流程把 tag 打在 bump **之前**的 HEAD 上、bump 提交留给人事后补，
 *      导致 tag 指向的 commit 里 package.json 版本号比 tag 低一位。实测 v0.1.591…v0.1.596
 *      六个 tag 无一例外全错，`git checkout <tag>` 重建不出对应二进制——CLAUDE.md §1
 *      "产物必须能对应确切 commit"的铁律被架空。
 *   ② 失败即烧版本号：bump 跑在最前面，而最易失败的几步（4 次交叉编译、冒烟、自检、scp）
 *      都在其后，且全脚本零 trap。中途失败留下已 +1 的 package.json，重跑再 +1。
 *   ③ 上传非原子：逐个 scp 进正式版本目录，中途失败留下只含部分平台的半成品目录。
 *   ④ 工作区脏也能发布：铁律只写在文档里，没有任何机械化门禁。
 *
 * 断言的是**结构性属性**（顺序、trap 存在、参数存在），不是文案——文案会随时改写，
 * 而这些结构一旦退回去，上面四个缺陷立刻复活，且失败现场都极难归因。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..");
const RELEASE_SH = readFileSync(join(ROOT, "scripts/release.sh"), "utf8");

/** 取某段代码在文件中的首次出现位置；找不到则 -1。用于顺序断言。 */
function posOf(needle: string): number {
  return RELEASE_SH.indexOf(needle);
}

describe("release.sh：失败回滚（缺陷②）", () => {
  test("装了 EXIT trap", () => {
    expect(RELEASE_SH).toMatch(/trap\s+on_exit\s+EXIT/);
  });

  test("trap 注册在 bump-version 调用之前（否则早期失败不受保护）", () => {
    const trapPos = posOf("trap on_exit EXIT");
    const bumpPos = posOf("bun run scripts/bump-version.ts");
    expect(trapPos).toBeGreaterThan(0);
    expect(bumpPos).toBeGreaterThan(0);
    expect(trapPos).toBeLessThan(bumpPos);
  });

  test("package.json 与 changelog 产物都登记进回滚清单", () => {
    expect(RELEASE_SH).toContain('track_for_rollback "package.json"');
    for (const f of ["CHANGELOG.md", "website/.vitepress/data/changelog.json"]) {
      expect(RELEASE_SH).toContain(f);
    }
  });

  test("回滚只作用于运行前 clean 的文件（不吃掉用户改动）", () => {
    // track_for_rollback 必须用 git status --porcelain 判定后才登记
    expect(RELEASE_SH).toMatch(/track_for_rollback\(\)\s*\{[\s\S]*?git status --porcelain/);
  });
});

describe("release.sh：tag 与源码版本号对齐（缺陷①）", () => {
  test("提交 bump 的逻辑存在", () => {
    expect(RELEASE_SH).toMatch(/git commit -q -m "bump \$\{TAG\}"/);
  });

  test("bump 提交发生在 tag 创建之前（tag 才能指向含新版本号的 commit）", () => {
    const commitPos = posOf('git commit -q -m "bump ${TAG}"');
    const tagPos = posOf('git tag -a "$TAG"');
    expect(commitPos).toBeGreaterThan(0);
    expect(tagPos).toBeGreaterThan(0);
    expect(commitPos).toBeLessThan(tagPos);
  });

  test("tag 创建发生在构建与冒烟之后（失败不该留下提交和 tag）", () => {
    const buildPos = posOf("bun build --compile");
    const tagPos = posOf('git tag -a "$TAG"');
    expect(buildPos).toBeGreaterThan(0);
    expect(tagPos).toBeGreaterThan(buildPos);
  });

  test("打完 tag 当场校验 tag ↔ package.json 版本号对齐", () => {
    expect(RELEASE_SH).toContain('git show "$TAG:package.json"');
  });

  test("自动提交只 add 白名单文件，绝不 git add -A", () => {
    expect(RELEASE_SH).toContain("RELEASE_COMMIT_FILES=(");
    // 只看实义代码行：注释里会引用 `git add -A` 来说明"绝不这么干"，不该被误判
    const code = RELEASE_SH.split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/git add\s+-A/);
    expect(code).not.toMatch(/git add\s+\.\s*$/m);
  });
});

describe("release.sh：上传原子性（缺陷③）", () => {
  test("先传进 .upload- 临时目录，而不是直接写正式版本目录", () => {
    expect(RELEASE_SH).toContain(".upload-");
    expect(RELEASE_SH).toMatch(/_remote_staging=/);
  });

  test("落地前在服务器端校验 sha256", () => {
    expect(RELEASE_SH).toMatch(/sha256sum -c|shasum -a 256 -c/);
  });

  test("失败时清理远端半成品目录", () => {
    expect(RELEASE_SH).toContain("_cleanup_remote_staging");
  });

  test("latest.txt 仍在版本目录切换之后上传（指向的版本必须已完整）", () => {
    const swapPos = posOf("原子切换到");
    const latestPos = posOf('latest.txt" "${DEPLOY_SSH_USER}');
    expect(swapPos).toBeGreaterThan(0);
    expect(latestPos).toBeGreaterThan(swapPos);
  });
});

describe("release.sh：工作区洁净门禁（缺陷④）", () => {
  test("支持 --allow-dirty，且默认为 false", () => {
    expect(RELEASE_SH).toContain("--allow-dirty");
    expect(RELEASE_SH).toMatch(/ALLOW_DIRTY=false/);
  });

  test("门禁在 bump 之前（bump 自己会让工作区变脏）", () => {
    const gatePos = posOf('if [ "$ALLOW_DIRTY" = false ]');
    const bumpPos = posOf("bun run scripts/bump-version.ts");
    expect(gatePos).toBeGreaterThan(0);
    expect(gatePos).toBeLessThan(bumpPos);
  });
});

describe("release.sh：macOS bash 3.2 兼容（回滚逻辑不能自己崩）", () => {
  // 这两条不是洁癖，是实测踩到的：演练回滚时脚本报 `code）: unbound variable` 直接崩掉，
  // 回滚一行没执行。macOS 自带 bash 3.2 有两个 `set -u` 下的致命行为：
  //   ① 裸 $var 紧跟**全角字符**时，多字节字节被吞进变量名（`$code）` → 变量名 "code）"）
  //   ② 展开空数组 "${arr[@]}" 直接 unbound variable（bash 4.4+ 才修）
  // 两者都恰好会在"失败回滚"这条最需要可靠的路径上触发。

  const codeLines = RELEASE_SH.split("\n").filter((l) => !l.trim().startsWith("#"));

  test("没有裸 $var 紧跟全角字符（必须写成 ${var}）", () => {
    // 匹配 $name 后紧跟一个非 ASCII 且非 { 的字符
    const bad = codeLines.filter((l) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(l));
    expect(bad).toEqual([]);
  });

  test("数组展开前都有长度守卫", () => {
    // 本脚本里会被展开的数组：_to_commit 是唯一可能为空的那个
    const expandsToCommit = codeLines.some((l) => l.includes('"${_to_commit[@]}"'));
    if (expandsToCommit) {
      expect(RELEASE_SH).toMatch(/\[ \$\{#_to_commit\[@\]\} -eq 0 \]/);
    }
  });
});

describe("fetch-ripgrep.ts：嵌入路径不继承脏值（跨命令平台污染）", () => {
  const FETCH_RG = readFileSync(join(ROOT, "scripts/fetch-ripgrep.ts"), "utf8");

  test("失败兜底无条件截断为 0 字节，而非仅在文件缺失时写入", () => {
    // 旧写法 `if (!existsSync(embedPath))` 会让上次 release.sh 循环残留的
    // linux-arm64 二进制存活下来，被嵌进 mac 产物后静默降级——极难发现。
    expect(FETCH_RG).not.toMatch(/if\s*\(!existsSync\(embedPath\)\)\s*\{\s*await mkdir/);
    expect(FETCH_RG).toMatch(/hadStale/);
  });
});

describe("CI 门禁存在（全量单测前移到 PR 阶段）", () => {
  const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

  test("PR 与 push 都触发", () => {
    expect(CI).toMatch(/pull_request:/);
    expect(CI).toMatch(/push:/);
  });

  test("跑全量 bun test 与 make build", () => {
    expect(CI).toMatch(/run:\s*bun test\s*$/m);
    expect(CI).toMatch(/run:\s*make build\s*$/m);
  });

  // 2026-08-15 实测事故（PR #31）：stacked PR 的 base 从「PR A 的分支」被 GitHub 自动
  // 改成 main 时，发出的是 pull_request 的 `edited` action。而 types 的**默认值**是
  // `[opened, synchronize, reopened]`，不含 `edited` —— 于是 base 合规之后 CI 依然不跑，
  // 且此后没有任何事件能触发它。ruleset protect-main 要求的三个检查全部由本文件产出，
  // 一个 run 都没有 → 三个检查恒 pending → PR 永久 BLOCKED，且**不报红只转圈**。
  //
  // 这里刻意**解析 YAML** 而不是拿正则扫文本：`types:` 在本文件里可能出现在任何位置
  // （另一个 trigger、甚至注释里），只有解析后按 `on.pull_request.types` 取值才能确认
  // 它真的挂在 pull_request 上、而不是碰巧在文件里出现过这个词。
  test("pull_request 显式含 edited（否则 stacked PR 改 base 后永久卡死）", () => {
    const doc = parseYaml(CI) as Record<string, unknown>;
    // YAML 1.1 把裸 `on` 解析成布尔真键；两种取法都留着，避免解析器行为变化时静默失效。
    const on = (doc.on ?? doc[true as unknown as keyof typeof doc]) as Record<string, unknown>;
    expect(on).toBeDefined();

    const pr = on.pull_request as Record<string, unknown>;
    expect(pr).toBeDefined();

    const types = pr.types as string[] | undefined;
    // 断言「显式列出」而非「不含 edited 就行」：省掉 types 会落到不含 edited 的默认值上，
    // 那正是本次事故的成因，所以缺失必须判红。
    expect(Array.isArray(types)).toBe(true);
    expect(types).toContain("edited");
    // 补上默认三项：显式写了 types 就会**整体覆盖**默认值，漏一个等于关掉一类触发。
    expect(types).toContain("opened");
    expect(types).toContain("synchronize");
    expect(types).toContain("reopened");
  });
});

// 2026-08-15 顺带查出的文档漂移：CONTRIBUTING.md「不要直接 push 到 main」那节，
// 第一条理由原文是「直推绕过 PR，就绕过了 `eval-pr-smoke.yml`（只在 `pull_request` 触发）」，
// 而该文件的 `on:` 里**只有 `workflow_dispatch`**（cron 与 pull_request 都被注释掉了）。
// 也就是说这条论据引用了一个不存在的 trigger。
//
// 为什么值得立门禁而不是改完了事：这类「文档断言某个 workflow 在某事件上触发」的说法，
// 一旦 workflow 的 `on:` 被改（本仓已经因为「首发时 secret 未配」注释掉过好几个 trigger），
// 文档不会跟着变，而读者会照着它做决策 —— 与 `website/ref/` 立 `--check` 门禁同一个理由：
// **源码改了不同步就是文档骗人**。
describe("CONTRIBUTING 对 workflow 触发条件的断言不漂移", () => {
  const CONTRIBUTING = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");

  /** 读某个 workflow 的 `on:` 键集合（YAML 1.1 会把裸 `on` 解析成布尔真键）。 */
  function triggersOf(file: string): string[] {
    const doc = parseYaml(readFileSync(join(ROOT, ".github/workflows", file), "utf8")) as Record<
      string,
      unknown
    >;
    const on = (doc.on ?? doc[true as unknown as keyof typeof doc]) as Record<string, unknown>;
    return Object.keys(on ?? {});
  }

  test("不得声称 eval-pr-smoke.yml 在 pull_request 上触发（它只有 workflow_dispatch）", () => {
    // 先锁住事实：这条断言的前提是该文件确实没有 pull_request trigger。
    // 哪天真给它接上了 pull_request，这里会先红——提醒同步放开下面那条文档断言。
    expect(triggersOf("eval-pr-smoke.yml")).not.toContain("pull_request");

    // 再锁文档：不得出现「eval-pr-smoke + 只在 pull_request 触发」这个组合说法。
    const claim = /eval-pr-smoke[^\n]*只在\s*`?pull_request`?\s*触发/;
    expect(CONTRIBUTING).not.toMatch(claim);
  });

  test("ci.yml 确实在 pull_request 与 push 上触发（文档据此劝人别直推）", () => {
    // 这条是正向的：文档说「ci.yml 虽然 push 也会跑，但那时代码已经在 main 上了」，
    // 该论据依赖两个 trigger 都真实存在。
    const t = triggersOf("ci.yml");
    expect(t).toContain("pull_request");
    expect(t).toContain("push");
  });
});
