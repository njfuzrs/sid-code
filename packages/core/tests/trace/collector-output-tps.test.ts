/**
 * `TraceCollector.getOutputTps()` —— 状态栏吞吐列的唯一取数口。
 *
 * 为什么单独测这个方法（而不是只测 `deriveOutputTps`）：状态栏和 `/perf` 必须**同源同数**，
 * 而"同源"的保证点就在这个 getter —— 它必须原样转发 `deriveOutputTps`，不许自己再写一份
 * 除法。公式本身在 `trace/builder.ts` 已有单测，这里测的是**转发与未初始化语义**。
 *
 * 变异自证：
 * - 把 `getOutputTps` 改成 `recv / gen`（跳过 deriveOutputTps 的 gen<=0 保护）→ 第 2 条红；
 * - 把 `if (!this.initialized) return undefined` 删掉 → 第 1 条红。
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";

describe("TraceCollector.getOutputTps", () => {
  it("未初始化 → undefined（轨迹采集关闭时不落误导的 0）", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sid-tps-"));
    try {
      const collector = new TraceCollector({ outputDir: tempDir });
      expect(collector.getOutputTps()).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("已初始化 + 有样本 → 与 deriveOutputTps 完全一致（一个指标一个公式）", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sid-tps-"));
    try {
      const collector = new TraceCollector({ outputDir: tempDir });
      (collector as any).initialized = true;
      (collector as any).metadata = {
        session_id: "tps-session",
        total_tokens_received: 500,
        total_gen_elapsed_ms: 10_000, // 10s
        gen_samples: 1,
      };

      // 500 tok / 10s = 50 tok/s
      expect(collector.getOutputTps()).toBeCloseTo(50, 6);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("gen_samples=0 → undefined（有字段但没样本，不能当 0 tps）", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sid-tps-"));
    try {
      const collector = new TraceCollector({ outputDir: tempDir });
      (collector as any).initialized = true;
      (collector as any).metadata = {
        session_id: "tps-empty",
        total_tokens_received: 0,
        total_gen_elapsed_ms: 0,
        gen_samples: 0,
      };
      expect(collector.getOutputTps()).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("分母为 0 但样本数 > 0 → undefined（防御除零，不给 ∞）", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sid-tps-"));
    try {
      const collector = new TraceCollector({ outputDir: tempDir });
      (collector as any).initialized = true;
      (collector as any).metadata = {
        session_id: "tps-div0",
        total_tokens_received: 120,
        total_gen_elapsed_ms: 0,
        gen_samples: 1,
      };
      expect(collector.getOutputTps()).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
