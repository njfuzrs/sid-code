/**
 * 非交互权限拒绝的汇总（D1）。
 *
 * 决策本身不变（ask 仍自动 deny），变的是「跑完的人看不看得见」。
 * 汇总只读 denial tracking 的 bySignature：recordSuccess 会删掉已放行的签名，
 * 所以出现在这里的都是到会话结束仍未放行的。
 */

import { describe, test, expect } from "bun:test";
import {
  createDenialTrackingState,
  recordDenial,
  recordSuccess,
} from "@sid-code/core/permission/denial-tracking.ts";
import { summarizeDenials, formatDenialSummary } from "@sid-code/core/permission/denial-summary.ts";

describe("summarizeDenials", () => {
  test("空状态 → 空清单", () => {
    expect(summarizeDenials(createDenialTrackingState())).toEqual([]);
    expect(summarizeDenials(undefined)).toEqual([]);
  });

  test("按签名拆出工具名与资源，次数多的在前", () => {
    let state = createDenialTrackingState();
    state = recordDenial(state, "Bash", "非交互模式下自动拒绝: 需确认", "rm -rf /");
    state = recordDenial(state, "Bash", "非交互模式下自动拒绝: 需确认", "rm -rf /");
    state = recordDenial(state, "Write", "路径在工作区外", "/tmp/x");

    const list = summarizeDenials(state);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ tool_name: "Bash", resource: "rm -rf /", count: 2 });
    expect(list[1]).toMatchObject({ tool_name: "Write", resource: "/tmp/x", count: 1 });
  });

  test("放行过的签名不再出现", () => {
    let state = createDenialTrackingState();
    state = recordDenial(state, "Read", "需确认", "a.ts");
    state = recordSuccess(state, "Read", "a.ts");
    expect(summarizeDenials(state)).toEqual([]);
  });
});

describe("formatDenialSummary", () => {
  test("空清单 → 空串（调用方据此不打印）", () => {
    expect(formatDenialSummary([])).toBe("");
  });

  test("列出被拒操作并给出预授权提示", () => {
    const text = formatDenialSummary([
      { tool_name: "Bash", resource: "rm -rf /", count: 2, reason: "危险命令" },
    ]);
    expect(text).toContain("Bash");
    expect(text).toContain("rm -rf /");
    expect(text).toContain("×2");
    expect(text).toContain("--allowed-tools");
  });
});
