/**
 * P3-23：`cache-ttl-latch` 生产零调用 —— 卫生项的可执行留痕
 *
 * 缺陷不是「注释说接了其实没接」（`cache-strategy.ts` 头部那种诚实声明已经有了），
 * 而是本模块注释只说「架构预留」，读起来像「已接好、等 API」。实际 `resolveCacheTTL` /
 * `getLatchedTTL` / `ttlToCacheControl` 一个字节都没接。
 *
 * 本测试把那句话变成门禁：**两个方向都查**（先证明命令能抓到已知符号，再看目标是否零命中），
 * 否则「grep 写错了所以零命中」与「真的零命中」不可区分。
 *
 * 这道门禁是**双向**的：哪天有人真把 latch 接上生产，本测试会失败并指向注释 ——
 * 那时要做的是更新注释（和这个测试），而不是绕过它。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOTS = ["packages/core/src", "packages/cli/src", "packages/shared/src"];
const REPO_ROOT = join(import.meta.dir, "../../../..");

function collectTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      collectTsFiles(full, out);
    } else if (e.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 生产源码文件（不含 tests/、不含 latch 模块自身）。 */
function productionFiles(): string[] {
  const files: string[] = [];
  for (const root of SRC_ROOTS) files.push(...collectTsFiles(join(REPO_ROOT, root)));
  return files.filter((f) => !f.endsWith(join("api", "cache-ttl-latch.ts")));
}

function countCallers(symbol: string): string[] {
  const hits: string[] = [];
  for (const f of productionFiles()) {
    const src = readFileSync(f, "utf-8");
    if (src.includes(symbol)) hits.push(f.slice(REPO_ROOT.length + 1));
  }
  return hits;
}

describe("P3-23：cache-ttl-latch 的生产接线现状", () => {
  it("正查：扫描口径本身有效（能抓到确实被生产引用的符号）", () => {
    // 反例锚点 —— resetTTLLatch 确实在 app.ts 被调。抓不到它说明本文件的扫描写错了，
    // 那么下面的「零命中」断言也就没有意义（这正是「凡零接线必须正反两查」的要求）。
    expect(countCallers("resetTTLLatch").length).toBeGreaterThan(0);
  });

  it("反查：三个 TTL 决策函数在生产源码里零调用", () => {
    for (const sym of ["resolveCacheTTL", "getLatchedTTL", "ttlToCacheControl"]) {
      expect(countCallers(sym)).toEqual([]);
    }
  });

  it("注释必须写明「生产零调用」，不得只说「架构预留」", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/api/cache-ttl-latch.ts"), "utf-8");
    // 措辞差异的代价：读成「已接好、等 API」就会被算进 cache 省钱口径，
    // 而它一个字节都没省（北极星自检第 2 问：指标必须能指到源字段）。
    expect(src).toContain("生产零调用");
  });
});
