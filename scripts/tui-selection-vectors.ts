#!/usr/bin/env bun
/**
 * 从旧底座生成选区引擎的测试向量（B9 / T6.2a，契约 M2）。
 *
 * 语料在 packages/tui/tests/fixtures/selection-corpus.tsx，驱动在 selection-drive.tsx（都不 import 底座）。
 * 这里把端口的 legacy 实现注入驱动，逐条记下复制出的文本与 xterm 里的高亮单元。
 * 新底座的测试只读向量（设计文档 D-5）；T9 删旧底座后测试照样能跑。
 *
 * 每条用例前要空 700ms（旧底座的连击计数跨挂载保留），全量约 3 分钟，所以按批次分子进程跑。
 *
 * 用法：
 *   bun run tui:selection-vectors          # 重新生成 packages/tui/tests/fixtures/selection-vectors.json
 *   bun run tui:selection-vectors --check  # 只比对，不一致退 1
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "packages/tui/tests/fixtures/selection-vectors.json");
const BATCH = 40;

const child = (from: number, to: number) => `
import React from "react";
import xterm from "@xterm/headless";
const { buildSelectionCases, ROWS } = await import(${JSON.stringify(join(ROOT, "packages/tui/tests/fixtures/selection-corpus.tsx"))});
const { driveSelection } = await import(${JSON.stringify(join(ROOT, "packages/tui/tests/fixtures/selection-drive.tsx"))});
const { Box, Text } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/components.ts"))});
const { useInput } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/hooks.ts"))});
const { mountTTY, tick, ttyStreams } = await import(${JSON.stringify(join(ROOT, "packages/cli/tests/render-port/tty-streams.ts"))});
const chalk = (await import("chalk")).default;
chalk.level = 3;
const cases = buildSelectionCases({ Box, Text }).slice(${from}, ${to});
const out = await driveSelection(
  { React, useInput, ttyStreams, mountTTY, tick, Terminal: xterm.Terminal, rows: ROWS },
  cases,
);
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

const COUNT = `
const { buildSelectionCases } = await import(${JSON.stringify(join(ROOT, "packages/tui/tests/fixtures/selection-corpus.tsx"))});
process.stdout.write(String(buildSelectionCases({ Box: () => null, Text: () => null }).length));
`;

const env = { ...process.env, SID_TUI_RENDERER: "legacy", NODE_ENV: "test" };
const total = Number(Bun.spawnSync(["bun", "-e", COUNT], { cwd: ROOT, env }).stdout.toString());
if (!Number.isInteger(total) || total <= 0) {
  console.error("读不到语料条数");
  process.exit(1);
}

const vectors: Record<string, unknown> = {};
for (let from = 0; from < total; from += BATCH) {
  const r = Bun.spawnSync(["bun", "-e", child(from, from + BATCH)], { cwd: ROOT, env });
  if (r.exitCode !== 0) {
    process.stderr.write(r.stderr.toString());
    process.exit(1);
  }

  Object.assign(vectors, JSON.parse(r.stdout.toString()));
  process.stderr.write(`  ${Math.min(from + BATCH, total)}/${total}\n`);
}

if (Object.keys(vectors).length !== total) {
  console.error(`条数不符：语料 ${total}，向量 ${Object.keys(vectors).length}（用例重名？）`);
  process.exit(1);
}

const next = JSON.stringify(vectors, null, 2) + "\n";
if (process.argv.includes("--check")) {
  // 比内容不比排版：入库文件经 oxfmt 格式化，与 JSON.stringify 的换行不同
  const current = JSON.stringify(JSON.parse(readFileSync(OUT, "utf8")));
  if (current !== JSON.stringify(JSON.parse(next))) {
    console.error("selection-vectors.json 已过期：运行 bun run tui:selection-vectors 重新生成");
    process.exit(1);
  }

  console.log("selection-vectors.json 与旧底座一致");
} else {
  writeFileSync(OUT, next);
  console.log(`写入 ${total} 条 → ${OUT}`);
}
