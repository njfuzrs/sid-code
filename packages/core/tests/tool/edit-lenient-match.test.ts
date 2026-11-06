/**
 * T3：宽进命中（normalized / flexible / regex / fuzzy）发 `EditLenientMatch` 事件。
 *
 * 为什么这层要单独测：这四条降级路径此前只有 tool_result 里一句「使用模糊匹配」，
 * 没有命中位置与相似度，「那 43 次宽进到底改对没有」无法从轨迹上抽样核对。
 *
 * 两道防线缺一不可：
 * - 行为侧：命中时事件真的发出来、字段能回到 messages 里定位；
 * - 接线侧：App 把 sink 接到 collector —— 不接则生产上事件恒 0
 *   （这正是 EditFailureReminder 曾经的形态：4 条真实提醒、0 条事件）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  EditTool,
  setEditMatchSink,
  EDIT_LENIENT_MATCH_EVENT_NAME,
} from "@sid-code/core/tool/edit.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { FileReadTracker } from "@sid-code/core/tool/file-read-tracker.ts";

const TMP = join(os.tmpdir(), "sid-code-edit-lenient-match-test");

let events: Array<Record<string, unknown>> = [];

function setup() {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
}

function cleanup(files: string[]) {
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {
      /* 忽略 */
    }
  }
}

beforeEach(() => {
  setup();
  events = [];
  setEditMatchSink((d) => events.push(d));
});

afterEach(() => {
  setEditMatchSink(null);
});

describe("EditLenientMatch - 归一化命中", () => {
  test("弯引号归一化命中：报 normalized，带命中行与扩展名，且成功写盘", async () => {
    const tool = new EditTool();
    const file = join(TMP, "normalized.ts");
    writeFileSync(file, "const s = “inherit”;\n");
    const result = await tool.execute({
      file_path: file,
      old_string: 'const s = "inherit";',
      new_string: 'const s = "x";',
    });
    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      strategy: "normalized",
      file_ext: "ts",
      old_len: 'const s = "inherit";'.length,
      occurrences: 1,
      replace_all: false,
      match_start_line: 1,
      match_end_line: 1,
    });
    expect(typeof events[0]!.ts).toBe("number");
    cleanup([file]);
  });

  test("精确命中不发事件（它是绝大多数，分母从 tool_use 取）", async () => {
    const tool = new EditTool();
    const file = join(TMP, "exact.ts");
    writeFileSync(file, "const a = 1;\n");
    const result = await tool.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(0);
    cleanup([file]);
  });

  test("行为保持：未读文件的归一化命中仍放行（与 exact 同权，不因新策略被拒）", async () => {
    const tracker = new FileReadTracker();
    const tool = new EditTool(tracker);
    const file = join(TMP, "unread-normalized.ts");
    writeFileSync(file, "const s = “inherit”;\n");
    const result = await tool.execute({
      file_path: file,
      old_string: 'const s = "inherit";',
      new_string: 'const s = "x";',
    });
    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ strategy: "normalized" });
    cleanup([file]);
  });
});

describe("EditLenientMatch - 其它宽进策略", () => {
  test("灵活匹配：报 flexible 与命中块起止行", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const tool = new EditTool(tracker);
    const file = join(TMP, "flexible.ts");
    writeFileSync(file, "function foo() {\n    return 1;\n}\n");
    await read.execute({ file_path: file });
    const result = await tool.execute({
      file_path: file,
      old_string: "function foo() {\n  return 1;\n}",
      new_string: "function foo() {\n  return 2;\n}",
    });
    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      strategy: "flexible",
      match_start_line: 1,
      match_end_line: 3,
    });
    cleanup([file]);
  });

  test("正则匹配：报 regex 与首个命中行", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const tool = new EditTool(tracker);
    const file = join(TMP, "regex.ts");
    writeFileSync(file, "const a=1;\n");
    await read.execute({ file_path: file });
    const result = await tool.execute({
      file_path: file,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      strategy: "regex",
      match_start_line: 1,
      match_end_line: 1,
    });
    cleanup([file]);
  });

  test("模糊匹配：报 fuzzy、相似度在阈值内、命中行可定位", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const tool = new EditTool(tracker);
    const file = join(TMP, "fuzzy.ts");
    writeFileSync(file, "alpha beta gamma delta epsilon\n");
    await read.execute({ file_path: file });
    const result = await tool.execute({
      file_path: file,
      old_string: "alpha beta gamma delta epsilom",
      new_string: "alpha beta gamma delta zeta",
    });
    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({ strategy: "fuzzy", match_start_line: 1, match_end_line: 1 });
    expect(typeof e.similarity).toBe("number");
    expect(e.similarity as number).toBeGreaterThan(0.9);
    expect(e.similarity as number).toBeLessThanOrEqual(1);
    cleanup([file]);
  });

  test("replace_all=true 原样进事件", async () => {
    const tracker = new FileReadTracker();
    const read = new ReadTool(tracker);
    const tool = new EditTool(tracker);
    const file = join(TMP, "flexible-all.ts");
    writeFileSync(file, "foo() {\n    return 1;\n}\nfoo() {\n    return 1;\n}\n");
    await read.execute({ file_path: file });
    const result = await tool.execute({
      file_path: file,
      old_string: "foo() {\n  return 1;\n}",
      new_string: "foo() {\n  return 2;\n}",
      replace_all: true,
    });
    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    // 只锁本次改动的契约：replace_all 原样进事件；不断言 occurrences——
    // 灵活匹配的 replace_all 在「替换行数 == 匹配行数」时会跳过相邻块，那是既有行为，
    // 不属于本事件的观测范围。
    expect(events[0]).toMatchObject({ strategy: "flexible", replace_all: true });
    cleanup([file]);
  });
});

describe("EditLenientMatch - App 接线", () => {
  test("App 在 collector 就绪后把 sink 接到 recordCustomEvent(EDIT_LENIENT_MATCH_EVENT_NAME)", () => {
    const app = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf8");
    expect(app).toMatch(
      /setEditMatchSink\(\s*traceCollectorInstance\s*\?\s*\(data\)\s*=>\s*traceCollectorInstance\.recordCustomEvent\(EDIT_LENIENT_MATCH_EVENT_NAME,\s*data\)/,
    );
    expect(EDIT_LENIENT_MATCH_EVENT_NAME).toBe("EditLenientMatch");
  });
});
