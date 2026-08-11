import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventDiskCache, type FailedEvent } from "@sid-code/core/analytics/disk-cache.ts";
import { QuadraticBackoff } from "@sid-code/core/analytics/backoff.ts";
import {
  sanitizeToolName,
  mcpToolDetailsForAnalytics,
  safeFileExtension,
} from "@sid-code/core/analytics/sanitize.ts";
import { PROTECTED_PREFIX } from "@sid-code/core/analytics/privacy.ts";

describe("磁盘缓存与跨会话恢复（spec 17 §4.1.1）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-diskcache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("失败事件写入磁盘", async () => {
    const cache = new EventDiskCache({ cacheDir: dir, sessionId: "s1", maxRetries: 8 });
    const events: FailedEvent[] = [
      { eventName: "e1", metadata: { a: 1 }, timestamp: Date.now(), attempts: 0 },
    ];
    await cache.queueFailedEvents(events);

    const files = readdirSync(dir).filter((f) => f.startsWith("failed_events"));
    expect(files.length).toBe(1);
  });

  test("空事件列表不创建文件", async () => {
    const cache = new EventDiskCache({ cacheDir: dir, sessionId: "s1", maxRetries: 8 });
    await cache.queueFailedEvents([]);
    expect(readdirSync(dir).filter((f) => f.startsWith("failed_events")).length).toBe(0);
  });

  test("retryPreviousBatches 成功后删除文件", async () => {
    // 模拟上次会话遗留的文件(不同 sessionId)
    const leftover = join(dir, "failed_events.old-session.deadbeef.jsonl");
    writeFileSync(
      leftover,
      JSON.stringify({ eventName: "e", metadata: {}, timestamp: Date.now(), attempts: 0 }) + "\n",
    );

    const cache = new EventDiskCache({ cacheDir: dir, sessionId: "new", maxRetries: 8 });
    let sent = 0;
    await cache.retryPreviousBatches(async (events) => {
      sent += events.length;
    });
    expect(sent).toBe(1);
    expect(existsSync(leftover)).toBe(false);
  });

  test("retryPreviousBatches 失败时保留文件", async () => {
    const leftover = join(dir, "failed_events.old.cafe.jsonl");
    writeFileSync(
      leftover,
      JSON.stringify({ eventName: "e", metadata: {}, timestamp: Date.now(), attempts: 0 }) + "\n",
    );

    const cache = new EventDiskCache({ cacheDir: dir, sessionId: "new", maxRetries: 8 });
    await cache.retryPreviousBatches(async () => {
      throw new Error("network down");
    });
    expect(existsSync(leftover)).toBe(true);
  });

  test("超过 maxRetries 的事件被丢弃", async () => {
    const leftover = join(dir, "failed_events.old.beef.jsonl");
    writeFileSync(
      leftover,
      JSON.stringify({ eventName: "e", metadata: {}, timestamp: Date.now(), attempts: 99 }) + "\n",
    );
    const cache = new EventDiskCache({ cacheDir: dir, sessionId: "new", maxRetries: 8 });
    let sent = 0;
    await cache.retryPreviousBatches(async (events) => { sent += events.length; });
    expect(sent).toBe(0);
    // 文件仍被删除(全部过期)
    expect(existsSync(leftover)).toBe(false);
  });
});

describe("二次退避（spec 17 §4.1.2）", () => {
  test("延迟随 attempts 二次增长", () => {
    const backoff = new QuadraticBackoff(500, 30_000, 8);
    expect(backoff.peekDelay()).toBe(0); // attempts=0
    backoff.schedule(async () => {});
    // 第一次调度后 attempts=1, 下一次延迟 = 500*1*1
    expect(backoff.attemptCount).toBe(1);
    expect(backoff.peekDelay()).toBe(500);
  });

  test("延迟封顶 maxDelayMs", () => {
    const backoff = new QuadraticBackoff(500, 1000, 100);
    for (let i = 0; i < 10; i++) backoff.schedule(async () => {});
    expect(backoff.peekDelay()).toBeLessThanOrEqual(1000);
  });

  test("超过 maxAttempts 后放弃并重置", () => {
    const backoff = new QuadraticBackoff(1, 10, 2);
    backoff.schedule(async () => {});
    backoff.schedule(async () => {});
    backoff.schedule(async () => {}); // 第 3 次超过 maxAttempts=2
    expect(backoff.attemptCount).toBe(0);
  });

  test("reset 清零", () => {
    const backoff = new QuadraticBackoff();
    backoff.schedule(async () => {});
    backoff.reset();
    expect(backoff.attemptCount).toBe(0);
  });
});

describe("工具名/路径脱敏（spec 17 §4.3）", () => {
  test("MCP 工具名脱敏为通用名", () => {
    expect(sanitizeToolName("mcp__github__create_pr")).toBe("mcp_tool");
  });

  test("内置工具保持原名", () => {
    expect(sanitizeToolName("read")).toBe("read");
    expect(sanitizeToolName("bash")).toBe("bash");
  });

  test("MCP 工具详情进入 _PROTECTED_ 通道", () => {
    const details = mcpToolDetailsForAnalytics("mcp__github__create_pr");
    expect(details[`${PROTECTED_PREFIX}mcp_server`]).toBe("github");
    expect(details[`${PROTECTED_PREFIX}mcp_tool`]).toBe("create_pr");
  });

  test("非 MCP 工具无详情", () => {
    expect(Object.keys(mcpToolDetailsForAnalytics("read")).length).toBe(0);
  });

  test("文件扩展名安全提取", () => {
    expect(safeFileExtension("foo.ts")).toBe("ts");
    expect(safeFileExtension("README")).toBe("none");
    expect(safeFileExtension("a.verylongextensionname")).toBe("other");
  });
});
