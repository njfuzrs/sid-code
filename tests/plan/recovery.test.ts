/**
 * Plan Recovery Hook 单测 (ADR-028 §3.2)
 *
 * 覆盖矩阵:
 *   4 类 trigger (tool_failure / file_not_found / permission_denied / user_correction)
 *   × shouldTrigger / buildRecoveryHint / 抖动守护 (windowSize=5)
 *
 * 加边界: 无 plan 路径 / hint 文本不可漏关键提示 / reset / 自定义 windowSize
 */

import { describe, test, expect } from "bun:test";
import {
  DefaultRecoveryHook,
  getSharedRecoveryHook,
  _setSharedRecoveryHookForTest,
  classifyRecoveryTrigger,
  type RecoveryContext,
  type RecoveryTrigger,
} from "../../src/plan/recovery.ts";

const baseCtx: RecoveryContext = {
  toolName: "read",
  errorMessage: "ENOENT: no such file or directory",
  failedArgs: { file_path: "/tmp/missing.txt" },
  currentPlanFilePath: "/Users/x/.sid-code/plans/plan-2026-05-31.md",
  planStepIndex: 2,
};

describe("DefaultRecoveryHook — shouldTrigger 抖动守护", () => {
  test("第一次触发 shouldTrigger=true", () => {
    const h = new DefaultRecoveryHook();
    expect(h.shouldTrigger("file_not_found", baseCtx)).toBe(true);
  });

  test("同 trigger + 同 plan 5 次内允许, 第 6 次拒绝", () => {
    const h = new DefaultRecoveryHook();
    for (let i = 0; i < 5; i++) {
      expect(h.shouldTrigger("file_not_found", baseCtx)).toBe(true);
      h.recordTrigger("file_not_found", baseCtx.currentPlanFilePath);
    }
    expect(h.shouldTrigger("file_not_found", baseCtx)).toBe(false);
  });

  test("不同 trigger 不互相影响 (各自独立窗口)", () => {
    const h = new DefaultRecoveryHook();
    for (let i = 0; i < 5; i++) h.recordTrigger("file_not_found", baseCtx.currentPlanFilePath);
    // file_not_found 已用尽
    expect(h.shouldTrigger("file_not_found", baseCtx)).toBe(false);
    // tool_failure 新窗口
    expect(h.shouldTrigger("tool_failure", baseCtx)).toBe(true);
  });

  test("不同 plan 文件不互相影响", () => {
    const h = new DefaultRecoveryHook();
    const planA = "/p/A.md";
    const planB = "/p/B.md";
    for (let i = 0; i < 5; i++) h.recordTrigger("tool_failure", planA);
    expect(h.shouldTrigger("tool_failure", { ...baseCtx, currentPlanFilePath: planA })).toBe(false);
    expect(h.shouldTrigger("tool_failure", { ...baseCtx, currentPlanFilePath: planB })).toBe(true);
  });

  test("空 plan 路径直接拒绝触发", () => {
    const h = new DefaultRecoveryHook();
    expect(h.shouldTrigger("tool_failure", { ...baseCtx, currentPlanFilePath: "" })).toBe(false);
  });

  test("自定义 windowSize=2 时第 3 次拒绝", () => {
    const h = new DefaultRecoveryHook(2);
    h.recordTrigger("tool_failure", baseCtx.currentPlanFilePath);
    h.recordTrigger("tool_failure", baseCtx.currentPlanFilePath);
    expect(h.shouldTrigger("tool_failure", baseCtx)).toBe(false);
  });
});

describe("DefaultRecoveryHook — buildRecoveryHint 4 类 trigger", () => {
  const h = new DefaultRecoveryHook();

  test("file_not_found hint 含 ls/glob 建议 + plan 路径", () => {
    const txt = h.buildRecoveryHint("file_not_found", baseCtx);
    expect(txt).toContain("plan-recovery");
    expect(txt).toContain("文件/目录不存在");
    expect(txt).toContain(baseCtx.currentPlanFilePath);
    expect(txt).toMatch(/ls|glob/);
    // 关键守护: 不要 hallucinate 创建
    expect(txt).toContain("hallucinate");
  });

  test("permission_denied hint 含'不要绕过 permission'", () => {
    const ctx: RecoveryContext = {
      ...baseCtx,
      toolName: "edit",
      errorMessage: "permission denied: /etc/hosts",
    };
    const txt = h.buildRecoveryHint("permission_denied", ctx);
    expect(txt).toContain("permission");
    expect(txt).toContain("不要绕过");
  });

  test("user_correction hint 含'写进 plan 文件'", () => {
    const ctx: RecoveryContext = {
      ...baseCtx,
      errorMessage: "用户希望先做迁移再删除",
    };
    const txt = h.buildRecoveryHint("user_correction", ctx);
    expect(txt).toContain("用户");
    expect(txt).toContain("plan");
    expect(txt).toContain(baseCtx.currentPlanFilePath);
  });

  test("tool_failure 默认 hint 含'重新评估这一步'", () => {
    const txt = h.buildRecoveryHint("tool_failure", baseCtx);
    expect(txt).toContain("重新评估");
    expect(txt).toContain("plan");
  });

  test("hint 文本永远引用 currentPlanFilePath (回写位置明确)", () => {
    const triggers: RecoveryTrigger[] = [
      "tool_failure",
      "file_not_found",
      "permission_denied",
      "user_correction",
    ];
    for (const t of triggers) {
      const txt = h.buildRecoveryHint(t, baseCtx);
      expect(txt).toContain(baseCtx.currentPlanFilePath);
    }
  });

  test("超长 errorMessage 被截断到 200 字符 (避免 prompt 爆炸)", () => {
    const longMsg = "A".repeat(2000);
    const ctx = { ...baseCtx, errorMessage: longMsg };
    const txt = h.buildRecoveryHint("tool_failure", ctx);
    // 文本中不应包含完整 2000 个 A
    expect(txt.indexOf("A".repeat(500))).toBe(-1);
  });

  test("planStepIndex=null 时 hint 显示 'off-plan'", () => {
    const ctx = { ...baseCtx, planStepIndex: null };
    const txt = h.buildRecoveryHint("tool_failure", ctx);
    expect(txt).toContain("off-plan");
  });
});

describe("classifyRecoveryTrigger — 按错误消息内容判定 (bug fix)", () => {
  test("read 目录当文件读 → tool_failure (不是 file_not_found)", () => {
    // 复现原始 bug: 路径存在但是目录, 旧逻辑误报"文件/目录不存在"
    const msg = "错误: '/Users/x/Code/sid-code/src/entrypoints' 是一个目录，不是文件。请使用 ls 工具列出目录内容。";
    expect(classifyRecoveryTrigger("read", msg)).toBe("tool_failure");
  });

  test("read 真·文件不存在 → file_not_found", () => {
    const msg = "错误: 文件不存在: /tmp/nope.txt\n当前工作目录: /tmp";
    expect(classifyRecoveryTrigger("read", msg)).toBe("file_not_found");
  });

  test("底层 ENOENT → file_not_found", () => {
    expect(classifyRecoveryTrigger("read", "ENOENT: no such file or directory, open '/x'")).toBe("file_not_found");
  });

  test("read 无权限 → permission_denied", () => {
    expect(classifyRecoveryTrigger("read", "错误: 无权限读取文件: /etc/shadow")).toBe("permission_denied");
  });

  test("EACCES → permission_denied", () => {
    expect(classifyRecoveryTrigger("edit", "EACCES: permission denied, open '/etc/hosts'")).toBe("permission_denied");
  });

  test("edit 未找到要替换的字符串 → tool_failure", () => {
    const msg = "错误: 未找到要替换的字符串（精确/灵活/正则/模糊匹配均未命中）。";
    expect(classifyRecoveryTrigger("edit", msg)).toBe("tool_failure");
  });

  test("edit 模糊匹配歧义 → tool_failure", () => {
    const msg = "错误: old_string 与文件中多个位置都近似匹配（模糊匹配歧义），无法确定要修改哪一处。";
    expect(classifyRecoveryTrigger("edit", msg)).toBe("tool_failure");
  });

  test("edit 文件不存在(创建失败) → file_not_found", () => {
    const msg = "错误: 文件不存在: /tmp/missing/target.ts\n当前工作目录: /tmp";
    expect(classifyRecoveryTrigger("edit", msg)).toBe("file_not_found");
  });

  test("read 文件过大 → tool_failure", () => {
    const msg = "错误: 文件过大 (42.0 MB，超过 10 MB 上限)。请使用 offset 和 limit 参数分段读取。";
    expect(classifyRecoveryTrigger("read", msg)).toBe("tool_failure");
  });

  test("非 read/edit 工具的通用失败 → tool_failure", () => {
    expect(classifyRecoveryTrigger("bash", "command failed with exit code 1")).toBe("tool_failure");
  });

  test("空错误消息 → tool_failure (兜底不崩)", () => {
    expect(classifyRecoveryTrigger("read", "")).toBe("tool_failure");
  });

  test("permission 优先级高于 file_not_found (同时出现权限关键词)", () => {
    // 防御: 若消息同时含"文件不存在"与"无权限", 权限判定应先命中
    const msg = "错误: 无权限读取文件, 且该文件不存在";
    expect(classifyRecoveryTrigger("read", msg)).toBe("permission_denied");
  });
});

describe("DefaultRecoveryHook — recordTrigger / reset / counter", () => {
  test("recordTrigger 累加可被 getTriggerCount 读出", () => {
    const h = new DefaultRecoveryHook();
    h.recordTrigger("tool_failure", baseCtx.currentPlanFilePath);
    h.recordTrigger("tool_failure", baseCtx.currentPlanFilePath);
    expect(h.getTriggerCount("tool_failure", baseCtx.currentPlanFilePath)).toBe(2);
  });

  test("reset 清零所有计数器", () => {
    const h = new DefaultRecoveryHook();
    for (let i = 0; i < 3; i++) h.recordTrigger("file_not_found", "/x.md");
    h.reset();
    expect(h.getTriggerCount("file_not_found", "/x.md")).toBe(0);
  });

  test("getSharedRecoveryHook 返回单例", () => {
    _setSharedRecoveryHookForTest(null);
    const a = getSharedRecoveryHook();
    const b = getSharedRecoveryHook();
    expect(a).toBe(b);
  });

  test("_setSharedRecoveryHookForTest 可注入 mock", () => {
    const mock = new DefaultRecoveryHook(99);
    _setSharedRecoveryHookForTest(mock);
    expect(getSharedRecoveryHook()).toBe(mock);
    _setSharedRecoveryHookForTest(null); // 清理
  });
});
