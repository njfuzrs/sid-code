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

/**
 * GitHub Release 这一步 2026-08-21 才补进流程 —— 在此之前它**根本不存在**：
 * 仓库里 v0.1.591…v0.1.600 那 10 个 Release 全部创建于 2026-08-13T02:22 那两分钟内
 * （开源首发时一次性人工回填），之后每次发版 tag 都推了、Release 却没人建。
 * 而 GitHub 仓库首页把最新 Release 当作「当前版本」展示，于是页面长期停在一个旧版本 ——
 * **没有任何报错，只是页面上的版本号不对**，这类缺口只能靠断言防复发。
 */
describe("release.sh：建 GitHub Release（2026-08-21 补的流程缺口）", () => {
  test("--upload 路径会调 github-release.ts", () => {
    expect(RELEASE_SH).toContain("scripts/github-release.ts");
    expect(RELEASE_SH).toMatch(/github-release\.ts["']?\s+"\$VERSION"\s+--create/);
  });

  test("建 Release 在 push tag 之后（Release 挂在 tag 上，tag 不在远端时 gh 会自建错的）", () => {
    const pushTagPos = posOf('git push origin "$TAG"');
    // ⚠ 不能用 posOf("scripts/github-release.ts") —— 文件头注释里也提到了这个路径，
    // 那处偏移远小于 push tag 的位置，断言会假红。锚在**可执行调用**的形态上。
    const releasePos = posOf("--create \\");
    expect(pushTagPos).toBeGreaterThan(0);
    expect(releasePos).toBeGreaterThan(pushTagPos);
  });

  test("未装 gh 或建失败都不阻断发布（制品此刻已上线且校验过）", () => {
    // 两条兜底都要在：command -v gh 的存在性检查，以及失败时的 warn 而非 fail
    expect(RELEASE_SH).toMatch(/command -v gh/);
    const seg = RELEASE_SH.slice(posOf("建 GitHub Release"));
    expect(seg).toMatch(/\|\|\s*warn/);
    // 反向断言：这一段里不许出现 fail —— 用 fail 会让一个没建成的 Release 页
    // 把整次发布判定为失败，而制品其实已经好了
    expect(seg.slice(0, 900)).not.toMatch(/\|\|\s*fail/);
  });
});

describe("github-release.ts：正文取自 curated，且不建错 tag", () => {
  const GH_RELEASE = readFileSync(join(ROOT, "scripts/github-release.ts"), "utf8");

  test("读 curated 文案而不是 CHANGELOG.md（Release 页读者是用户，与官网同源）", () => {
    expect(GH_RELEASE).toContain("changelog/curated");
    expect(GH_RELEASE).toContain("toRenderSections");
    // CHANGELOG.md 是全量原始提交（含 hash、docs 分组），不该是 Release 正文的源
    expect(GH_RELEASE).not.toMatch(/readFileSync\([^)]*CHANGELOG\.md/);
  });

  test("建 Release 前校验远端 tag 存在（否则 gh 自建指向默认分支 HEAD 的 tag 且不报错）", () => {
    expect(GH_RELEASE).toMatch(/git\/ref\/tags/);
  });

  test("已存在时幂等跳过，不是报错（release.sh 可能被重跑）", () => {
    expect(GH_RELEASE).toContain("releaseExists");
    expect(GH_RELEASE).toMatch(/已存在，跳过/);
  });

  test("不上传制品附件（制品在自建服务器，两处都放会出现双轨）", () => {
    // 现有 10 个 Release 的 assets 都是 0 个，保持一致
    expect(GH_RELEASE).not.toMatch(/release["'\s,\]]+upload/);
    expect(GH_RELEASE).not.toMatch(/\.tar\.gz/);
  });

  test("curated 缺失/不合规时什么都不建（空正文的 Release 比不建更糟）", () => {
    expect(GH_RELEASE).toMatch(/if \(!entry\) process\.exit\(1\)/);
  });
});

/**
 * 发布流程与分支保护的冲突（2026-08-21 裁决）。
 *
 * CLAUDE.md 的铁律写「先提交再发布」，标准顺序最后一步是 `git push`。但 main 受
 * ruleset `protect-main` 保护（PR + all-checks-passed），直推被 **GH013** 拒。
 * 撞上时的状态是：**制品已上线、tag 已推送、bump 提交还在本地** —— 正是铁律要防的
 * 「已发布但未提交」窗口，只不过成因从人的疏忽变成了门禁冲突。
 *
 * 裁决：**改文档 + 脚本给出能跑通的指引**，不开 ruleset bypass（bypass 是给人/应用
 * 开的口子而非给某个提交，开了任何直推都能绕过汇聚门，而全量 CI 与 GitHub Release
 * 都挂在那道门上）。
 */
describe("发布流程 ↔ 分支保护冲突（2026-08-21 裁决）", () => {
  const CLAUDE_MD = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");

  test("CLAUDE.md 的收尾步骤不再是裸 git push（那条命令在本仓必然被 GH013 拒）", () => {
    // 取「发布上线」到下一个二级标题之间那段
    const seg = CLAUDE_MD.slice(CLAUDE_MD.indexOf("### 发布上线"));
    const body = seg.slice(0, seg.indexOf("#### Changelog"));
    expect(body).toContain("GH013");
    expect(body).toMatch(/gh pr (create|merge)/);
    // 反向断言：不许再出现「独占一行的 git push」作为收尾指引
    expect(body).not.toMatch(/^git push\s*$/m);
  });

  test("文档写明必须 merge 不能 squash（tag 已打在 bump 提交上）", () => {
    const seg = CLAUDE_MD.slice(CLAUDE_MD.indexOf("### 发布上线"));
    const body = seg.slice(0, seg.indexOf("#### Changelog"));
    expect(body).toMatch(/squash/i);
    expect(body).toContain("--merge");
    // 必须给出可核验的判据，而不是只写一句"要用 merge"
    expect(body).toContain("merge-base --is-ancestor");
  });

  test("release.sh 收尾指引提到保护与 PR 路径（不让人先撞一次 GH013）", () => {
    const seg = RELEASE_SH.slice(posOf("官网 /changelog 是站点构建期快照"));
    expect(seg).toMatch(/protect-main|GH013/);
    expect(seg).toMatch(/gh pr create/);
    expect(seg).toMatch(/--merge/);
  });

  test("文档说明 northstar/ 是要求入库的产物，不是脏数据", () => {
    const seg = CLAUDE_MD.slice(CLAUDE_MD.indexOf("### 发布上线"));
    const body = seg.slice(0, seg.indexOf("#### Changelog"));
    expect(body).toContain("northstar/");
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

  // 2026-08-19 实测事故（PR #66，run 32229207101）：ubuntu runner 上
  // `sudo apt-get update -qq && sudo apt-get install -y -qq ripgrep` 挂死 25 分 12 秒，
  // 撞爆 job 的 timeout-minutes: 25。后果不是「装 rg 慢了」而是**全量单测一次都没跑到**，
  // PR 上只留一个 canceled；同 run 的 macOS 腿正常、前三次 run 的 ubuntu 腿都 ~160s，
  // 所以它是 runner 侧网络/apt 锁 flake。
  //
  // 修法是把网络依赖整个拿掉：仓内已提交 4 平台预编译 rg，改成本地 copy + 挂 PATH。
  // 这几条断言守的是「别退回去」—— 退回联网装的代价是一个极难归因的偶发 canceled，
  // 而且它长得不像失败（没有红叉指向任何一条测试）。
  describe("rg 准备步骤不得依赖网络（否则偶发挂死会撞爆 job 超时）", () => {
    // 否定式断言必须只看**可执行内容**：本文件注释密度极高，且刻意在注释里复述了
    // 被废弃的旧命令（「以前是 apt-get install ripgrep，为什么不能退回去」）。
    // 直接扫全文会把这类记录教训的散文误判成配置本身 —— 那等于逼人删掉注释才能过门禁。
    const CI_CODE = CI.split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");

    test("不得用包管理器装 ripgrep", () => {
      // 只拦「装 ripgrep」这件事，不拦 apt/brew 本身——将来可能有别的合理用途。
      expect(CI_CODE).not.toMatch(/apt-get\s+install[^\n]*ripgrep/);
      expect(CI_CODE).not.toMatch(/brew\s+install[^\n]*ripgrep/);
    });

    test("从仓内 vendor 目录取产物，且版本号不硬编码", () => {
      expect(CI_CODE).toMatch(/packages\/core\/vendor\/ripgrep\//);
      // 版本号走 fetch-ripgrep.ts --print-version（与 release.sh 同一取数口径）。
      // 硬编码的话 DEFAULT_RG_VERSION 一 bump，这里就静默指向不存在的目录。
      expect(CI_CODE).toMatch(/fetch-ripgrep\.ts\s+--print-version/);
      expect(CI_CODE).not.toMatch(/vendor\/ripgrep\/\d+\.\d+\.\d+/);
    });

    test("产物缺失时硬失败，不回落到包管理器", () => {
      // 回落 = 把刚拿掉的挂死风险请回来，且「vendor 少提交一个平台」这种事会被藏起来。
      expect(CI).toMatch(/::error::仓内缺少/);
    });

    test("rg 步骤排在全量单测之前（否则测试起手就 rg not found）", () => {
      const rgPos = CI.indexOf("挂载仓内 ripgrep 到 PATH");
      const testPos = CI.search(/run:\s*bun test\s*$/m);
      expect(rgPos).toBeGreaterThan(0);
      expect(testPos).toBeGreaterThan(0);
      expect(rgPos).toBeLessThan(testPos);
    });

    test("该步骤依赖 bun，必须排在 Setup Bun 之后", () => {
      // --print-version 是 bun 跑的；顺序颠倒就是 `bun: command not found`。
      const bunPos = CI.indexOf("oven-sh/setup-bun");
      const rgPos = CI.indexOf("挂载仓内 ripgrep 到 PATH");
      expect(bunPos).toBeGreaterThan(0);
      expect(bunPos).toBeLessThan(rgPos);
    });
  });

  // ── 汇聚门 all-checks-passed（2026-08-19 接入）───────────────────────────────────
  //
  // ruleset protect-main 的必需检查从三个具体 job 名换成了这一个汇聚 job。
  // 这组断言守的是**它不会静默变成假绿**——这道门禁的三种失效方式全都不报红：
  //   ① 新增 job 忘了加进 needs → 新 job 红了，汇聚门照样绿
  //   ② 丢掉 if: always() → 上游失败时本 job 变 skipped，而 GitHub 把 skipped 的
  //      必需检查算作**通过**
  //   ③ 判据写成「全部 == success」→ 将来任何带 if 条件的 job 被跳过就整体卡死
  describe("汇聚门 all-checks-passed 不得静默变成假绿", () => {
    /** 解析后的 jobs 映射；YAML 1.1 会把裸 `on` 当布尔真键，这里只取 jobs 不受影响。 */
    function jobsOf(): Record<string, Record<string, unknown>> {
      const doc = parseYaml(CI) as Record<string, unknown>;
      return doc.jobs as Record<string, Record<string, unknown>>;
    }

    test("汇聚 job 存在", () => {
      expect(Object.keys(jobsOf())).toContain("all-checks-passed");
    });

    // 这是本组最重要的一条：它把「ruleset 只绑一个检查」这个决定，
    // 与「所有 job 都真的被那个检查覆盖」这件事机械地绑在一起。
    // 没有它，加一个 job 就等于开了一个绕过分支保护的后门，且 PR 页面一片绿。
    test("needs 覆盖除自己以外的全部 job（新增 job 忘了登记即判红）", () => {
      const jobs = jobsOf();
      const needs = jobs["all-checks-passed"]?.needs as string[] | undefined;
      expect(Array.isArray(needs)).toBe(true);

      const others = Object.keys(jobs)
        .filter((k) => k !== "all-checks-passed")
        .sort();
      expect([...(needs as string[])].sort()).toEqual(others);
    });

    test("if: always() 在（skipped 的必需检查会被算作通过）", () => {
      expect(jobsOf()["all-checks-passed"]?.if).toBe("always()");
    });

    test("判据看 failure/cancelled，不看「全部 success」", () => {
      const steps = jobsOf()["all-checks-passed"]?.steps as Array<Record<string, string>>;
      const script = steps.map((s) => s.run ?? "").join("\n");
      expect(script).toContain("contains(needs.*.result, 'failure')");
      expect(script).toContain("contains(needs.*.result, 'cancelled')");
      expect(script).toMatch(/exit 1/);
    });
  });

  // ── 合并队列（2026-08-19 接入）─────────────────────────────────────────────────
  //
  // 队列解决的是 PR 级门禁**测不到**的一类失败：两个 PR 各自对着自己的 base 绿了，
  // 合到一起却红（git 无冲突但语义冲突）。并行开发时这是必然而非偶发。
  describe("合并队列触发与不取消", () => {
    test("merge_group 在 on 里", () => {
      const doc = parseYaml(CI) as Record<string, unknown>;
      const on = (doc.on ?? doc[true as unknown as keyof typeof doc]) as Record<string, unknown>;
      expect(Object.keys(on)).toContain("merge_group");
    });

    // merge_group 的 run 是「合并后状态」的唯一验证结论，取消掉就拿不到判据，
    // 表现为 PR 莫名其妙地入队又被弹出——这个现象不长得像 CI 配置问题。
    test("cancel-in-progress 对 merge_group 关闭", () => {
      const doc = parseYaml(CI) as Record<string, unknown>;
      const cancel = (doc.concurrency as Record<string, unknown>)?.["cancel-in-progress"];
      // 断言表达式而非布尔：写死 true/false 都会让 merge_group 走错分支。
      expect(String(cancel)).toContain("merge_group");
    });
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

  // ── 2026-08-19：合并方式与必需检查一起改了，文档里的对应描述必须跟着走 ──────────
  //
  // 这三条锁的是「文档说的合并机制 == 仓库实际配置」。它们不查 GitHub API（单测必须
  // 离线且确定性），改锁**文档内部自洽 + 与本仓代码自洽**：
  // 文档说 changelog 走 --first-parent，那 scripts/ 里就必须真的是它。
  test("不得再声称用 squash merge（已改为默认 merge commit）", () => {
    // 允许提到 squash（「squash 仍然允许」是事实），但不许出现「用 squash merge」这个规定式说法
    expect(CONTRIBUTING).not.toMatch(/用\s*\*\*squash merge\*\*/);
    // 正向：必须写明默认 merge commit
    expect(CONTRIBUTING).toMatch(/默认用 merge commit/);
  });

  test("必需检查的描述与汇聚门一致（不得再列三个具体 job 名当必需检查）", () => {
    expect(CONTRIBUTING).toContain("all-checks-passed");
    // 文档里仍可以复述那次事故（「事故当时绑的是三个 job 名」），但不许把它写成**现状要求**。
    // 判据：「要求的三个检查」这个现在时说法必须消失。
    expect(CONTRIBUTING).not.toMatch(/要求的三个检查/);
  });

  test("文档说 changelog 走 --first-parent，代码里就必须是（跨文件自洽）", () => {
    expect(CONTRIBUTING).toContain("--first-parent");
    const lib = readFileSync(join(ROOT, "scripts/lib/changelog-git.ts"), "utf8");
    expect(lib).toMatch(/HISTORY_WALK_FLAG\s*=\s*"--first-parent"/);
  });

  // PR 标题会成为 merge commit 的 subject，这个链条依赖仓库设置 merge_commit_title=PR_TITLE。
  // 设置本身查不到（离线），但能锁住文档把这个依赖**写出来**——它是隐式契约里最容易被忘的一环：
  // 默认值 MERGE_MESSAGE 会生成 "Merge pull request #N from ..."，不合 Conventional Commits。
  test("文档点明了 merge_commit_title=PR_TITLE 这个隐式依赖", () => {
    expect(CONTRIBUTING).toContain("merge_commit_title");
    expect(CONTRIBUTING).toContain("PR_TITLE");
  });

  // ⚠️ 这条锁的是一处**已经写错过一次**的表述：strict 必需检查策略被写成
  // 「保证 CI 跑的是合并后的内容」——那是合并队列的能力，strict 做不到。
  // 两个 PR 都通过 strict 后先后合入时，后合那个的 CI 结论仍然是合并前的。
  // 把 strict 当队列的替代品会让人放心地并行开多路，而语义冲突在本仓
  // **没有合并前的机制对策**（队列在个人账户仓库开不了，422）。
  // 失效形态是**假安全**：什么都不会红，直到某次合起来炸在 main 上。
  test("不得声称 strict 策略等价于合并队列（它保证不了「合并后的内容」）", () => {
    expect(CONTRIBUTING).not.toMatch(/strict[^\n]*保证 CI 跑的是合并后的内容/);
    // 正向：必须写明两者不等价
    expect(CONTRIBUTING).toMatch(/strict 不等价于队列/);
  });

  test("ci.yml 里的 merge_group 注释必须说明它当前开不了（否则读者以为队列在生效）", () => {
    // 本 describe 的作用域里没有 CI 常量（它在上一个 describe 里），就地读。
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/本仓目前开不了队列/);
    expect(ci).toContain("Invalid rule 'merge_queue'");
  });

  // 新拆分判据（2026-08-19）：旧规则「互不依赖的缺陷各自一个 PR」被读成「必须各自一个」，
  // 实测在 11 个缺陷的方案上产出 13 个 PR。这条锁住旧措辞不回来。
  test("拆分判据已换成「可独立上线/回滚/一次 review」，旧措辞不得复现", () => {
    expect(CONTRIBUTING).not.toMatch(/\*\*互不依赖的缺陷各自一个 PR\*\*/);
    expect(CONTRIBUTING).toMatch(/能独立上线/);
    expect(CONTRIBUTING).toMatch(/能独立回滚/);
    expect(CONTRIBUTING).toMatch(/能一次 review 完/);
  });
});
