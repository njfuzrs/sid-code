/**
 * denial-tracking 熔断器回归测试（负收益防线审计 · 发现 1，2026-07-30）
 *
 * 被修复的缺陷：熔断器在 58,130 条真实审计日志里触发 **0 次**，根因是判据与检查点错位：
 *   - hard deny（如 `rm -rf /`）会 recordDenial 记账，却在 checker 就地 return，走不到熔断检查点；
 *   - ask（needsConfirmation）能走到检查点，但完全不记账。
 * 同时旧判据 `maxTotal: 20`（累计拒绝数）一旦可达就会误报上万次（反事实见 denial-tracking.ts 文件头），
 * 故判据改为「同一操作签名的连续拒绝」，并移除 maxTotal。
 *
 * 本文件的核心断言就是「阈值可达」——这是旧实现完全不具备的性质。
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { defaultConfig } from "../../src/config/config.ts";
import {
  createDenialTrackingState,
  recordDenial,
  recordSuccess,
  shouldFuse,
  denialSignature,
  DENIAL_LIMITS,
} from "../../src/permission/denial-tracking.ts";

describe("denial-tracking 纯逻辑（新判据：按操作签名的连续拒绝）", () => {
  test("同一签名连续拒绝达阈值 → 熔断", () => {
    let s = createDenialTrackingState();
    expect(shouldFuse(s, "bash", "rm -rf /")).toBe(false);
    for (let i = 0; i < DENIAL_LIMITS.maxConsecutive; i++) {
      s = recordDenial(s, "bash", "危险命令", "rm -rf /");
    }
    expect(shouldFuse(s, "bash", "rm -rf /")).toBe(true);
    expect(s.consecutiveDenials).toBe(DENIAL_LIMITS.maxConsecutive);
  });

  test("不同签名各自计数，不互相累加（旧全局计数会把它误判为死循环）", () => {
    let s = createDenialTrackingState();
    s = recordDenial(s, "write", "拒绝", "/a.ts");
    s = recordDenial(s, "write", "拒绝", "/b.ts");
    s = recordDenial(s, "write", "拒绝", "/c.ts");
    // 累计 3 次拒绝，但没有任何一个操作被连续拒 3 次 → 不该熔断
    expect(s.totalDenials).toBe(3);
    expect(shouldFuse(s, "write", "/a.ts")).toBe(false);
    expect(shouldFuse(s, "write", "/c.ts")).toBe(false);
  });

  test("熔断只对被反复拒的那个签名生效，不牵连无关操作", () => {
    let s = createDenialTrackingState();
    for (let i = 0; i < 5; i++) s = recordDenial(s, "bash", "危险命令", "rm -rf /");
    expect(shouldFuse(s, "bash", "rm -rf /")).toBe(true);
    expect(shouldFuse(s, "bash", "ls")).toBe(false);
    expect(shouldFuse(s, "write", "/tmp/x.ts")).toBe(false);
  });

  test("同签名一次成功 → 该签名连续计数归零（墙没了）", () => {
    let s = createDenialTrackingState();
    for (let i = 0; i < 3; i++) s = recordDenial(s, "write", "拒绝", "/a.ts");
    expect(shouldFuse(s, "write", "/a.ts")).toBe(true);
    s = recordSuccess(s, "write", "/a.ts");
    expect(shouldFuse(s, "write", "/a.ts")).toBe(false);
    expect(s.consecutiveDenials).toBe(0);
  });

  test("别的操作成功不清除仍在撞墙签名的计数（换条路成功≠原墙消失）", () => {
    let s = createDenialTrackingState();
    for (let i = 0; i < 3; i++) s = recordDenial(s, "bash", "危险命令", "rm -rf /");
    s = recordSuccess(s, "read", "/tmp/ok.txt");
    expect(shouldFuse(s, "bash", "rm -rf /")).toBe(true);
  });

  test("totalDenials 是纯观测量，累计再多也不触发熔断（旧 maxTotal:20 会误报上万次）", () => {
    let s = createDenialTrackingState();
    // 100 次全不同签名的拒绝：远超旧 maxTotal=20
    for (let i = 0; i < 100; i++) s = recordDenial(s, "write", "拒绝", `/f${i}.ts`);
    expect(s.totalDenials).toBe(100);
    expect(shouldFuse(s, "write", "/f100.ts")).toBe(false);
    expect(shouldFuse(s, "write", "/f99.ts")).toBe(false);
    // DENIAL_LIMITS 不再暴露 maxTotal（防止有人把它接回判据）
    expect((DENIAL_LIMITS as Record<string, unknown>).maxTotal).toBeUndefined();
  });

  test("resource 缺失时退化为工具名签名，仍能计数", () => {
    let s = createDenialTrackingState();
    for (let i = 0; i < 3; i++) s = recordDenial(s, "sometool", "拒绝");
    expect(shouldFuse(s, "sometool")).toBe(true);
    expect(denialSignature("sometool")).toBe(denialSignature("sometool", ""));
  });

  test("recordSuccess 不传 tool（兼容旧调用）→ 清空全部签名", () => {
    let s = createDenialTrackingState();
    for (let i = 0; i < 3; i++) s = recordDenial(s, "bash", "危险命令", "rm -rf /");
    s = recordSuccess(s);
    expect(shouldFuse(s, "bash", "rm -rf /")).toBe(false);
    expect(Object.keys(s.bySignature).length).toBe(0);
  });
});

describe("熔断可达性（发现 1 的核心：旧实现在这两条路上都不可达）", () => {
  test("hard deny 路径：同一危险命令连续 3 次 → 第 4 次熔断为人工确认", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const req = { toolName: "bash", input: { command: "rm -rf /" } };

    // 前 3 次：正常硬拒（记账，未达阈值）
    for (let i = 0; i < DENIAL_LIMITS.maxConsecutive; i++) {
      const r = await checker.check(req);
      expect(r.allowed).toBe(false);
      expect(r.decisionReason?.type).not.toBe("denialTracking");
    }

    // 第 4 次：达阈值 → 熔断。旧实现在此永远返回 dangerousCommand，denialTracking 永不出现。
    const fused = await checker.check(req);
    expect(fused.allowed).toBe(false);
    expect(fused.needsConfirmation).toBe(true);
    expect(fused.decisionReason?.type).toBe("denialTracking");
    expect(fused.metadata?.denialTrackingTriggered).toBe(true);
    expect(checker.getDenialTracking().consecutiveDenials).toBeGreaterThanOrEqual(
      DENIAL_LIMITS.maxConsecutive,
    );
  });

  test("ask 路径：用户连续拒绝同一操作 → recordUserDenial 记账并可达熔断", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const req = { toolName: "write", input: { file_path: "/tmp/ask-fuse-target.txt" } };

    const first = await checker.check(req);
    // 该操作走 ask 路径（需确认）——旧实现下这条路完全不记账
    expect(first.needsConfirmation).toBe(true);
    expect(checker.getDenialTracking().totalDenials).toBe(0);

    // 模拟用户在弹窗里连续拒绝（tool-executor 的接线点）
    for (let i = 0; i < DENIAL_LIMITS.maxConsecutive; i++) {
      checker.recordUserDenial(req, "用户拒绝");
    }
    expect(checker.getDenialTracking().totalDenials).toBe(DENIAL_LIMITS.maxConsecutive);

    const fused = await checker.check(req);
    expect(fused.decisionReason?.type).toBe("denialTracking");
    expect(fused.needsConfirmation).toBe(true);
  });

  test("dontAsk 模式下 hard deny 不熔断成确认（无 UI 通道，熔断成确认等于必然失败）", async () => {
    const checker = new PermissionChecker({ ...defaultConfig(), permissionMode: "dontAsk" });
    const req = { toolName: "bash", input: { command: "rm -rf /" } };
    for (let i = 0; i < 6; i++) {
      const r = await checker.check(req);
      expect(r.allowed).toBe(false);
      expect(r.needsConfirmation).toBeFalsy();
      expect(r.decisionReason?.type).not.toBe("denialTracking");
    }
  });

  test("拒绝不同操作不会误熔断（旧全局判据下这会在第 4 次误报）", async () => {
    // 走 hard deny 路径（会记账）且每次签名不同 → 连续计数永远停在 1，不该熔断。
    const checker = new PermissionChecker({ ...defaultConfig(), disallowedTools: ["bash"] });
    for (let i = 0; i < 8; i++) {
      const r = await checker.check({ toolName: "bash", input: { command: `echo case-${i}` } });
      expect(r.allowed).toBe(false);
      expect(r.decisionReason?.type).not.toBe("denialTracking");
    }
    // 8 次硬拒都已记账（证明走的确实是记账路径），但无一签名连续达阈值
    expect(checker.getDenialTracking().totalDenials).toBe(8);
    expect(checker.getDenialTracking().consecutiveDenials).toBe(1);
  });

  test("resetDenialTracking 归零（/clear 接线点，旧实现无任何生产调用方）", async () => {
    const checker = new PermissionChecker(defaultConfig());
    const req = { toolName: "bash", input: { command: "rm -rf /" } };
    for (let i = 0; i < DENIAL_LIMITS.maxConsecutive; i++) await checker.check(req);
    expect(checker.getDenialTracking().totalDenials).toBeGreaterThan(0);
    checker.resetDenialTracking();
    expect(checker.getDenialTracking().totalDenials).toBe(0);
    expect(checker.getDenialTracking().consecutiveDenials).toBe(0);
    // 归零后重新计数，不残留旧签名
    const r = await checker.check(req);
    expect(r.decisionReason?.type).not.toBe("denialTracking");
  });
});
