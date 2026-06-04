/**
 * Spec 18 §7：Swarm 多代理协作单测
 * 覆盖文件邮箱（有序投递/消费/已读）和权限同步（leader 裁决/团队 always-allow）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Mailbox } from "../../src/swarm/mailbox.ts";
import { PermissionSync } from "../../src/swarm/permission-sync.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-swarm-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("Mailbox", () => {
  it("send/drain 往返", () => {
    const mb = new Mailbox(dir);
    mb.send({ from: "leader", to: "alice", content: "干活", kind: "task", timestamp: 1 });
    const msgs = mb.drain("alice");
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("干活");
    expect(msgs[0].from).toBe("leader");
    expect(msgs[0].seq).toBe(1);
  });

  it("drain 后清空（消息标记已读）", () => {
    const mb = new Mailbox(dir);
    mb.send({ from: "a", to: "bob", content: "x", timestamp: 1 });
    expect(mb.drain("bob").length).toBe(1);
    expect(mb.drain("bob").length).toBe(0); // 第二次为空
  });

  it("多条消息按序号升序", () => {
    const mb = new Mailbox(dir);
    mb.send({ from: "a", to: "carol", content: "1", timestamp: 1 });
    mb.send({ from: "a", to: "carol", content: "2", timestamp: 2 });
    mb.send({ from: "a", to: "carol", content: "3", timestamp: 3 });
    const msgs = mb.drain("carol");
    expect(msgs.map((m) => m.content)).toEqual(["1", "2", "3"]);
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("peekCount 不消费", () => {
    const mb = new Mailbox(dir);
    mb.send({ from: "a", to: "dave", content: "x", timestamp: 1 });
    mb.send({ from: "a", to: "dave", content: "y", timestamp: 2 });
    expect(mb.peekCount("dave")).toBe(2);
    expect(mb.peekCount("dave")).toBe(2); // 仍为 2
    expect(mb.drain("dave").length).toBe(2);
    expect(mb.peekCount("dave")).toBe(0);
  });

  it("不同收件箱相互隔离", () => {
    const mb = new Mailbox(dir);
    mb.send({ from: "a", to: "x", content: "for-x", timestamp: 1 });
    mb.send({ from: "a", to: "y", content: "for-y", timestamp: 1 });
    expect(mb.drain("x").map((m) => m.content)).toEqual(["for-x"]);
    expect(mb.drain("y").map((m) => m.content)).toEqual(["for-y"]);
  });

  it("已读后新消息序号继续递增（不复用）", () => {
    const mb = new Mailbox(dir);
    mb.send({ from: "a", to: "eve", content: "1", timestamp: 1 });
    mb.drain("eve");
    const m2 = mb.send({ from: "a", to: "eve", content: "2", timestamp: 2 });
    expect(m2.seq).toBe(2); // 不复用 1
  });
});

describe("PermissionSync", () => {
  it("无 leader 裁决回调时 fail-closed 拒绝", async () => {
    const ps = new PermissionSync();
    const v = await ps.requestPermission({ teammate: "a", toolName: "bash", description: "rm" });
    expect(v).toBe("deny");
  });

  it("leader 裁决 allow 透传", async () => {
    const ps = new PermissionSync();
    ps.setArbiter(async () => "allow");
    const v = await ps.requestPermission({ teammate: "a", toolName: "bash", description: "ls" });
    expect(v).toBe("allow");
  });

  it("allow-always 缓存团队级放行", async () => {
    const ps = new PermissionSync();
    let callCount = 0;
    ps.setArbiter(async () => {
      callCount++;
      return "allow-always";
    });
    const v1 = await ps.requestPermission({ teammate: "a", toolName: "bash", description: "x" });
    expect(v1).toBe("allow-always");
    // 第二次同工具：命中缓存，不再调 arbiter
    const v2 = await ps.requestPermission({ teammate: "b", toolName: "bash", description: "y" });
    expect(v2).toBe("allow");
    expect(callCount).toBe(1);
  });

  it("preApprove 预置团队 always-allow", async () => {
    const ps = new PermissionSync();
    ps.preApprove(["read", "grep"]);
    // 即使没有 arbiter，预置工具也直接放行
    const v = await ps.requestPermission({ teammate: "a", toolName: "read", description: "z" });
    expect(v).toBe("allow");
  });

  it("reset 清空缓存和裁决回调", async () => {
    const ps = new PermissionSync();
    ps.preApprove(["read"]);
    ps.reset();
    const v = await ps.requestPermission({ teammate: "a", toolName: "read", description: "z" });
    expect(v).toBe("deny"); // 清空后无 arbiter → 拒绝
  });
});
