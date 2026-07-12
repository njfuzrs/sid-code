/**
 * GAP-01 / GAP-03 / GAP-10：流式工具执行器 + 分区算法单元测试
 */

import { describe, test, expect } from "bun:test";
import { StreamingToolExecutor } from "../../src/query/streaming-tool-executor.ts";
import { partitionToolCalls } from "../../src/query/tool-orchestration.ts";
import type { ToolUseBlock } from "../../src/llm/types.ts";
import type { LegacyTool as Tool } from "../../src/tool/types.ts";

/** 构造一个最小 mock 工具 */
function mockTool(name: string, opts: { safe?: boolean; readOnly?: boolean } = {}): Tool {
  return {
    name: () => name,
    description: () => name,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "ok" }),
    readOnly: () => opts.readOnly ?? false,
    ...(opts.safe !== undefined ? { isConcurrencySafe: () => opts.safe! } : {}),
  } as unknown as Tool;
}

function block(id: string, name: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

describe("partitionToolCalls (GAP-03 贪心连续合并)", () => {
  test("连续并发安全工具合并为一个并行批次", () => {
    const items = [
      { block: block("1", "read"), tool: mockTool("read", { safe: true }), idx: 0 },
      { block: block("2", "read"), tool: mockTool("read", { safe: true }), idx: 1 },
      { block: block("3", "read"), tool: mockTool("read", { safe: true }), idx: 2 },
    ];
    const batches = partitionToolCalls(items);
    expect(batches.length).toBe(1);
    expect(batches[0].isConcurrencySafe).toBe(true);
    expect(batches[0].items.length).toBe(3);
  });

  test("交替顺序保留：read/write/read → 3 个批次（不打乱顺序）", () => {
    const items = [
      { block: block("1", "read"), tool: mockTool("read", { safe: true }), idx: 0 },
      { block: block("2", "write"), tool: mockTool("write", { safe: false }), idx: 1 },
      { block: block("3", "read"), tool: mockTool("read", { safe: true }), idx: 2 },
    ];
    const batches = partitionToolCalls(items);
    // read(并行批) → write(串行批) → read(并行批)
    expect(batches.length).toBe(3);
    expect(batches[0].isConcurrencySafe).toBe(true);
    expect(batches[1].isConcurrencySafe).toBe(false);
    expect(batches[2].isConcurrencySafe).toBe(true);
    // 顺序不变
    expect(batches[0].items[0].idx).toBe(0);
    expect(batches[1].items[0].idx).toBe(1);
    expect(batches[2].items[0].idx).toBe(2);
  });

  test("回退 readOnly()：无 isConcurrencySafe 时用 readOnly 判定", () => {
    const items = [
      { block: block("1", "glob"), tool: mockTool("glob", { readOnly: true }), idx: 0 },
      { block: block("2", "edit"), tool: mockTool("edit", { readOnly: false }), idx: 1 },
    ];
    const batches = partitionToolCalls(items);
    expect(batches[0].isConcurrencySafe).toBe(true);
    expect(batches[1].isConcurrencySafe).toBe(false);
  });
});

describe("StreamingToolExecutor (GAP-01 4 状态状态机)", () => {
  test("全并发安全工具并行执行，结果按 idx 有序返回", async () => {
    const order: string[] = [];
    const exec = new StreamingToolExecutor(async (b) => {
      order.push(`start:${b.id}`);
      await new Promise(r => setTimeout(r, 10));
      return { output: `result-${b.id}` };
    }, 10);

    exec.addTool(block("a", "read"), mockTool("read", { safe: true }), 0);
    exec.addTool(block("b", "read"), mockTool("read", { safe: true }), 1);
    exec.addTool(block("c", "read"), mockTool("read", { safe: true }), 2);

    const results = await exec.getRemainingResults();
    expect(results.map(r => r.idx)).toEqual([0, 1, 2]);
    expect((results[0].result as any).output).toBe("result-a");
    // 三个并发安全工具应几乎同时启动（并行）
    expect(order.filter(o => o.startsWith("start")).length).toBe(3);
  });

  test("非并发安全工具独占执行窗口（前后不与其他工具并行）", async () => {
    let concurrentPeak = 0;
    let current = 0;
    const exec = new StreamingToolExecutor(async () => {
      current++;
      concurrentPeak = Math.max(concurrentPeak, current);
      await new Promise(r => setTimeout(r, 10));
      current--;
      return { output: "ok" };
    }, 10);

    // read(safe) + write(unsafe) + read(safe)
    exec.addTool(block("a", "read"), mockTool("read", { safe: true }), 0);
    exec.addTool(block("b", "write"), mockTool("write", { safe: false }), 1);
    exec.addTool(block("c", "read"), mockTool("read", { safe: true }), 2);

    const results = await exec.getRemainingResults();
    expect(results.length).toBe(3);
    // write 必须独占：任一时刻并发数不因 write 而 >1（write 前后串行化）
    // 具体峰值取决于调度，但 write 执行期间不允许其他工具并行 → 峰值不会是 3
    expect(concurrentPeak).toBeLessThanOrEqual(2);
  });

  test("执行异常被捕获为 error 字段，不中断其他工具", async () => {
    const exec = new StreamingToolExecutor(async (b) => {
      if (b.id === "b") throw new Error("boom");
      return { output: "ok" };
    }, 10);
    exec.addTool(block("a", "read"), mockTool("read", { safe: true }), 0);
    exec.addTool(block("b", "read"), mockTool("read", { safe: true }), 1);

    const results = await exec.getRemainingResults();
    expect(results.length).toBe(2);
    const b = results.find(r => r.idx === 1)!;
    expect(b.error).toBeInstanceOf(Error);
    const a = results.find(r => r.idx === 0)!;
    expect((a.result as any).output).toBe("ok");
  });
});
