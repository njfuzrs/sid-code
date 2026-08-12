/**
 * 消息保真：重建消息对象时 `_meta` 必须默认透传（审计第 5 条回归测试）
 *
 * 两处历史缺陷都是手写字段列表 `{role, content}` 重建消息，静默丢弃 `_meta`：
 *   - `Manager.getCleanedMessages()` 的「大输出清理」分支
 *   - `ToolOutputMaskingService.mask()` 的遮罩分支
 *
 * `_meta` 里三样东西丢了都有真实后果：
 *   - `reasoning_content`：DeepSeek 协议要求原样回传，丢了推理链断裂
 *   - `compact_boundary`：压缩判断的锚点
 *   - `origin`：TUI 隐藏标记，丢了内部消息会重新出现在界面上
 *
 * 这两条路径都只在**长会话**触发（可清理大输出 > KEEP_RECENT_OUTPUTS / 超出保护窗口），
 * 所以短用例测不出来——下面的 fixture 刻意把量堆到触发阈值以上。
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";
import { ToolOutputMaskingService } from "@sid-code/core/context/tool-output-masking.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** 一组 tool_use / tool_result 配对，assistant 侧带 _meta */
function pushToolPair(mgr: Manager, id: string, output: string): void {
  mgr.addMessage({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "read", input: { file_path: `/tmp/${id}.txt` } }],
    _meta: { reasoning_content: `思考 ${id}`, origin: `origin-${id}` },
  });
  mgr.addMessage({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: output }],
  });
}

describe("_meta 保真", () => {
  test("getCleanedMessages 触发大输出清理后仍保留 _meta", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    // KEEP_RECENT_OUTPUTS 默认 6，需要 > 6 个可清理大输出才进清理分支
    const PAIRS = 9;
    for (let i = 0; i < PAIRS; i++) {
      pushToolPair(mgr, `t${i}`, "x".repeat(40_000)); // > OUTPUT_THRESHOLD(30000)
    }
    mgr.addCompactBoundary("摘要文本", 3);

    const cleaned = mgr.getCleanedMessages();

    // 前提校验：确实走进了清理分支（否则本测试是空跑）
    const clearedCount = cleaned.filter((m) =>
      m.content.some((b) => b.type === "tool_result" && String(b.content).includes("已清理")),
    ).length;
    expect(clearedCount).toBeGreaterThan(0);

    // 1. assistant 侧 _meta 全部存活
    const withReasoning = cleaned.filter((m) => m._meta?.reasoning_content);
    expect(withReasoning.length).toBe(PAIRS);
    expect(cleaned.filter((m) => m._meta?.origin).length).toBe(PAIRS);

    // 2. compact_boundary 存活
    expect(cleaned.some((m) => m._meta?.compact_boundary)).toBe(true);
  });

  test("ToolOutputMaskingService.mask 遮罩后仍保留 _meta", () => {
    const svc = new ToolOutputMaskingService("test-meta-preserve");
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "start" }] }];
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `m${i}`, name: "read", input: {} }],
        _meta: { reasoning_content: `思考 ${i}`, origin: `origin-${i}` },
      });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `m${i}`, content: "a".repeat(50_000) }],
      });
    }

    const masked = svc.mask(messages);

    // 前提校验：确实触发了遮罩（未触发时 mask 原样返回同一引用）
    expect(masked).not.toBe(messages);

    expect(masked.filter((m) => m._meta?.reasoning_content).length).toBe(10);
    expect(masked.filter((m) => m._meta?.origin).length).toBe(10);
  });

  test("releaseBeforeBoundary 叠加 gc_released 而非覆盖已有 _meta", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "y".repeat(500) }],
      _meta: { origin: "command-expansion" },
    });
    mgr.addCompactBoundary("摘要", 1);

    const released = mgr.releaseBeforeBoundary();
    expect(released).toBe(1);

    const first = mgr.getMessages()[0];
    expect(first._meta?.gc_released).toBe(true);
    // 关键：原有 origin 不能被整体覆盖抹掉（否则内部消息会重现在 TUI）
    expect(first._meta?.origin).toBe("command-expansion");
  });
});
