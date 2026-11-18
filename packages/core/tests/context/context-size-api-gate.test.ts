/**
 * 归零门禁：「上下文有多大」必须走两个具名 API，裸 `estimateTokens` 在生产代码里绝迹。
 *
 * 为什么需要一道门禁而不是靠注释提醒（A6，2026-11-18）：
 * `ContextManager.estimateTokens()` 这个名字没说明自己问的是哪种「大小」，于是
 * **27 处调用方一律直接用它**，全部漏扣本地释放量。凡是问「这个会话现在多大」的地方
 * 都有两种正确回答：
 *
 * - 展示 / 决策 / 预算钳制 → `getSendTokens()`（全量历史 − 本地已释放量）
 * - 压缩前后对比等度量 → `getHistoryTokens()`（全量历史，含锚点）
 *
 * 光把存量 27 处改对只能保今天。这道门禁把「下一次有人图省事写 `ctxMgr.estimateTokens()`」
 * 变成一个会当场变红的错误——而不是又一次「遮罩释放得越多、越容易误判剩余极少」。
 *
 * 它与棘轮的区别：迁移完成后存量**已经是 0**，所以这里断言的是 0 本身，不是「不高于基线」。
 * 0 是不动的下界，没有放宽的余地；一旦有人新增一处，必须显式改成两个具名 API 之一。
 *
 * 配套的语义断言（为什么必须是具名 API 而不只是改个名字）见
 * `display-freed-tokens-same-source.test.ts`：那里断言 `getSendTokens()` 与
 * 记账量严格对得上账。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** 定义这两个 API 的宿主文件——它内部当然要调 estimateTokens，是唯一的合法例外。 */
const ALLOWED_FILE = "packages/core/src/context/manager.ts";

/** 生产代码根目录（不含各包的 tests/）。 */
function srcRoots(): string[] {
  const roots: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, pkg, "src");
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      // 没有 src 的包（纯文档 / 纯配置）跳过
    }
  }
  return roots;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * 该行是否只是注释。
 *
 * 必须排除注释，否则 `output-budget.ts` 里那句说明性注释
 *（「口径来自 `ctxMgr.estimateTokens()`」）会误报——那是文档，不是调用。
 * 判据是「去掉前导空白后以 `//` / `*` / `/*` 开头」。
 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** 扫到的真实调用点（文件相对路径 + 行号 + 行内容）。 */
function findBareEstimateTokensCalls(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const root of srcRoots()) {
    for (const file of walk(root)) {
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (rel === ALLOWED_FILE) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (!/\.estimateTokens\(/.test(line)) return;
        hits.push({ file: rel, line: i + 1, text: line.trim() });
      });
    }
  }
  return hits;
}

describe("A6 归零门禁：生产代码不得再调裸 estimateTokens", () => {
  test("packages/*/src 下（除 manager.ts）裸 estimateTokens 调用数为 0", () => {
    const hits = findBareEstimateTokensCalls();

    // 失败时把命中点全部打出来：只说「不等于 0」会让人去 grep 全仓找是哪一处
    const detail =
      hits.length === 0
        ? ""
        : "\n裸调用点（改用 getSendTokens 或 getHistoryTokens）：\n" +
          hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n");

    expect(hits.length, detail).toBe(0);
  });

  test("门禁确实扫到了文件（防止 walk 失效导致恒绿）", () => {
    // 一道「一个文件都没扫到」的门禁永远绿，比没有门禁更危险。
    const files: string[] = [];
    for (const root of srcRoots()) walk(root, files);
    expect(files.length).toBeGreaterThan(100);
    // 且 manager.ts 确实在扫描范围内（它是唯一豁免，但必须存在）
    expect(files.some((f) => f.endsWith("context/manager.ts"))).toBe(true);
  });

  test("两个具名 API 都在 ContextManager 上（改名不会静默把调用方逼回裸口径）", () => {
    const src = readFileSync(join(REPO_ROOT, ALLOWED_FILE), "utf8");
    expect(src).toContain("getSendTokens(toolCount: number = 0): number {");
    expect(src).toContain("getHistoryTokens(toolCount: number = 0): number {");
    // 唯一的扣减口
    expect(src).toContain("private localReductionTokens(): number {");
  });
});
