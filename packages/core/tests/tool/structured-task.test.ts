/**
 * 结构化任务清单测试（P1-5 路线 A）
 * 覆盖 store 依赖图/成环检测 + 四个工具（task_create/task_update/task_get/task_list）行为。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  createStructuredTask,
  getStructuredTask,
  getAllStructuredTasks,
  updateStructuredTask,
  isTaskUnblocked,
  __clearStructuredTasks,
} from "@sid-code/core/task/structured-task-store.ts";
import { TaskCreateTool } from "@sid-code/core/tool/structured-task-create.ts";
import { TaskUpdateTool } from "@sid-code/core/tool/structured-task-update.ts";
import { StructuredTaskGetTool } from "@sid-code/core/tool/structured-task-get.ts";
import { StructuredTaskListTool } from "@sid-code/core/tool/structured-task-list.ts";

beforeEach(() => {
  __clearStructuredTasks();
});

describe("structured-task-store", () => {
  test("创建任务：初始 pending、无依赖、ID 自增", () => {
    const a = createStructuredTask({ subject: "A", description: "desc a" });
    const b = createStructuredTask({ subject: "B", description: "desc b" });
    expect(a.id).toBe("1");
    expect(b.id).toBe("2");
    expect(a.status).toBe("pending");
    expect(a.blocks).toEqual([]);
    expect(a.blockedBy).toEqual([]);
  });

  test("更新状态与 owner", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const r = updateStructuredTask(a.id, { status: "in_progress", owner: "worker-1" });
    expect(r.ok).toBe(true);
    expect(r.task?.status).toBe("in_progress");
    expect(r.task?.owner).toBe("worker-1");
  });

  test("依赖边双向维护：addBlockedBy 同步对端 blocks", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });
    // b 依赖 a（a 完成后 b 才能开始）
    const r = updateStructuredTask(b.id, { addBlockedBy: [a.id] });
    expect(r.ok).toBe(true);
    expect(getStructuredTask(b.id)?.blockedBy).toEqual([a.id]);
    expect(getStructuredTask(a.id)?.blocks).toEqual([b.id]);
  });

  test("成环检测：拒绝形成循环依赖", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });
    // a 完成后 b 才能开始
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });
    // 再让 a 依赖 b → 成环，应被拒绝
    const r = updateStructuredTask(a.id, { addBlockedBy: [b.id] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("循环依赖");
  });

  test("引用不存在的依赖任务报错", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const r = updateStructuredTask(a.id, { addBlockedBy: ["999"] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不存在");
  });

  // ---- P0-1 反漂移：依赖边「整体不生效」必须是真的 ----
  //
  // 这一组锁的是 updateStructuredTask 的原子性承诺。修复前的形态是：
  // 逐条「校验即写入」，中途 return 时前面写进去的边没有任何回滚——
  // 于是调用方拿到 ok:false，图里却真的多出一个环，环上任务永久不可认领，
  // 而唯一的错误信息已经返回过了，没有第二次机会报这个环。
  //
  // 要点：单条边各自合法、只有合起来才成环，所以逐条校验永远发现不了，
  // 必须让校验阶段看见「本批次此前已通过的边」。

  test("P0-1：同一次调用里混放合法边与成环边，整批不生效（图内零残留）", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });
    const c = createStructuredTask({ subject: "C", description: "d" });
    const d = createStructuredTask({ subject: "D", description: "d" });

    // D 完成后 B、C、A 才能开始；同时 D 被 A 阻塞 —— 最后这条与 D→A 成环。
    // 前三条在逐条检测下都合法（当时图是空的），第三条 D→A 写进去之后
    // 第四条 A→D 才成环，所以环是被后一条输入补上的。
    const r = updateStructuredTask(d.id, {
      addBlocks: [b.id, c.id, a.id],
      addBlockedBy: [a.id],
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("循环依赖");

    // 关键断言：失败之后图必须与调用前逐字节相同，一条边都不许留。
    for (const t of getAllStructuredTasks()) {
      expect(t.blocks).toEqual([]);
      expect(t.blockedBy).toEqual([]);
    }
  });

  test("P0-1：整批合法时全部边都写入（两阶段不能误伤正常路径）", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });
    const c = createStructuredTask({ subject: "C", description: "d" });
    const d = createStructuredTask({ subject: "D", description: "d" });

    // D 完成后 B、C 才能开始；A 完成后 D 才能开始。无环。
    const r = updateStructuredTask(d.id, {
      addBlocks: [b.id, c.id],
      addBlockedBy: [a.id],
    });

    expect(r.ok).toBe(true);
    expect(getStructuredTask(d.id)?.blocks).toEqual([b.id, c.id]);
    expect(getStructuredTask(d.id)?.blockedBy).toEqual([a.id]);
    // 双向引用同步
    expect(getStructuredTask(b.id)?.blockedBy).toEqual([d.id]);
    expect(getStructuredTask(c.id)?.blockedBy).toEqual([d.id]);
    expect(getStructuredTask(a.id)?.blocks).toEqual([d.id]);
  });

  test("P0-1：批内出现不存在的任务时，同批合法边也不许写入", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });

    const r = updateStructuredTask(a.id, { addBlocks: [b.id, "999"] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不存在");

    // b 是合法的那条，但它和非法边在同一批，所以也不能生效。
    expect(getStructuredTask(a.id)?.blocks).toEqual([]);
    expect(getStructuredTask(b.id)?.blockedBy).toEqual([]);
  });

  test("P0-1：失败批次不会让任务变成永久不可认领", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });
    const c = createStructuredTask({ subject: "C", description: "d" });

    // A→B、B→C 合法，C→A 成环。失败后 A 不应因残留的 C→A 而被永久阻塞。
    const r = updateStructuredTask(a.id, { addBlocks: [b.id], addBlockedBy: [b.id] });
    expect(r.ok).toBe(false);

    // 三个任务都必须仍可认领（blockedBy 为空）。
    for (const t of [a, b, c]) {
      expect(isTaskUnblocked(getStructuredTask(t.id)!)).toBe(true);
    }
  });

  test("isTaskUnblocked：上游未完成时阻塞，完成后解锁", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });
    expect(isTaskUnblocked(getStructuredTask(b.id)!)).toBe(false);
    updateStructuredTask(a.id, { status: "completed" });
    expect(isTaskUnblocked(getStructuredTask(b.id)!)).toBe(true);
  });

  test("删除任务：摘除依赖边", () => {
    const a = createStructuredTask({ subject: "A", description: "d" });
    const b = createStructuredTask({ subject: "B", description: "d" });
    updateStructuredTask(b.id, { addBlockedBy: [a.id] });
    const r = updateStructuredTask(a.id, { status: "deleted" });
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(true);
    expect(getStructuredTask(a.id)).toBeUndefined();
    // b 的 blockedBy 应已摘除 a
    expect(getStructuredTask(b.id)?.blockedBy).toEqual([]);
  });

  test("metadata 合并与删除（null 删键）", () => {
    const a = createStructuredTask({ subject: "A", description: "d", metadata: { x: 1 } });
    updateStructuredTask(a.id, { metadata: { y: 2 } });
    expect(getStructuredTask(a.id)?.metadata).toEqual({ x: 1, y: 2 });
    updateStructuredTask(a.id, { metadata: { x: null } });
    expect(getStructuredTask(a.id)?.metadata).toEqual({ y: 2 });
  });

  test("getAllStructuredTasks 按 ID 升序", () => {
    createStructuredTask({ subject: "A", description: "d" });
    createStructuredTask({ subject: "B", description: "d" });
    createStructuredTask({ subject: "C", description: "d" });
    expect(getAllStructuredTasks().map((t) => t.subject)).toEqual(["A", "B", "C"]);
  });
});

describe("task_create / task_update / task_get / task_list 工具", () => {
  test("task_create 缺 subject 报错", async () => {
    const tool = new TaskCreateTool();
    const r = await tool.execute({ description: "d" });
    expect(r.isError).toBe(true);
  });

  test("task_create 缺 description 报错", async () => {
    const tool = new TaskCreateTool();
    const r = await tool.execute({ subject: "s" });
    expect(r.isError).toBe(true);
  });

  test("task_create 成功返回 id", async () => {
    const tool = new TaskCreateTool();
    const r = await tool.execute({ subject: "修复 bug", description: "详细说明" });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.output);
    expect(parsed.id).toBe("1");
    expect(parsed.status).toBe("pending");
  });

  test("task_update 修改状态", async () => {
    const create = new TaskCreateTool();
    const c = JSON.parse((await create.execute({ subject: "s", description: "d" })).output);
    const update = new TaskUpdateTool();
    const r = await update.execute({ task_id: c.id, status: "in_progress" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.output).status).toBe("in_progress");
  });

  test("task_update 不存在的任务报错", async () => {
    const update = new TaskUpdateTool();
    const r = await update.execute({ task_id: "999", status: "completed" });
    expect(r.isError).toBe(true);
  });

  test("task_update 删除任务", async () => {
    const create = new TaskCreateTool();
    const c = JSON.parse((await create.execute({ subject: "s", description: "d" })).output);
    const update = new TaskUpdateTool();
    const r = await update.execute({ task_id: c.id, status: "deleted" });
    expect(JSON.parse(r.output).deleted).toBe(true);
  });

  test("task_get 返回完整详情含 unblocked", async () => {
    const create = new TaskCreateTool();
    const c = JSON.parse((await create.execute({ subject: "s", description: "d" })).output);
    const get = new StructuredTaskGetTool();
    const r = await get.execute({ task_id: c.id });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.output);
    expect(parsed.subject).toBe("s");
    expect(parsed.unblocked).toBe(true);
  });

  test("task_get 不存在报错", async () => {
    const get = new StructuredTaskGetTool();
    const r = await get.execute({ task_id: "999" });
    expect(r.isError).toBe(true);
  });

  test("task_list 空清单提示", async () => {
    const list = new StructuredTaskListTool();
    const r = await list.execute({});
    expect(r.output).toContain("为空");
  });

  test("task_list 列出并按状态过滤", async () => {
    const create = new TaskCreateTool();
    const c1 = JSON.parse((await create.execute({ subject: "A", description: "d" })).output);
    await create.execute({ subject: "B", description: "d" });
    const update = new TaskUpdateTool();
    await update.execute({ task_id: c1.id, status: "in_progress" });

    const list = new StructuredTaskListTool();
    const all = JSON.parse((await list.execute({ status: "all" })).output);
    expect(all.tasks.length).toBe(2);

    const inProgress = JSON.parse((await list.execute({ status: "in_progress" })).output);
    expect(inProgress.tasks.length).toBe(1);
    expect(inProgress.tasks[0].subject).toBe("A");
  });

  test("工具名与语义分离：结构化工具名为 task_*，后台任务为 bg_task_*", () => {
    expect(new TaskCreateTool().name()).toBe("task_create");
    expect(new TaskUpdateTool().name()).toBe("task_update");
    expect(new StructuredTaskGetTool().name()).toBe("task_get");
    expect(new StructuredTaskListTool().name()).toBe("task_list");
  });
});
