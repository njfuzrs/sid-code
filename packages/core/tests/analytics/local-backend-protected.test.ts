/**
 * 特权后端的 _PROTECTED_ 双通道落盘行为（缺陷清单 P1-7）
 *
 * 修复前：`extractProtectedFields` / `hasProtectedFields` 零消费者——双通道机制
 * 只有「剥离」这一半在用（sink 对非特权后端调 stripProtectedFields），
 * 「提取」与「检测」两个函数空转。特权后端把受保护字段与普通字段平铺混放，
 * 下游任何新消费方都得自己重新实现一遍前缀判断才知道什么不能外传——
 * 而漏掉这层判断是静默的。
 *
 * 修复后：特权后端把受保护字段提取到独立的 `protected` 段，
 * 「不要外传 protected 段」成为结构性约束，不依赖每个消费方各自记得。
 *
 * ⚠️ 落盘隔离（CLAUDE.md 测试约定）：LocalEventBackend 会真的写文件。
 * 它的构造函数第二参数接受 dir，本测试全部传 tmpdir——不设 dir 会写进
 * ~/.sid-code/telemetry/events.jsonl，即「测试全绿但污染用户真实遥测数据」
 * 那个已经发生过一次的故障形态（见 telemetry-test-isolation 记忆）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEventBackend } from "@sid-code/core/analytics/exporters/local.ts";
import { PROTECTED_PREFIX } from "@sid-code/core/analytics/privacy.ts";
import type { EventMetadata } from "@sid-code/core/analytics/index.ts";

const created: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sid-local-backend-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

/** 写一条事件并等落盘完成（send 是 fire-and-forget，用 shutdown 排空写链） */
async function writeAndRead(
  metadata: EventMetadata,
  eventName = "probe",
): Promise<Record<string, any>> {
  const dir = freshDir();
  const backend = new LocalEventBackend("sess-test", dir);
  backend.send(eventName, metadata);
  await backend.shutdown();

  const file = join(dir, "events.jsonl");
  expect(existsSync(file)).toBe(true);
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0]!);
}

describe("P1-7 · 特权后端分离 protected 段", () => {
  test("含受保护字段时，敏感值去前缀后单独成段", async () => {
    const record = await writeAndRead({
      tool_name: "mcp_tool" as any,
      duration_ms: 12,
      [`${PROTECTED_PREFIX}mcp_server`]: "acme_internal" as any,
      [`${PROTECTED_PREFIX}mcp_tool`]: "deploy" as any,
    });

    // 普通字段留在 metadata，且已剥离受保护键
    expect(record.metadata.tool_name).toBe("mcp_tool");
    expect(record.metadata.duration_ms).toBe(12);
    expect(record.metadata[`${PROTECTED_PREFIX}mcp_server`]).toBeUndefined();

    // 受保护字段进 protected 段，键名已去前缀（便于消费方直接读）
    expect(record.protected.mcp_server).toBe("acme_internal");
    expect(record.protected.mcp_tool).toBe("deploy");

    // 结构性约束：metadata 段序列化后不含任何敏感值。
    // 这是本次修复的核心价值——下游只要不碰 protected 段就天然安全。
    expect(JSON.stringify(record.metadata)).not.toContain("acme_internal");
  });

  test("无受保护字段时不产生 protected 段（保持零拷贝快路径）", async () => {
    const record = await writeAndRead({ tool_name: "bash" as any, ok: true });
    expect(record.metadata.tool_name).toBe("bash");
    expect(record.metadata.ok).toBe(true);
    expect("protected" in record).toBe(false);
  });

  test("事件名 / sessionId / timestamp 三个信封字段保持不变（不破坏既有消费方）", async () => {
    const record = await writeAndRead({ a: 1 }, "startup_timing");
    expect(record.eventName).toBe("startup_timing");
    expect(record.sessionId).toBe("sess-test");
    expect(typeof record.timestamp).toBe("number");
  });

  test("落盘目标严格限定在传入目录（隔离契约自证）", async () => {
    const dir = freshDir();
    const backend = new LocalEventBackend("sess-iso", dir);
    backend.send("probe", { a: 1 });
    await backend.shutdown();
    // 断言写在 tmpdir 而非用户家目录：若构造参数被改坏，这条会先失败
    expect(existsSync(join(dir, "events.jsonl"))).toBe(true);
  });
});
