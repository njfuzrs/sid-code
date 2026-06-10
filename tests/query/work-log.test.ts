/**
 * 工作日志外部记忆单元测试（P2-2）
 *
 * 参考: docs/bugfixes/todo/长任务遗漏-Harness根因与完成率提升方案.md §P2-2
 */

import { describe, it, expect } from "bun:test";
import {
  snapshotFromTodos,
  renderProgressMarkdown,
  buildProgressReminder,
  persistProgress,
  loadProgressMarkdown,
  progressFilePath,
} from "../../src/query/work-log.ts";
import type { TodoItem } from "../../src/tool/todo-write.ts";
import { existsSync, rmSync } from "fs";

function todo(content: string, status: TodoItem["status"]): TodoItem {
  return { content, activeForm: `正在${content}`, status };
}

describe("work-log — P2-2 外部记忆", () => {
  const todos: TodoItem[] = [
    todo("已完成项", "completed"),
    todo("进行中项", "in_progress"),
    todo("待办项", "pending"),
  ];

  it("snapshotFromTodos 正确分类", () => {
    const snap = snapshotFromTodos("test-sid", todos);
    expect(snap.completed).toEqual(["已完成项"]);
    expect(snap.pending).toEqual(["进行中项", "待办项"]);
    expect(snap.inProgress).toBe("进行中项");
  });

  it("renderProgressMarkdown 含已完成 / 待办分区", () => {
    const md = renderProgressMarkdown(snapshotFromTodos("test-sid", todos));
    expect(md).toContain("## 已完成");
    expect(md).toContain("## 待办");
    expect(md).toContain("[x] 已完成项");
    expect(md).toContain("← 进行中");
  });

  it("buildProgressReminder 有待办时回注、无待办时返回 null", () => {
    const r = buildProgressReminder(snapshotFromTodos("test-sid", todos));
    expect(r).toContain("<system-reminder>");
    expect(r).toContain("工作日志");
    expect(r).toContain("待办");

    const allDone = [todo("x", "completed")];
    expect(buildProgressReminder(snapshotFromTodos("test-sid", allDone))).toBeNull();
  });

  it("persistProgress 落盘 + loadProgressMarkdown 读回", () => {
    const sid = "test-worklog-roundtrip";
    const fp = progressFilePath(sid);
    try {
      const ok = persistProgress(snapshotFromTodos(sid, todos));
      expect(ok).toBe(true);
      expect(existsSync(fp)).toBe(true);
      const loaded = loadProgressMarkdown(sid);
      expect(loaded).toContain("待办项");
    } finally {
      if (existsSync(fp)) rmSync(fp);
    }
  });

  it("sessionId 含非法字符时不抛错（文件名清洗）", () => {
    const sid = "../../etc/passwd";
    const fp = progressFilePath(sid);
    expect(fp).not.toContain("..");
    try {
      expect(persistProgress(snapshotFromTodos(sid, todos))).toBe(true);
    } finally {
      if (existsSync(fp)) rmSync(fp);
    }
  });
});
