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
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  guardOutgoingMessages,
  dumpProtocolViolation,
} from "@sid-code/core/llm/protocol-sentinel.ts";
import {
  checkMessageHistoryIntegrity,
  MessageHistoryViolationError,
} from "@sid-code/core/agent/message-invariants.ts";

function asst(...tools: Array<[string, string]>): Message {
  return {
    role: "assistant",
    content: tools.map(([id, name]) => ({ type: "tool_use", id, name, input: {} })),
  };
}
function userResults(...ids: string[]): Message {
  return {
    role: "user",
    content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })),
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
    expect(() => guardOutgoingMessages(messages, { providerName: "openai", dumpDir })).toThrow(
      MessageHistoryViolationError,
    );
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

/**
 * P2-12：违规样本目录的 LRU 保留上限。
 *
 * 背景（2026-08-14 实测）：`protocol-violations/` 无任何保留策略，用户盘上攒到
 * **8255 个文件 / 32MB**。落盘本身是对的（D3-2 的验尸现场），但没有上限的采集
 * 等于慢性泄漏。
 *
 * 上限 500 在生产代码里是常量，测试里用「铺 505 个假样本再落一个新的」来验：
 * 数量被压回上限、且**本次样本一定保得住**（LRU 在 write 之后跑，只回收更旧的）。
 */
describe("P2-12 — 违规样本目录 LRU", () => {
  const MAX = 500; // 与 protocol-sentinel.ts 的 MAX_VIOLATION_DUMPS 对齐

  function orphanMessages(): Message[] {
    return [asst(["lru1", "read"], ["lru2", "edit"]), userResults("lru1")];
  }

  /** 铺 n 个旧样本，mtime 依次更旧（i 越小越旧） */
  function seedOldDumps(n: number): string[] {
    const paths: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = join(dumpDir, `protocol-violation-${1000000 + i}.json`);
      writeFileSync(p, "{}");
      const t = new Date(Date.now() - (n - i) * 60_000);
      utimesSync(p, t, t);
      paths.push(p);
    }
    return paths;
  }

  test("超过上限时回收最旧的，数量压回 MAX", () => {
    seedOldDumps(MAX + 5);
    expect(readdirSync(dumpDir).length).toBe(MAX + 5);

    const messages = orphanMessages();
    const path = dumpProtocolViolation(messages, checkMessageHistoryIntegrity(messages), {
      providerName: "deepseek",
      dumpDir,
      now: Date.now(),
    });

    // 落盘 1 个 → 506 个 → 回收 6 个最旧的 → 剩 500
    expect(readdirSync(dumpDir).length).toBe(MAX);
    // 本次样本必须保得住（LRU 跑在 write 之后）
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
  });

  test("回收的是最旧的那几个，较新的样本不受影响", () => {
    const seeded = seedOldDumps(MAX + 3);
    const messages = orphanMessages();
    dumpProtocolViolation(messages, checkMessageHistoryIntegrity(messages), {
      providerName: "deepseek",
      dumpDir,
      now: Date.now(),
    });

    // 最旧的 4 个（3 个溢出 + 本次新增挤掉 1 个）应已不存在
    expect(existsSync(seeded[0])).toBe(false);
    expect(existsSync(seeded[1])).toBe(false);
    // 最新铺进去的那个仍在
    expect(existsSync(seeded[seeded.length - 1])).toBe(true);
  });

  test("未超上限时一个都不删（防把 LRU 写成无条件清理）", () => {
    const seeded = seedOldDumps(10);
    const messages = orphanMessages();
    dumpProtocolViolation(messages, checkMessageHistoryIntegrity(messages), {
      providerName: "deepseek",
      dumpDir,
      now: Date.now(),
    });

    expect(readdirSync(dumpDir).length).toBe(11);
    expect(seeded.every((p) => existsSync(p))).toBe(true);
  });

  test("目录里的非样本文件不被 LRU 碰到（只认 protocol-violation- 前缀）", () => {
    seedOldDumps(MAX + 5);
    const foreign = join(dumpDir, "README-别删我.txt");
    writeFileSync(foreign, "人写的说明");
    const t = new Date(Date.now() - 999 * 60_000); // 故意做成最旧
    utimesSync(foreign, t, t);

    const messages = orphanMessages();
    dumpProtocolViolation(messages, checkMessageHistoryIntegrity(messages), {
      providerName: "deepseek",
      dumpDir,
      now: Date.now(),
    });

    // 即使它是目录里 mtime 最旧的，也不该被当成样本回收
    expect(existsSync(foreign)).toBe(true);
  });
});
