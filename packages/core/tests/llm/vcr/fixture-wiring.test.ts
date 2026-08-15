/**
 * VCR 夹具接线门禁 — fixture-wiring.test.ts（PR-1）
 *
 * § 为什么需要一道门禁而不是"记得就好"
 * 本 PR 之前，仓里 5 份夹具的现状是「代码六天涨 1263 行、夹具零变化」。
 * 夹具数本身**不是**指标——**被断言消费的夹具数**才是。一份躺着没人读的夹具
 * 在任何"夹具数 N 份"的口径里都会被算成资产，实际是脚手架。
 * 这正是记忆里那条判据：区分「资产」与「脚手架」，「只写不读」是能否算资产的实证判据。
 *
 * § 本门禁抓什么 / 抓不到什么
 * 抓：新增夹具却没写断言（文件名在 `tests/` 下任何 `.ts` 里零命中）。
 * 抓不到：断言写了但很弱（比如只断言 `events.length > 0`）。**弱断言只有 review 能拦**
 * —— 别把这道门禁当作"夹具质量已验证"的证明，它只证明夹具没被遗忘。
 *
 * § 刻意不做的事
 * 不断言夹具**总数**下限（如 ">= 20"）。数字门禁会奖励"凑数"：为了过门禁塞几份
 * 内容雷同的夹具，指标好看而回归网没变强。真正的判据是「每份都被消费」+「场景不重复」，
 * 前者机器可判（本门禁），后者靠 review。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** tests 根目录（本文件在 tests/llm/vcr/） */
const TESTS_ROOT = join(import.meta.dir, "..", "..");
const FIXTURE_DIR = join(TESTS_ROOT, "fixtures", "vcr");

/** 递归收集 tests/ 下所有 .ts 源码 */
function collectTestSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      collectTestSources(p, out);
    } else if (entry.endsWith(".ts")) {
      out.push(readFileSync(p, "utf-8"));
    }
  }
  return out;
}

const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("VCR 夹具接线门禁", () => {
  test("每份夹具都至少被一处测试代码引用（没有只写不读的脚手架）", () => {
    const sources = collectTestSources(TESTS_ROOT);
    const orphans = FIXTURES.filter((file) => {
      const stem = file.replace(/\.json$/, "");
      // 按文件名主干搜：调用点可能写全名（loadFixtureByName("x.json")）
      // 也可能写 provider+scenario（loadFixture("openai","normal-stream")），
      // 所以两种形态都试。
      const [provider, ...rest] = stem.split("-");
      const scenario = rest.join("-");
      return !sources.some(
        (src) =>
          src.includes(stem) ||
          (provider && scenario && src.includes(`"${provider}", "${scenario}"`)),
      );
    });

    expect(
      orphans,
      `以下夹具无任何断言消费（补断言或删夹具）：\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });

  test("每份夹具结构合法：有 response.status 且 chunks / body 二者其一", () => {
    // 结构坏掉的夹具会让消费它的测试以一个含糊的 undefined 报错失败，
    // 排查时先怀疑 provider 代码——这道断言把它前移到"夹具本身就不合法"。
    for (const file of FIXTURES) {
      const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf-8"));
      expect(typeof fx.response?.status, `${file} 缺 response.status`).toBe("number");
      const hasChunks = Array.isArray(fx.response?.chunks) && fx.response.chunks.length > 0;
      const hasBody = typeof fx.response?.body === "string";
      expect(hasChunks || hasBody, `${file} 既无 chunks 也无 body`).toBe(true);
      expect(typeof fx.provider, `${file} 缺 provider 字段`).toBe("string");
    }
  });

  test("三个协议族都有夹具覆盖（不允许某族为零）", () => {
    // 本 PR 之前 anthropic 族是 **0 份** —— 而它是我们唯一走 SDK（而非自建 fetch 解析）
    // 的一族，恰恰最需要从字节层回归。这条断言防止将来某族再次归零。
    const families = {
      "anthropic-messages": FIXTURES.filter((f) => f.startsWith("anthropic-")),
      "openai-chat": FIXTURES.filter((f) => f.startsWith("openai-") || f.startsWith("deepseek-")),
      "openai-responses": FIXTURES.filter((f) => f.startsWith("responses-")),
    };
    for (const [family, files] of Object.entries(families)) {
      expect(files.length, `协议族 ${family} 的夹具数`).toBeGreaterThan(0);
    }
  });
});
