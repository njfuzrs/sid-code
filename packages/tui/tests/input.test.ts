/**
 * 键位解析对拍旧底座（B9 / T5.1，契约 I8）。
 *
 * 向量由 `bun run tui:input-vectors` 从旧底座逐条生成并入库；这里用新底座跑同一串输入，
 * `useInput` 收到的 `(input, key)` 序列（key 含全部字段）必须逐条一致。只读向量与语料，不 import 旧底座。
 *
 * ⚠️ 对齐还没做完（T5.1b），所以「逐条一致」暂时是**棘轮**：按名字前缀记下当前不一致数，只许降不许升。
 * 某个前缀修好了，把这里的基线同步调低（`bun run scripts/tui-input-diff.ts --counts` 打印当前值）；
 * 全部降到 0 后删掉 BASELINE，改回严格相等。基线调高 = 回归，不许为了过测试改大。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import vectors from "./fixtures/input-vectors.json";
import { INPUT_CORPUS } from "./fixtures/input-corpus.ts";
import { driveInputs, type InputEventRecord } from "./fixtures/input-drive.tsx";
import { countByPrefix, mismatches, shape } from "./fixtures/input-compare.ts";
import { render, Text, useInput } from "../src/index.ts";
import instances from "../src/instances.ts";

/** 语义口径（input + 为真的字段）下各前缀的不一致数上限，2026-10-07 实测 675 / 1227 */
const SEMANTIC_BASELINE: Record<string, number> = {
  kitty: 329,
  csi: 140,
  mok: 56,
  sgr: 48,
  ss3: 17,
  edge: 14,
  x10: 14,
  multi: 10,
  split: 8,
  paste: 7,
  misc: 6,
  pending: 6,
  meta: 5,
  "kitty-ev": 5,
  focus: 4,
  byte: 3,
  text: 3,
};
/** 逐字段口径（含 false 字段）的总数上限：新底座 key 的字段集合还不同（多 capsLock/hyper/numLock，少 fn/wheelUp/wheelDown），几乎全红 */
const FULL_BASELINE = 1225;

const want = vectors as unknown as Record<string, InputEventRecord[]>;

describe("键位解析对拍旧底座（input-vectors.json）", () => {
  test("语料与向量一一对应", () => {
    expect(Object.keys(want)).toEqual(INPUT_CORPUS.map((c) => c.name));
  });

  test("I8: 不一致数不超过棘轮基线（逐前缀，只降不升）", async () => {
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
    const semantic = countByPrefix(mismatches(INPUT_CORPUS, want, got, "semantic"));
    // 超出基线的前缀连同前几条明细一起报，红了不用再跑诊断脚本才知道差在哪
    const over = Object.entries(semantic)
      .filter(([p, n]) => n > (SEMANTIC_BASELINE[p] ?? 0))
      .map(([p, n]) => ({
        prefix: p,
        count: n,
        baseline: SEMANTIC_BASELINE[p] ?? 0,
        samples: mismatches(
          INPUT_CORPUS.filter((c) => c.name.split(" ")[0] === p),
          want,
          got,
          "semantic",
        )
          .slice(0, 3)
          .map((c) => ({
            name: c.name,
            want: shape(want[c.name], "semantic"),
            got: shape(got[c.name], "semantic"),
          })),
      }));
    expect(over).toEqual([]);
    expect(mismatches(INPUT_CORPUS, want, got, "full").length).toBeLessThanOrEqual(FULL_BASELINE);
  }, 60000);
});
