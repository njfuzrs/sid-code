/**
 * MCP 接入层遗留子项回归：D12-3（进程内传输 sanitize）/ D12-4（close 通知对端）/
 * D17-3（approveAll 按项目，不再全局）。
 *
 * 变异自证：
 * - 去掉 InProcessTransportImpl 里三处 sanitizeStrings → 「孤立 surrogate」组变红；
 * - close() 去掉 peer._peerClosed() → 「close 通知对端」组变红；
 * - getProjectServerApproval 改回 `if (approvals.approveAll) return "approved"` 并让
 *   setApproveAll 写全局布尔 → 「approveAll 按项目」组变红。
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createLinkedTransportPair } from "@sid-code/core/mcp/transport.ts";
import type { JsonRpcNotification } from "@sid-code/core/mcp/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONE = "a\uD83Db";

describe("D12-3 进程内传输清理孤立 surrogate", () => {
  test("请求 / 应答 / 通知三条路径都过 sanitizeStrings", async () => {
    const [a, b] = createLinkedTransportPair();
    let seenReq: unknown;
    b.onRequest = async (req) => {
      seenReq = req.params;
      return { jsonrpc: "2.0", id: req.id, result: { text: LONE } };
    };
    const got: JsonRpcNotification[] = [];
    b.onNotification = (n) => got.push(n);

    const resp = await a.send({ jsonrpc: "2.0", id: 1, method: "x", params: { text: LONE } });
    a.sendNotification?.({ jsonrpc: "2.0", method: "n", params: { text: LONE } });
    await sleep(10);

    expect(seenReq).toEqual({ text: "a�b" });
    expect(resp.result).toEqual({ text: "a�b" });
    expect(got[0]?.params).toEqual({ text: "a�b" });
    a.close();
  });
});

describe("D12-4 close 通知对端", () => {
  test("关一头：对端触发 onClose、对端 pending 被 reject、对端后续 send 抛错", async () => {
    const [a, b] = createLinkedTransportPair();
    // a 永不应答 b 的请求，制造一个挂起的 pending
    a.onRequest = () => new Promise(() => {});
    let bClosed = 0;
    let aClosed = 0;
    b.onClose = () => bClosed++;
    a.onClose = () => aClosed++;

    const pending = b.send({ jsonrpc: "2.0", id: 7, method: "slow" });
    await sleep(5);
    a.close();

    await expect(pending).rejects.toThrow("传输已关闭");
    expect(bClosed).toBe(1);
    // 主动关闭的一方不触发自己的 onClose（D1 语义：onClose = 意外断开）
    expect(aClosed).toBe(0);
    await expect(b.send({ jsonrpc: "2.0", id: 8, method: "y" })).rejects.toThrow();

    // 幂等：两头再 close 都不重复触发
    a.close();
    b.close();
    expect(bClosed).toBe(1);
    expect(aClosed).toBe(0);
  });
});

describe("D17-3 approveAll 按项目生效", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.SID_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), "sid-appr-all-"));
    process.env.SID_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("在项目 A 打开，只对 A 生效，项目 B 仍 pending", async () => {
    const a = await import("@sid-code/core/mcp/approval.ts");
    a.setApproveAll(true, "/proj/A");
    expect(a.getProjectServerApproval("s1", "/proj/A")).toBe("approved");
    expect(a.getProjectServerApproval("s1", "/proj/B")).toBe("pending");
  });

  test("显式 rejected 优先于 approveAll；关掉后回到 pending", async () => {
    const a = await import("@sid-code/core/mcp/approval.ts");
    a.setApproveAll(true, "/proj/A");
    a.rejectProjectServer("bad", "/proj/A");
    expect(a.getProjectServerApproval("bad", "/proj/A")).toBe("rejected");
    a.setApproveAll(false, "/proj/A");
    expect(a.getProjectServerApproval("s1", "/proj/A")).toBe("pending");
  });

  test("旧版全局 approveAll:true 不再放行任何项目（fail-closed），写盘时被清除", async () => {
    const a = await import("@sid-code/core/mcp/approval.ts");
    const { sidPaths } = await import("@sid-code/core/config/paths.ts");
    mkdirSync(sidPaths.state(), { recursive: true });
    const file = sidPaths.stateFile("mcp-approvals.json");
    writeFileSync(file, JSON.stringify({ approved: [], rejected: [], approveAll: true }));
    expect(file.startsWith(dir)).toBe(true);

    expect(a.getProjectServerApproval("s1", "/any")).toBe("pending");
    a.approveProjectServer("ok", "/any");
    expect(JSON.parse(readFileSync(file, "utf-8")).approveAll).toBeUndefined();
  });
});
