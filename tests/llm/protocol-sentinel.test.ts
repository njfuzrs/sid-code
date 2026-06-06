/**
 * 协议完整性发送前关卡测试 — D1-1 + D3-2
 *
 * 覆盖 src/llm/protocol-sentinel.ts：
 *   - 完整历史 → 静默通过，不落盘
 *   - 孤儿历史 + strict=false → 不抛，落盘违例现场（D3-2）
 *   - 孤儿历史 + strict=true → 抛 MessageHistoryViolationError
 *   - 环境变量 SID_CODE_PROTOCOL_STRICT 控制 strict
 *   - 落盘内容含配对明细 + 周边 ±3 条窗口
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../src/llm/types.ts";
import {
  guardOutgoingMessages,
  dumpProtocolViolation,
} from "../../src/llm/protocol-sentinel.ts";
import {
  checkMessageHistoryIntegrity,
  MessageHistoryViolationError,
} from "../../src/agent/message-invariants.ts";

function asst(...tools: Array<[string, string]>): Message {
  return {
    role: "assistant",
    content: tools.map(([id, name]) => ({ type: "tool_use", id, name, input: {} })),
  };
}
function userResults(...ids: string[]): Message {
  return {
    role: "user",
    content: ids.map(id => ({ type: "tool_result", tool_use_id: id, content: "ok" })),
  };
}

let dumpDir: string;
beforeEach(() => {
  dumpDir = mkdtempSync(join(tmpdir(), "sid-protocol-test-"));
});
afterEach(() => {
  try {
    rmSync(dumpDir, { recursive: true, force: true });
  } catch {}
  delete process.env.SID_CODE_PROTOCOL_STRICT;
});

describe("D1-1 — 发送前协议关卡", () => {
  test("完整历史：静默通过，不落盘", () => {
    const messages: Message[] = [asst(["c1", "read"]), userResults("c1")];
    expect(() =>
      guardOutgoingMessages(messages, { providerName: "openai", dumpDir, strict: false }),
    ).not.toThrow();
    expect(readdirSync(dumpDir)).toHaveLength(0);
  });

  test("孤儿历史 + strict=false：不抛，但落盘违例现场（D3-2）", () => {
    const messages: Message[] = [asst(["c1", "read"], ["c2", "boom"]), userResults("c1")];
    expect(() =>
      guardOutgoingMessages(messages, {
        providerName: "deepseek-v4-pro",
        dumpDir,
        strict: false,
        now: 1700000000000,
      }),
    ).not.toThrow();
    const files = readdirSync(dumpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("protocol-violation-1700000000000.json");
  });

  test("孤儿历史 + strict=true：抛 MessageHistoryViolationError", () => {
    const messages: Message[] = [asst(["c1", "read"], ["c2", "boom"]), userResults("c1")];
    let thrown: unknown = null;
    try {
      guardOutgoingMessages(messages, { providerName: "openai", dumpDir, strict: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MessageHistoryViolationError);
    // strict 模式也应落盘（先落盘再抛）
    expect(readdirSync(dumpDir).length).toBeGreaterThan(0);
  });

  test("环境变量 SID_CODE_PROTOCOL_STRICT=1 时未显式传 strict 也抛", () => {
    process.env.SID_CODE_PROTOCOL_STRICT = "1";
    const messages: Message[] = [asst(["c1", "read"], ["c2", "boom"]), userResults("c1")];
    expect(() =>
      guardOutgoingMessages(messages, { providerName: "openai", dumpDir }),
    ).toThrow(MessageHistoryViolationError);
  });
});

describe("D3-2 — 违例现场落盘", () => {
  test("落盘内容含孤儿配对明细 + 周边 ±3 条窗口", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "task start" }] },
      asst(["a1", "read"]),
      userResults("a1"),
      asst(["x1", "edit"], ["x2", "write"]), // 这一轮孤儿
      { role: "user", content: [{ type: "text", text: "next" }] },
    ];
    const result = checkMessageHistoryIntegrity(messages);
    const path = dumpProtocolViolation(messages, result, {
      providerName: "deepseek-v4-pro",
      dumpDir,
      now: 1700000000001,
    });
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);

    const snapshot = JSON.parse(readFileSync(path!, "utf-8"));
    expect(snapshot.kind).toBe("protocol-violation");
    expect(snapshot.provider).toBe("deepseek-v4-pro");
    expect(snapshot.orphans.map((o: any) => o.id).sort()).toEqual(["x1", "x2"]);
    expect(snapshot.total_messages).toBe(5);
    // 窗口应覆盖 msg#3（孤儿所在）周边，含明细
    expect(snapshot.context_window.length).toBeGreaterThan(0);
    const orphanMsg = snapshot.context_window.find((c: any) => c.index === 3);
    expect(orphanMsg).toBeDefined();
    expect(orphanMsg.blocks.some((b: any) => b.type === "tool_use" && b.id === "x1")).toBe(true);
  });

  test("落盘到不可写目录：best-effort 返回 null，不抛", () => {
    const messages: Message[] = [asst(["c1", "read"], ["c2", "boom"]), userResults("c1")];
    const result = checkMessageHistoryIntegrity(messages);
    // 给一个非法路径（含 null 字节会让 mkdirSync 抛），验证被 catch
    const path = dumpProtocolViolation(messages, result, {
      providerName: "openai",
      dumpDir: "/proc/nonexistent-readonly-\0invalid",
    });
    expect(path).toBeNull();
  });
});
