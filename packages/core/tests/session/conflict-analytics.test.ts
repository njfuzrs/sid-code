/**
 * 并发冲突检测埋点测试
 */

import { describe, it, expect } from "bun:test";
import { recordConflict, hashFilePath } from "../../src/session/conflict-analytics.ts";

describe("并发冲突埋点", () => {
  it("应该对文件路径做哈希脱敏", () => {
    const hash1 = hashFilePath("/test/file1.ts");
    const hash2 = hashFilePath("/test/file2.ts");

    // 不同路径应该有不同的哈希
    expect(hash1).not.toBe(hash2);

    // 哈希应该是 8 位十六进制
    expect(hash1).toMatch(/^[0-9a-f]{8}$/);
    expect(hash2).toMatch(/^[0-9a-f]{8}$/);
  });

  it("应该记录冲突事件", () => {
    // 这个测试主要验证函数能正常调用，不抛异常
    // 实际输出写入 debug 日志，不便于直接断言
    expect(() => {
      recordConflict("/test/file.ts", 2, "critical", "stop", "edit");
    }).not.toThrow();
  });

  it("应该支持所有 action 类型", () => {
    const actions = ["stop", "skip", "continue", "blocked", "headless_fallback"] as const;

    for (const action of actions) {
      expect(() => {
        recordConflict("/test/file.ts", 1, "warning", action, "write");
      }).not.toThrow();
    }
  });
});
