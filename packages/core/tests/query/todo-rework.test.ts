/**
 * 「标了 completed 又返工」检测单测（todo-rework.ts）
 *
 * 复刻会话 20261005-233851-9b91e1b7：「修改脚本」在 16:07 标 completed，16:17 又改了同一个脚本，
 * 返工期间清单把没改好的代码显示成「已完成」。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import {
  createTodoReworkState,
  recordTodoWrite,
  recordFileEditForRework,
  drainTodoReworkReminder,
} from "@sid-code/core/query/todo-rework.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

const t = (content: string, status: TodoItem["status"]): TodoItem => ({
  content,
  activeForm: content,
  status,
});
const SCRIPT = "/Users/u/.local/bin/ppchat-route";

describe("todo 返工检测", () => {
  test("标完成后再改同一文件 → 提醒一次，点名项与文件", () => {
    const s = createTodoReworkState();
    recordTodoWrite(s, [t("探测", "completed"), t("改脚本", "in_progress"), t("同步", "pending")]);
    recordFileEditForRework(s, SCRIPT, null);
    const afterMark = [t("探测", "completed"), t("改脚本", "completed"), t("同步", "in_progress")];
    recordTodoWrite(s, afterMark);

    const hit = recordFileEditForRework(s, SCRIPT, afterMark);
    expect(hit).toEqual({ item: "改脚本", file: SCRIPT });
    const reminder = drainTodoReworkReminder(s)!;
    expect(reminder).toContain("「改脚本」已标 completed");
    expect(reminder).toContain(SCRIPT);
    expect(reminder).toContain("改回 in_progress");
    // 消费后清空；同一 (项, 文件) 不重复提醒
    expect(drainTodoReworkReminder(s)).toBeNull();
    expect(recordFileEditForRework(s, SCRIPT, afterMark)).toBeNull();
  });

  test("改的是别的文件 → 不提醒", () => {
    const s = createTodoReworkState();
    recordTodoWrite(s, [t("改脚本", "in_progress"), t("写文档", "pending")]);
    recordFileEditForRework(s, SCRIPT, null);
    const todos = [t("改脚本", "completed"), t("写文档", "in_progress")];
    recordTodoWrite(s, todos);
    expect(recordFileEditForRework(s, "/tmp/README.md", todos)).toBeNull();
  });

  test("模型已把该项改回 in_progress → 不提醒（已如实承认返工）", () => {
    const s = createTodoReworkState();
    recordTodoWrite(s, [t("改脚本", "in_progress"), t("同步", "pending")]);
    recordFileEditForRework(s, SCRIPT, null);
    recordTodoWrite(s, [t("改脚本", "completed"), t("同步", "in_progress")]);
    const reopened = [t("改脚本", "in_progress"), t("同步", "pending")];
    recordTodoWrite(s, reopened);
    expect(recordFileEditForRework(s, SCRIPT, reopened)).toBeNull();
  });

  test("清单已全部完成后再改文件 → 不提醒（多半是用户的新要求）", () => {
    const s = createTodoReworkState();
    recordTodoWrite(s, [t("改脚本", "in_progress")]);
    recordFileEditForRework(s, SCRIPT, null);
    const all = [t("改脚本", "completed")];
    recordTodoWrite(s, all);
    expect(recordFileEditForRework(s, SCRIPT, all)).toBeNull();
  });

  test("新插入就直接是 completed 的项也会归属期间的文件", () => {
    const s = createTodoReworkState();
    recordFileEditForRework(s, SCRIPT, null);
    const todos = [t("改脚本", "completed"), t("验证", "in_progress")];
    recordTodoWrite(s, todos);
    expect(recordFileEditForRework(s, SCRIPT, todos)?.item).toBe("改脚本");
  });
});
