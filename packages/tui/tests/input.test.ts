/**
 * 键位解析对拍旧底座（B9 / T5.1，契约 I8）。
 *
 * 向量由 `bun run tui:input-vectors` 从旧底座逐条生成并入库；这里用新底座跑同一串输入，
 * `useInput` 收到的 `(input, key)` 序列（key 含全部字段）必须逐条一致。只读向量与语料，不 import 旧底座。
 *
 * 两种口径都要 0 条不一致：语义口径（input + 为真的字段）红了看解析差在哪，逐字段口径还管 key 的字段集合。
 * 红了用 `bun run scripts/tui-input-diff.ts` 看全部明细。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import vectors from "./fixtures/input-vectors.json";
import { INPUT_CORPUS } from "./fixtures/input-corpus.ts";
import { driveInputs, type InputEventRecord } from "./fixtures/input-drive.tsx";
import { countByPrefix, mismatches, shape } from "./fixtures/input-compare.ts";
import { render, Text, useInput } from "../src/index.ts";
import instances from "../src/instances.ts";

const want = vectors as unknown as Record<string, InputEventRecord[]>;

describe("键位解析对拍旧底座（input-vectors.json）", () => {
  test("语料与向量一一对应", () => {
    expect(Object.keys(want)).toEqual(INPUT_CORPUS.map((c) => c.name));
  });

  test("I8: 每条语料的 (input, key) 序列与旧底座逐条一致", async () => {
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
    // 红了连同前几条明细一起报，不用再跑诊断脚本才知道差在哪
    const report = (mode: "semantic" | "full") => {
      const bad = mismatches(INPUT_CORPUS, want, got, mode);
      return {
        mode,
        count: bad.length,
        byPrefix: countByPrefix(bad),
        samples: bad.slice(0, 5).map((c) => ({
          name: c.name,
          want: shape(want[c.name], mode),
          got: shape(got[c.name], mode),
        })),
      };
    };
    expect(report("semantic")).toEqual({ mode: "semantic", count: 0, byPrefix: {}, samples: [] });
    expect(report("full")).toEqual({ mode: "full", count: 0, byPrefix: {}, samples: [] });
  }, 60000);
});
