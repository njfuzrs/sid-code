/**
 * N12 门禁：每个 `appendMetadata("<key>", …)` 都必须能指出读取端，或登记为「刻意无读取端」。
 *
 * 由来：`side_call_stats` 写入端注释声称「resume 后可见」，磁盘上 41 条，读取端 0 处。
 * 只写不读的 key 在磁盘上看起来一切正常，只有去查读取端才暴露 —— 所以做成静态门禁。
 *
 * 读取端判据：非测试源码里出现 `["<key>"]` 或 `.<key>`（`metadata?.key` 形态），
 * 且该行不是 appendMetadata 写入本身。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "../../../..");
const SRC_ROOTS = ["packages/core/src", "packages/cli/src", "packages/shared/src"].map((p) =>
  join(REPO, p),
);

/** 刻意无程序读取端的 key：写入端注释已声明「供外部工具 / 人工排查」。新增须写明理由。 */
const NO_READER_ALLOWLIST: Record<string, string> = {
  forked_from: "分叉溯源锚点，供外部工具双向追溯（store.ts forkHistoryFrom）",
  trace_session_id:
    "jsonl → trajectory 目录反查锚点，供外部工具 / 人工排查（store.ts resumeSession）",
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "_vendor") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p); // symlink（vendor）跟随；坏链跳过
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 纯函数：给定 {文件 → 内容}，返回「写了但没读」且不在白名单的 key。 */
function findWriteOnlyKeys(files: Record<string, string>, allow: Record<string, string>): string[] {
  const written = new Set<string>();
  for (const src of Object.values(files)) {
    for (const m of src.matchAll(/appendMetadata\(\s*"([a-z_]+)"/g)) written.add(m[1]!);
  }
  const missing: string[] = [];
  for (const key of written) {
    if (key in allow) continue;
    const readerRe = new RegExp(`\\["${key}"\\]|\\.${key}\\b`);
    const hasReader = Object.values(files).some((src) =>
      src.split("\n").some((line) => !line.includes("appendMetadata(") && readerRe.test(line)),
    );
    if (!hasReader) missing.push(key);
  }
  return missing.sort();
}

function loadSources(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const root of SRC_ROOTS) {
    for (const f of walk(root)) files[f] = readFileSync(f, "utf-8");
  }
  return files;
}

describe("N12：appendMetadata 的 key 必须有读取端", () => {
  test("生产源码：没有只写不读的 metadata key", () => {
    const files = loadSources();
    // 分母自证：确实扫到了写入端（扫空了会假绿）
    const writes =
      Object.values(files)
        .join("\n")
        .match(/appendMetadata\(\s*"[a-z_]+"/g) ?? [];
    expect(writes.length).toBeGreaterThanOrEqual(10);
    expect(findWriteOnlyKeys(files, NO_READER_ALLOWLIST)).toEqual([]);
  });

  test("白名单里的 key 必须真的还有写入端（防白名单腐烂成死条目）", () => {
    const all = Object.values(loadSources()).join("\n");
    for (const key of Object.keys(NO_READER_ALLOWLIST)) {
      expect(all).toMatch(new RegExp(`appendMetadata\\(\\s*"${key}"`));
    }
  });

  test("变异自证：删掉 side_call_stats 的读取端 ⇒ 门禁报出它", () => {
    const files = loadSources();
    const mutated: Record<string, string> = {};
    for (const [f, src] of Object.entries(files)) {
      mutated[f] = src.replaceAll('["side_call_stats"]', '["__removed__"]');
    }
    expect(findWriteOnlyKeys(mutated, NO_READER_ALLOWLIST)).toContain("side_call_stats");
  });
});
