/**
 * `[slow]` 套件拆分的反漂移门禁（2026-08-18，P0-1 提速随手立的）。
 *
 * 背景：全量 `bun test` 曾 202.87s，其中 51% 耗在 `llm` + `agent` 两个目录的少数
 * 文件上，且几乎全是真 sleep（user 时间只有 24.99s）。逐条实测后，绝大多数能靠
 * 「等比缩放 / 补参数 / 缩小夹具」修掉，剩下 4 条受源码硬编码常量地板约束
 * （MIN_COOLDOWN_MS=500 / COOLDOWN_STAGGER_MS=300 / heartbeatMs=10_000）——
 * 缩放实测零收益，只能标 `[slow]` 让本地默认跳过。
 *
 * 这个拆分有一个**危险的失败模式**，本文件就是为它存在的：
 * `package.json` 的 `test` 脚本现在带 `--test-name-pattern` 排除 `[slow]`。
 * 如果 CI 也跟着改成 `bun run test`，那 4 条 case 就**一条门禁都没有了** ——
 * 它们不会报错、不会变红，只是永远不再运行。这正是本仓反复出现的
 * 「建好未接线」病灶（见 CLAUDE.md：能力已实现 ≠ 能力已生效）。
 *
 * 所以断言的是结构性属性：本地脚本会跳过、CI 与发布门禁一定跑全量。
 *
 * ⚠️ 本文件的 describe / test **名字里刻意不含 `[slow]` 字面量**（改用"慢标记"三字）。
 * 第一版含了，结果这 6 条断言自己被 `--test-name-pattern` 过滤掉、在本地默认套件里
 * 一条都不跑（实测 `skipping 6 tests`）—— 守卫自己成了它要防的那种死测试。
 * 判断标记数量一律靠**读文件正文**，不靠测试名。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const RELEASE_SH = readFileSync(join(ROOT, "scripts/release.sh"), "utf8");

describe("慢测试拆分：本地快通道", () => {
  test("test 脚本排除慢标记（否则本地又回到每次等 20s+ 真 sleep）", () => {
    expect(PKG.scripts.test).toContain("--test-name-pattern");
    expect(PKG.scripts.test).toContain("slow");
  });

  test("test:slow 与 test:all 都在（缺了就没有跑那 4 条的入口）", () => {
    // test:slow 只跑标记的；test:all 是「我就是要全量」的显式入口。
    expect(PKG.scripts["test:slow"]).toContain("--test-name-pattern");
    expect(PKG.scripts["test:all"]).toBe("bun test");
  });
});

describe("慢测试拆分：服务端仍跑全量（这组是本文件的重点）", () => {
  test("ci.yml 用裸 bun test，不是 bun run test", () => {
    // 裸 `bun test` 不读 package.json 的 scripts，所以不受 --test-name-pattern 影响。
    // 一旦有人"统一风格"把它改成 `bun run test`，那 4 条 [slow] 立刻静默失去门禁。
    expect(CI).toMatch(/run:\s*bun test\s*$/m);
    expect(CI).not.toMatch(/run:\s*bun run test\s*$/m);
  });

  test("release.sh 发布前门禁也用裸 bun test", () => {
    expect(RELEASE_SH).toMatch(/^\s*bun test\s*\|\|/m);
    expect(RELEASE_SH).not.toMatch(/bun run test\s*\|\|/);
  });
});

describe("慢标记的 case 确实存在且带得住理由", () => {
  // 标 [slow] 必须是"缩放实测无收益"的地板约束，不是"这条测试碰巧慢"的挡箭牌。
  // 每个文件的头注释里都写了实测数据与不许改哪个生产常量；这里只钉数量不失控。
  const FILES = [
    "packages/core/tests/llm/resilience-b6-gates.test.ts",
    "packages/core/tests/llm/fallback.test.ts",
    "packages/core/tests/llm/cooldown-probe-integration.test.ts",
  ];

  test("标记集中在已诊断过的三个文件里，总数不超过 6 条", () => {
    let total = 0;
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), "utf8");
      total += (src.match(/test\("\[slow\]/g) ?? []).length;
    }
    // 当前 4 条。留一点余量，但不容许它变成"慢就贴标签"的垃圾桶——
    // 超了就该回去看是不是又有测试传了生产量级的参数（那类是能修的，不该贴标签）。
    expect(total).toBeGreaterThanOrEqual(4);
    expect(total).toBeLessThanOrEqual(6);
  });

  test("每处慢标记附近都写明了为什么不能靠缩放解决", () => {
    // 判据：标记点前后必须提到那三个常量之一 —— 它们是"缩放无效"的根因，
    // 也是后人最容易为了提速去动的东西（动了就是拿生产语义换测试便利）。
    // 不限定必须写在文件头注释：写在紧邻的 test 注释里同样（甚至更）有用。
    const RATIONALE = /MIN_COOLDOWN_MS|COOLDOWN_STAGGER_MS|heartbeatMs/;
    for (const f of FILES) {
      const src = readFileSync(join(ROOT, f), "utf8");
      const header = src.slice(0, src.indexOf("import "));
      for (const m of src.matchAll(/test\("\[slow\]/g)) {
        const near = src.slice(m.index, m.index + 900);
        expect(RATIONALE.test(header) || RATIONALE.test(near)).toBe(true);
      }
    }
  });
});
