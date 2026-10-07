#!/usr/bin/env bun
/**
 * 键位对拍的诊断（B9 / T5.1，契约 I8）：新底座跑语料，与 input-vectors.json 比，按名字前缀统计不一致数并列出明细。
 * T5.1b 起 `packages/tui/tests/input.test.ts` 要求两种口径都是 0；它红了，用这里看全部明细。
 *
 * 用法：
 *   bun run scripts/tui-input-diff.ts                 # 语义口径（只比 input 与为真的字段），打印分组计数 + 全部明细
 *   bun run scripts/tui-input-diff.ts '^csi '         # 只列名字匹配正则的明细（计数仍是全量）
 *   bun run scripts/tui-input-diff.ts --full          # 逐字段口径（含 false 字段，最终验收口径）
 *   bun run scripts/tui-input-diff.ts --counts        # 只打印计数
 */
import React from "react";
import vectors from "../packages/tui/tests/fixtures/input-vectors.json";
import { INPUT_CORPUS } from "../packages/tui/tests/fixtures/input-corpus.ts";
import { driveInputs, type InputEventRecord } from "../packages/tui/tests/fixtures/input-drive.tsx";
import {
  countByPrefix,
  mismatches,
  shape,
  type Mode,
} from "../packages/tui/tests/fixtures/input-compare.ts";
import { render, Text, useInput } from "../packages/tui/src/index.ts";
import instances from "../packages/tui/src/instances.ts";

const args = process.argv.slice(2);
const mode: Mode = args.includes("--full") ? "full" : "semantic";
const countsOnly = args.includes("--counts");
const pattern = args.find((a) => !a.startsWith("--"));
const filter = pattern ? new RegExp(pattern) : null;

const want = vectors as unknown as Record<string, InputEventRecord[]>;
const got = await driveInputs(
  {
    React,
    Text: Text as never,
    useInput: useInput as never,
    renderSync: render as never,
    forget: (stdout) => instances.delete(stdout),
  },
  INPUT_CORPUS,
);
const bad = mismatches(INPUT_CORPUS, want, got, mode);
console.log(`[${mode}] 不一致 ${bad.length} / ${INPUT_CORPUS.length}`);
console.log(JSON.stringify(countByPrefix(bad)));
if (!countsOnly) {
  for (const c of bad) {
    if (filter && !filter.test(c.name)) continue;
    console.log(
      c.name.padEnd(30),
      JSON.stringify(shape(want[c.name], "semantic")),
      " | ",
      JSON.stringify(shape(got[c.name], "semantic")),
    );
  }
}
process.exit(0);
