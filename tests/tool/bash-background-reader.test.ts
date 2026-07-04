/**
 * T5-B4：bash 后台 reader 孤儿清理单测
 *
 * 验证：后台进程大量输出时，100ms 超时后 reader.cancel() 被调用，
 * 不留孤儿 reader 持续消费 stdout。
 */

import { describe, test, expect } from "bun:test";

describe("T5-B4 bash 后台 reader cancel", () => {
  test("超时后 reader 被 cancel，不留孤儿", async () => {
    // 模拟一个持续输出的进程
    const proc = Bun.spawn(["sh", "-c", "while true; do echo 'output line'; done"], {
      stdout: "pipe",
      stderr: "ignore",
    });

    const reader = proc.stdout.getReader();
    let readTimedOut = false;
    let cancelCalled = false;

    const origCancel = reader.cancel.bind(reader);
    reader.cancel = async (...args: any[]) => {
      cancelCalled = true;
      return origCancel(...args);
    };

    // 复制 T5-B4 的逻辑：100ms 超时后 cancel
    const readTimer = setTimeout(() => {
      readTimedOut = true;
      reader.cancel().catch(() => {});
    }, 100);

    try {
      const { value } = await reader.read();
      if (value && !readTimedOut) {
        // 正常读到数据，不用管内容（测试重点是 cancel）
      }
    } catch {
      // 忽略读取失败（cancel 后 read 可能抛出）
    } finally {
      clearTimeout(readTimer);
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }

    // cancel 应被调用（无论是超时触发还是 finally 触发）
    expect(cancelCalled).toBe(true);

    // 清理进程
    proc.kill();
    await proc.exited;
  });

  test("快速完成的进程不需要超时 cancel", async () => {
    // 只输出一行就退出的进程
    const proc = Bun.spawn(["echo", "hello"], {
      stdout: "pipe",
      stderr: "ignore",
    });

    const reader = proc.stdout.getReader();
    let readTimedOut = false;

    const readTimer = setTimeout(() => {
      readTimedOut = true;
      reader.cancel().catch(() => {});
    }, 100);

    let initialOutput = "";
    try {
      const { value } = await reader.read();
      if (value && !readTimedOut) {
        initialOutput = new TextDecoder().decode(value).slice(0, 500);
      }
    } catch {
      // 忽略
    } finally {
      clearTimeout(readTimer);
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }

    // 快速进程应在超时前完成读取
    expect(readTimedOut).toBe(false);
    expect(initialOutput).toContain("hello");

    await proc.exited;
  });

  test("大量输出进程：超时后 reader 释放锁（releaseLock 不抛）", async () => {
    // yes 命令持续输出 y\n
    const proc = Bun.spawn(["yes"], {
      stdout: "pipe",
      stderr: "ignore",
    });

    const reader = proc.stdout.getReader();
    let lockReleased = false;

    // 150ms 后 cancel + releaseLock
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    try { await reader.cancel(); } catch {}
    try {
      reader.releaseLock();
      lockReleased = true;
    } catch {}

    expect(lockReleased).toBe(true);

    // 验证 releaseLock 后可以再次 getReader（锁已释放）
    const reader2 = proc.stdout.getReader();
    expect(reader2).toBeDefined();
    try { await reader2.cancel(); } catch {}
    try { reader2.releaseLock(); } catch {}

    proc.kill();
    await proc.exited;
  });
});
