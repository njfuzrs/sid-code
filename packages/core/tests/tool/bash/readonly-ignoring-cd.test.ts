/**
 * isReadOnlyIgnoringCd：只给 Bash 串行失败级联用的判据（query/tool-executor.ts GAP-02）。
 *
 * 两条要同时锁住：
 *   1. 轨迹里被误跳的形态（cd 前缀 + 只读诊断）判为只读；
 *   2. 严格口径 isReadOnlyCommand **不变**——cd 前缀仍不算只读，否则权限放行、
 *      并发分区和 cwd 写回都会跟着变（见源码注释）。
 */
import { describe, test, expect } from "bun:test";
import {
  isReadOnlyCommand,
  isReadOnlyIgnoringCd,
} from "@sid-code/core/tool/bash/read-only-validation.ts";

describe("isReadOnlyIgnoringCd", () => {
  test("轨迹原形：cd 前缀的只读诊断判为只读", () => {
    for (const c of [
      `cd /repo && echo "=== x ===" && ls -la "a.md" && ls "b.md" 2>&1`,
      `cd /repo && grep -n "a\\|b" "f.md" | head -5; echo "--- z ---"`,
      `cd /a/b && git status --short`,
      // 多行脚本形态（20261104-100700 轨迹）；for 循环在严格口径下本就判非只读，不在本判据范围
      `cd ~/x\necho "=== y ==="\nls a\nls b`,
      `pushd /tmp && ls && popd`,
      `cd /repo`,
    ]) {
      expect(isReadOnlyIgnoringCd(c), c).toBe(true);
    }
  });

  test("写操作照样判为非只读（cd 不能把写操作洗白）", () => {
    for (const c of [
      `cd build && make`,
      `cd /repo && rm -rf dist`,
      `cd /repo && git checkout main`,
      `cd /repo && echo x > out.txt`,
      `cd /repo && sed -i 's/a/b/' f`,
      `mkdir -p out`,
    ]) {
      expect(isReadOnlyIgnoringCd(c), c).toBe(false);
    }
  });

  test("严格口径不受影响：cd 前缀在 isReadOnlyCommand 里仍是非只读", () => {
    expect(isReadOnlyCommand(`cd /repo && ls`)).toBe(false);
    expect(isReadOnlyCommand(`cd /repo`)).toBe(false);
    expect(isReadOnlyCommand(`ls`)).toBe(true);
  });
});
