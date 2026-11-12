/**
 * F4 / PR-3：按过期程度批量清理旧工具输出
 *
 * 断言对着修复前的可观察后果写：常规大小（3k–9k 字符）的旧工具结果在 1M 窗口、低用量下
 * **一条都不会被清**（遮罩要 78%、大输出清理要 >30,000 字符）。以及方案要求的三条平衡：
 *  - 攒批：未达门槛不改写前缀；
 *  - 粘性：提交后每轮逐字节重放，前缀只改写一次；
 *  - 不逼重读：活跃文件的最近一次 read、当前 turn、未知工具都不清。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@sid-code/core/context/manager.ts";
import {
  planStaleToolOutputClear,
  STALE_CLEAR_AFTER_TOOL_ROUNDS,
  STALE_CLEAR_MIN_BATCH_TOKENS,
} from "@sid-code/core/context/stale-tool-output.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

let tmpRoot = "";
const savedTmp = process.env.SID_CODE_TMPDIR;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-stale-clear-"));
  process.env.SID_CODE_TMPDIR = tmpRoot;
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = savedTmp;
  rmSync(tmpRoot, { recursive: true, force: true });
});

type Call = { name: string; input: Record<string, unknown>; chars?: number };

/** 每个 call 一轮：assistant(tool_use) + user(tool_result)。结果默认 6,000 字符（实测常见量级） */
function history(calls: Call[]): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  calls.forEach((c, i) => {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: c.input }],
    });
    msgs.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `t${i}`,
          // 用随机感的文本，避免估算器对重复字符给出异常低的 token 数
          content: Array.from({ length: c.chars ?? 6_000 }, (_, j) =>
            String.fromCharCode(97 + ((i * 7 + j * 13) % 26)),
          ).join(""),
        },
      ],
    });
  });
  return msgs;
}

function reads(n: number, chars?: number): Call[] {
  return Array.from({ length: n }, (_, i) => ({
    name: "read",
    input: { file_path: `src/f${i}.ts` },
    chars,
  }));
}

function resultOf(sent: Message[], id: string): string | undefined {
  for (const m of sent) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === id) return b.content;
    }
  }
  return undefined;
}

describe("planStaleToolOutputClear：判据", () => {
  test("常规大小的旧 read 结果在经过 K 个工具轮后成为候选（修复前一条都清不到）", () => {
    const msgs = history(reads(30));
    const plan = planStaleToolOutputClear(msgs);
    const ids = plan.entries.map((e) => e.toolUseId);
    expect(ids).toContain("t0");
    // 最后 K 轮之内的不清
    const lastStale = 30 - STALE_CLEAR_AFTER_TOOL_ROUNDS - 1;
    expect(ids).toContain(`t${lastStale}`);
    expect(ids).not.toContain(`t${lastStale + 1}`);
    expect(ids).not.toContain("t29");
  });

  test("未达批量门槛：entries 为空，但 pendingTokens 如实报告", () => {
    const msgs = history(reads(STALE_CLEAR_AFTER_TOOL_ROUNDS + 2, 2_000));
    const plan = planStaleToolOutputClear(msgs);
    expect(plan.entries).toEqual([]);
    expect(plan.pendingTokens).toBeGreaterThan(0);
    expect(plan.pendingTokens).toBeLessThan(STALE_CLEAR_MIN_BATCH_TOKENS);
  });

  test("活跃文件只豁免最近一次 read，更早的旧版本照清", () => {
    const calls: Call[] = [
      { name: "read", input: { file_path: "src/a.ts" } }, // t0：旧版本
      { name: "edit", input: { file_path: "src/a.ts", old_string: "x", new_string: "y" } },
      { name: "read", input: { file_path: "src/a.ts" } }, // t2：最近一次
      ...reads(25),
    ];
    const ids = planStaleToolOutputClear(history(calls)).entries.map((e) => e.toolUseId);
    expect(ids).toContain("t0");
    expect(ids).not.toContain("t2");
  });

  test("未知 / MCP 工具原样保留；写型 bash 只做摘要且提示不要重跑", () => {
    const calls: Call[] = [
      { name: "mcp__x__query", input: { q: "1" } },
      { name: "bash", input: { command: "git commit -m x" } },
      { name: "bash", input: { command: "sed -n '1,200p' src/x.ts" } },
      ...reads(25),
    ];
    const plan = planStaleToolOutputClear(history(calls));
    const byId = new Map(plan.entries.map((e) => [e.toolUseId, e.replacement]));
    expect(byId.has("t0")).toBe(false);
    expect(byId.get("t1")).toContain("不要为找回内容而重跑");
    expect(byId.get("t2")).toContain("重新执行该调用");
    expect(byId.get("t2")).toContain("sed -n");
  });

  test("占位带重读指引：read 给出文件路径与精准重读方式", () => {
    const plan = planStaleToolOutputClear(history(reads(30)));
    const r = plan.entries.find((e) => e.toolUseId === "t0")!.replacement;
    expect(r).toContain('read("src/f0.ts"');
    expect(r).toContain("offset=");
  });

  test("一轮并行多个工具调用只算一个工具轮", () => {
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "old", name: "read", input: { file_path: "o.ts" } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "old", content: "z".repeat(6_000) }],
    });
    // 之后只有 K-1 轮，但每轮并行 5 个调用
    for (let r = 0; r < STALE_CLEAR_AFTER_TOOL_ROUNDS - 1; r++) {
      const ids = Array.from({ length: 5 }, (_, j) => `p${r}_${j}`);
      msgs.push({
        role: "assistant",
        content: ids.map((id) => ({
          type: "tool_use" as const,
          id,
          name: "grep",
          input: { pattern: id },
        })),
      });
      msgs.push({
        role: "user",
        content: ids.map((id) => ({
          type: "tool_result" as const,
          tool_use_id: id,
          content: "ok",
        })),
      });
    }
    const plan = planStaleToolOutputClear(msgs, { minBatchTokens: 1 });
    expect(plan.entries.map((e) => e.toolUseId)).not.toContain("old");
  });
});

describe("ContextManager：批量提交 + 粘性重放", () => {
  test("1M 窗口低用量下也会清理（不依赖窗口剩余）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(reads(30)));
    const sent = mgr.getCleanedMessages();
    expect(resultOf(sent, "t0")).toContain("已过期清理");
    // 原始历史不被改写
    expect(resultOf(mgr.getMessages(), "t0")?.length).toBe(6_000);
  });

  test("提交后逐字节重放：后续轮次不再新增改写，cause 只在提交那一轮出现", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(reads(30)));
    mgr.consumeSendMutationCauses();
    const first = mgr.getCleanedMessages();
    expect(mgr.consumeSendMutationCauses()).toContain("stale_clear");
    const placeholder = resultOf(first, "t0");

    // 追加 1 轮（新过期量远不够门槛）
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "n1", name: "read", input: { file_path: "n.ts" } }],
    });
    mgr.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "n1", content: "n".repeat(1_000) }],
    });
    const second = mgr.getCleanedMessages();
    expect(resultOf(second, "t0")).toBe(placeholder);
    expect(mgr.consumeSendMutationCauses()).not.toContain("stale_clear");
    // t22 首轮时其后只有 7 轮、未过期；追加一轮后刚好过期，但单条攒不够门槛 →
    // 仍发原文（没有「每轮新过期一条就改写一次前缀」）
    expect(resultOf(first, "t22")?.length).toBe(6_000);
    expect(resultOf(second, "t22")?.length).toBe(6_000);
  });

  test("释放量记入本地账本：Footer 用量随之下降", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(reads(30)));
    const before = mgr.getContextUsageForDisplay().used;
    mgr.getCleanedMessages();
    const after = mgr.getContextUsageForDisplay().used;
    expect(after).toBeLessThan(before - STALE_CLEAR_MIN_BATCH_TOKENS / 2);
  });

  test("历史被整体替换后状态清空（与冷清理同生命周期）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(reads(30)));
    mgr.getCleanedMessages();
    mgr.setMessages(history(reads(3)));
    const sent = mgr.getCleanedMessages();
    expect(resultOf(sent, "t0")?.length).toBe(6_000);
  });

  test("与冷清理不叠加：已冷清的块保持冷清占位", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(reads(30)));
    mgr.applyColdCacheClear();
    const cold = resultOf(mgr.getCleanedMessages(), "t0");
    expect(cold).not.toContain("已过期清理");
    expect(resultOf(mgr.getCleanedMessages(), "t0")).toBe(cold);
  });
});
