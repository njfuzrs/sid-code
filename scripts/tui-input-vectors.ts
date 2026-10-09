#!/usr/bin/env bun
/**
 * 从旧底座生成键位解析的测试向量（B9 / T5.1，契约 I1 / I6 / I8）。
 *
 * 语料在 packages/tui/tests/fixtures/input-corpus.ts（纯数据），驱动在 input-drive.tsx（不 import 底座）。
 * 这里把端口的 legacy 实现注入驱动，逐条记下 `useInput` 回调收到的 `(input, key)`。
 * 新底座的测试只读向量（设计文档 D-5）；T9 删旧底座后测试照样能跑。
 *
 * 用法：
 *   bun run tui:input-vectors          # 重新生成 packages/tui/tests/fixtures/input-vectors.json
 *   bun run tui:input-vectors --check  # 只比对，不一致退 1
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "packages/tui/tests/fixtures/input-vectors.json");

const CHILD = `
import React from "react";
const { INPUT_CORPUS } = await import(${JSON.stringify(join(ROOT, "packages/tui/tests/fixtures/input-corpus.ts"))});
const { driveInputs } = await import(${JSON.stringify(join(ROOT, "packages/tui/tests/fixtures/input-drive.tsx"))});
const { Text } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/components.ts"))});
const { useInput } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/hooks.ts"))});
const { renderSync, forgetRenderInstance: forget } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/testing.ts"))});
const out = await driveInputs({ React, Text, useInput, renderSync, forget }, INPUT_CORPUS);
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

const r = Bun.spawnSync(["bun", "-e", CHILD], {
  cwd: ROOT,
  env: { ...process.env, SID_TUI_RENDERER: "legacy", NODE_ENV: "test" },
});
if (r.exitCode !== 0) {
  process.stderr.write(r.stderr.toString());
  process.exit(1);
}
const next = JSON.stringify(JSON.parse(r.stdout.toString()), null, 2) + "\n";

if (process.argv.includes("--check")) {
  // 比内容不比排版：入库文件经 oxfmt 格式化，与 JSON.stringify 的换行不同
  const current = JSON.stringify(JSON.parse(readFileSync(OUT, "utf8")));
  if (current !== JSON.stringify(JSON.parse(next))) {
    console.error("input-vectors.json 已过期：运行 bun run tui:input-vectors 重新生成");
    process.exit(1);
  }
  console.log("input-vectors.json 与旧底座一致");
} else {
  writeFileSync(OUT, next);
  console.log(`写入 ${Object.keys(JSON.parse(next)).length} 条 → ${OUT}`);
}
