/**
 * 连续编辑失败计数提醒 —— 单元测试
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyEditFailure,
  recordEditOutcome,
  setEditFailureReminderSink,
  SNIPPET_HEADER,
  type EditFailureStore,
} from "@sid-code/core/query/edit-failure-tracker.ts";

/** 轻量 store：满足 get/set 接口，复刻 SessionState.sessionData 语义。 */
function makeStore(): EditFailureStore {
  const data = new Map<string, any>();
  return {
    get: (k) => data.get(k),
    set: (k, v) => {
      data.set(k, v);
    },
  };
}

// 每个用例后清理可能被前一用例设置的环境变量，避免串味。
afterEach(() => {
  delete process.env.SID_EDIT_FAILURE_REMINDER_THRESHOLD;
  delete process.env.SID_DISABLE_EDIT_FAILURE_REMINDER;
});

describe("recordEditOutcome — 基础计数与阈值", () => {
  test("失败次数未达阈值(默认3)时不提醒", () => {
    const s = makeStore();
    expect(
      recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到要替换的字符串"),
    ).toBeUndefined();
    expect(
      recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到要替换的字符串"),
    ).toBeUndefined();
  });

  test("第3次失败达阈值 → 返回提醒", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到要替换的字符串");
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到要替换的字符串");
    const r = recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到要替换的字符串");
    expect(r).toBeDefined();
    expect(r).toContain("连续 3 次");
    expect(r).toContain("<system-reminder>");
  });

  test("成功编辑清零 → 之后重新计数", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    // 成功一次 → 清零
    expect(recordEditOutcome(s, "edit", "/a.ts", false, "")).toBeUndefined();
    // 再失败两次仍未达阈值（说明确实从 0 起算）
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeUndefined();
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeUndefined();
  });

  test("不同文件独立计数", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    // b 文件首次失败不受 a 影响
    expect(recordEditOutcome(s, "edit", "/b.ts", true, "错误: 未找到")).toBeUndefined();
    // a 第三次触发
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeDefined();
  });
});

describe("recordEditOutcome — read 自愈", () => {
  test("成功 read 该文件 → 清零计数", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    // 模型照建议重读 → 清零
    expect(recordEditOutcome(s, "read", "/a.ts", false, "")).toBeUndefined();
    // 之后再失败两次仍不触发（确认已归零）
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeUndefined();
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeUndefined();
  });

  test("失败的 read 不清零", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    recordEditOutcome(s, "read", "/a.ts", true, "错误: 文件不存在"); // 失败 read 不清零
    // 下一次 edit 失败应触发（计数仍为 2 → 3）
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeDefined();
  });
});

describe("recordEditOutcome — 分型建议", () => {
  const trip = (s: EditFailureStore, err: string) => {
    recordEditOutcome(s, "edit", "/a.ts", true, err);
    recordEditOutcome(s, "edit", "/a.ts", true, err);
    return recordEditOutcome(s, "edit", "/a.ts", true, err)!;
  };

  test("找不到匹配 → 建议重读", () => {
    expect(
      trip(makeStore(), "错误: 未找到要替换的字符串（精确/灵活/正则/模糊匹配均未命中）"),
    ).toContain("重新读取");
  });

  test("不唯一/歧义 → 建议加长上下文或 replace_all", () => {
    const r = trip(makeStore(), "错误: 找到 3 处匹配，但 replace_all=false");
    expect(r).toContain("replace_all");
  });

  test("被外部修改 → 建议重读最新内容", () => {
    expect(trip(makeStore(), "错误: 文件已被外部修改")).toContain("最新内容");
  });

  test("截断/超大 → 建议分段或 sed", () => {
    expect(trip(makeStore(), "错误: 内容疑似被截断")).toContain("分段");
  });
});

describe("recordEditOutcome — 升级式提醒", () => {
  test("持续失败到阈值+2 → 升级为换策略", () => {
    process.env.SID_EDIT_FAILURE_REMINDER_THRESHOLD = "3";
    const s = makeStore();
    let last = "";
    for (let i = 0; i < 5; i++) {
      last = recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到") ?? last;
    }
    // 第 5 次 = 阈值(3)+2 → 升级
    expect(last).toContain("换一条根本不同的路子");
  });
});

describe("recordEditOutcome — 边界与开关", () => {
  test("非 edit/write/read 工具不处理", () => {
    const s = makeStore();
    expect(recordEditOutcome(s, "bash", "/a.ts", true, "错误")).toBeUndefined();
    expect(recordEditOutcome(s, "grep", undefined, true, "错误")).toBeUndefined();
  });

  test("无 file_path 不处理", () => {
    const s = makeStore();
    expect(recordEditOutcome(s, "edit", undefined, true, "错误: 未找到")).toBeUndefined();
  });

  test("环境变量关闭 → 始终不提醒", () => {
    process.env.SID_DISABLE_EDIT_FAILURE_REMINDER = "1";
    const s = makeStore();
    for (let i = 0; i < 6; i++) recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    // 关闭后即使超阈值也无提醒
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeUndefined();
  });

  test("自定义阈值=2", () => {
    process.env.SID_EDIT_FAILURE_REMINDER_THRESHOLD = "2";
    const s = makeStore();
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeUndefined();
    expect(recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到")).toBeDefined();
  });

  test("write 工具同样计数", () => {
    const s = makeStore();
    recordEditOutcome(s, "write", "/a.ts", true, "错误: 内容疑似被截断");
    recordEditOutcome(s, "write", "/a.ts", true, "错误: 内容疑似被截断");
    expect(recordEditOutcome(s, "write", "/a.ts", true, "错误: 内容疑似被截断")).toBeDefined();
  });
});

describe("recordEditOutcome — noop / not_found 分型（发现 9）", () => {
  const NOOP = "错误: old_string 与 new_string 完全相同，没有需要修改的内容。";
  const NOT_FOUND = "错误: 未找到要替换的字符串（精确/灵活/正则/模糊匹配均未命中）。";

  test("分型：noop / not_found / ambiguous 各自识别", () => {
    expect(classifyEditFailure(NOOP)).toBe("noop");
    expect(classifyEditFailure(NOT_FOUND)).toBe("not_found");
    expect(classifyEditFailure("错误: 找到 3 处匹配，但 replace_all=false")).toBe("ambiguous");
    expect(classifyEditFailure("错误: 别的")).toBe("other");
  });

  test("被评会话形态 old==new → read → old==new：read 不清零，第 3 次照样提醒", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, NOOP);
    recordEditOutcome(s, "read", "/a.ts", false, "");
    recordEditOutcome(s, "edit", "/a.ts", true, NOOP);
    recordEditOutcome(s, "read", "/a.ts", false, "");
    const r = recordEditOutcome(s, "edit", "/a.ts", true, NOOP);
    expect(r).toBeDefined();
    expect(r).toContain("不要用 old==new 的 edit 当探针");
  });

  test("not_found 同样不被 read 清零", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, NOT_FOUND);
    recordEditOutcome(s, "edit", "/a.ts", true, NOT_FOUND);
    recordEditOutcome(s, "read", "/a.ts", false, "");
    expect(recordEditOutcome(s, "edit", "/a.ts", true, NOT_FOUND)).toBeDefined();
  });

  test("read 只清掉非 sticky 那部分：2 次 other + 1 次 noop → read → 再 1 次 noop 未达阈值", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    recordEditOutcome(s, "edit", "/a.ts", true, NOOP); // 第 3 次达阈值
    recordEditOutcome(s, "read", "/a.ts", false, ""); // 降回 sticky=1
    expect(recordEditOutcome(s, "edit", "/a.ts", true, NOOP)).toBeUndefined(); // 2
    expect(recordEditOutcome(s, "edit", "/a.ts", true, NOOP)).toBeDefined(); // 3
  });

  test("sticky 计数只被该文件的成功编辑清零", () => {
    const s = makeStore();
    recordEditOutcome(s, "edit", "/a.ts", true, NOOP);
    recordEditOutcome(s, "edit", "/a.ts", true, NOOP);
    recordEditOutcome(s, "edit", "/a.ts", false, "");
    expect(recordEditOutcome(s, "edit", "/a.ts", true, NOOP)).toBeUndefined();
    expect(recordEditOutcome(s, "edit", "/a.ts", true, NOOP)).toBeUndefined();
  });

  test("达阈值附上 old_string 锚点所在区段的实时内容（read 行号格式）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ef-snippet-"));
    try {
      const f = join(dir, "x.ts");
      const body = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`);
      writeFileSync(f, body.join("\n"));
      const s = makeStore();
      // 首行缩进写错 + 第二行对得上：not_found，但锚点仍能定位到第 21 行
      const old = "    const lineXX = 0;\n  const line21 = 21;";
      recordEditOutcome(s, "edit", f, true, NOT_FOUND, old);
      recordEditOutcome(s, "edit", f, true, NOT_FOUND, old);
      const r = recordEditOutcome(s, "edit", f, true, NOT_FOUND, old)!;
      expect(r).toContain(SNIPPET_HEADER);
      expect(r).toContain("21\tconst line21 = 21;");
      expect(r).toContain("13\tconst line13 = 13;");
      expect(r).not.toContain("12\tconst line12");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("太短的行（`}`）不当锚点，避免定位到无关位置", () => {
    const dir = mkdtempSync(join(tmpdir(), "ef-snippet-"));
    try {
      const f = join(dir, "x.ts");
      const body = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`);
      body[2] = "}"; // 第 3 行是一个短行，old_string 首行也是它
      writeFileSync(f, body.join("\n"));
      const s = makeStore();
      const old = "}\nconst line30 = 30;";
      for (let i = 0; i < 2; i++) recordEditOutcome(s, "edit", f, true, NOT_FOUND, old);
      const r = recordEditOutcome(s, "edit", f, true, NOT_FOUND, old)!;
      expect(r).toContain("30\tconst line30 = 30;");
      expect(r).not.toContain("3\t}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("锚点找不到时不附片段（不猜位置）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ef-snippet-"));
    try {
      const f = join(dir, "x.ts");
      writeFileSync(f, "const a = 1;\nconst b = 2;\n");
      const s = makeStore();
      const old = "totally unrelated content here";
      for (let i = 0; i < 2; i++) recordEditOutcome(s, "edit", f, true, NOT_FOUND, old);
      const r = recordEditOutcome(s, "edit", f, true, NOT_FOUND, old)!;
      expect(r).toBeDefined();
      expect(r).not.toContain(SNIPPET_HEADER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EditFailureReminder 事件（T4 补分诊：此前触发了没记）", () => {
  const got: Array<Record<string, unknown>> = [];
  afterEach(() => {
    setEditFailureReminderSink(null);
    got.length = 0;
  });

  test("每追加一次提醒落一条事件，未达阈值不落；字段与提醒一致", () => {
    setEditFailureReminderSink((d) => got.push(d));
    const s = makeStore();
    recordEditOutcome(s, "edit", "/x/a.ts", true, "错误: 未找到要替换的字符串");
    recordEditOutcome(s, "edit", "/x/a.ts", true, "错误: 未找到要替换的字符串");
    expect(got).toHaveLength(0);
    const r3 = recordEditOutcome(s, "edit", "/x/a.ts", true, "错误: 未找到要替换的字符串");
    expect(r3).toBeDefined();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      tool_name: "edit",
      file: "a.ts",
      kind: "not_found",
      count: 3,
      threshold: 3,
      escalated: false,
    });
    recordEditOutcome(s, "edit", "/x/a.ts", true, "错误: 未找到要替换的字符串");
    recordEditOutcome(s, "edit", "/x/a.ts", true, "错误: 未找到要替换的字符串");
    expect(got.map((e) => e.escalated)).toEqual([false, false, true]);
  });

  test("开关关闭时不落事件；sink 抛错不影响提醒返回", () => {
    process.env.SID_DISABLE_EDIT_FAILURE_REMINDER = "1";
    setEditFailureReminderSink((d) => got.push(d));
    const s = makeStore();
    for (let i = 0; i < 4; i++) recordEditOutcome(s, "edit", "/a.ts", true, "错误: 未找到");
    expect(got).toHaveLength(0);
    delete process.env.SID_DISABLE_EDIT_FAILURE_REMINDER;

    setEditFailureReminderSink(() => {
      throw new Error("sink 坏了");
    });
    const s2 = makeStore();
    recordEditOutcome(s2, "edit", "/a.ts", true, "错误: 未找到");
    recordEditOutcome(s2, "edit", "/a.ts", true, "错误: 未找到");
    expect(recordEditOutcome(s2, "edit", "/a.ts", true, "错误: 未找到")).toBeDefined();
  });
});
