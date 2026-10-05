/**
 * todo_write 的 blocked 状态（2026-10-06）
 *
 * 缺陷现场（会话 20261005-233851-9b91e1b7）：剩余 3 项需要 sudo，清单只有 pending/in_progress/
 * completed 三态，模型只能把"等用户"挂成未完成，兜底据此反复拦截。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { TodoWriteTool } from "@sid-code/core/tool/todo-write.ts";

const item = (content: string, status: string) => ({ content, active_form: content, status });

describe("todo_write — blocked 状态", () => {
  test("接受 blocked，进度行单列等待项，且不催'把下一项置为 in_progress'", async () => {
    const tool = new TodoWriteTool();
    const r = await tool.execute({
      todos: [
        item("探测", "completed"),
        item("改脚本", "completed"),
        item("同步副本 —— 需 sudo", "blocked"),
        item("验证 —— 等用户", "blocked"),
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("2 等待用户/外部");
    expect(r.output).toContain("即可收尾");
    expect(r.output).not.toContain("当前没有 in_progress");
    expect(tool.getTodos().map((t) => t.status)).toEqual([
      "completed",
      "completed",
      "blocked",
      "blocked",
    ]);
  });

  test("blocked 不算全部完成：清单不被清空", async () => {
    const tool = new TodoWriteTool();
    await tool.execute({ todos: [item("A", "completed"), item("B", "blocked")] });
    expect(tool.getTodos()).toHaveLength(2);
  });

  test("非法状态的报错列出 blocked", async () => {
    const tool = new TodoWriteTool();
    const r = await tool.execute({ todos: [item("A", "waiting")] });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("blocked");
  });

  test("持久化快照往返保留 blocked", async () => {
    const tool = new TodoWriteTool();
    await tool.execute({ todos: [item("A", "in_progress"), item("B", "blocked")] });
    const restored = new TodoWriteTool();
    restored.hydrate(JSON.parse(JSON.stringify(tool.serialize())));
    expect(restored.getTodos().map((t) => t.status)).toEqual(["in_progress", "blocked"]);
  });

  test("工具描述教模型何时用 blocked、拆分可做/不可做部分", () => {
    const d = new TodoWriteTool().description();
    expect(d).toContain("blocked");
    expect(d).toContain("拆成两项");
  });
});
