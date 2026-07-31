/**
 * TodoWriteTool 单元测试
 *
 * 验证任务清单的 CRUD 操作、in_progress 互斥约束、边界情况
 *
 * 参考: docs/bugfixes/todo/PlanMode-套娃根因与TodoWrite方案.md §三.P1-1
 */

import { describe, it, expect } from "bun:test";
import { TodoWriteTool } from "../../src/tool/todo-write.ts";

describe("TodoWriteTool", () => {
  function makeTodo(
    content: string,
    status: "pending" | "in_progress" | "completed" = "pending",
  ) {
    return { content, activeForm: `正在${content}`, status };
  }

  it("name 返回 todo_write", () => {
    const tool = new TodoWriteTool();
    expect(tool.name()).toBe("todo_write");
  });

  it("readOnly 返回 false", () => {
    const tool = new TodoWriteTool();
    expect(tool.readOnly()).toBe(false);
  });

  it("isConcurrencySafe 返回 true", () => {
    const tool = new TodoWriteTool();
    expect(tool.isConcurrencySafe()).toBe(true);
  });

  it("设置 todo 列表并成功返回", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [
        makeTodo("任务1", "pending"),
        makeTodo("任务2", "in_progress"),
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("任务1");
    expect(result.output).toContain("任务2");
    expect(result.output).toContain("进度: 0/2 已完成, 1 进行中, 1 待开始");
  });

  /**
   * 2026-07-30 行为变更：「恰好一个 in_progress」从硬拒绝降级为软提示。
   *
   * 依据：claude-code 的 TodoWriteTool.call() 不做该校验（规范只在提示词里，且写作
   * 「Ideally you should only have one」），其 UI 也按复数渲染 in_progress；我们自己的
   * TodoPanel 与 structured-task-store 同样支持复数。旧硬拦截实测让模型白等 105.4 秒
   * 重交一份 content 逐字相同、仅 status 不同的清单——纯自伤，无信息产出。
   */
  it("接受多个 in_progress，但附带软提示", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [
        makeTodo("任务1", "in_progress"),
        makeTodo("任务2", "in_progress"),
      ],
    });
    expect(result.isError).toBeFalsy();
    // 清单真的存下来了（不是被丢弃）
    expect(result.output).toContain("任务1");
    expect(result.output).toContain("任务2");
    expect(tool.getTodos()).toHaveLength(2);
    // 建议仍然给到模型
    expect(result.output).toContain("建议同一时刻只保留 1 个 in_progress");
  });

  it("接受 completed + pending（无 in_progress）的中间态，并提示", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [
        makeTodo("任务1", "completed"),
        makeTodo("任务2", "pending"),
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(tool.getTodos()).toHaveLength(2);
    expect(result.output).toContain("没有 in_progress 任务");
  });

  it("单个 in_progress 时不附加任何提示", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [
        makeTodo("任务1", "in_progress"),
        makeTodo("任务2", "pending"),
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain("提示：");
  });

  it("允许全 pending 列表（首次创建阶段）", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [
        makeTodo("任务1", "pending"),
        makeTodo("任务2", "pending"),
        makeTodo("任务3", "pending"),
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("进度: 0/3 已完成, 3 待开始");
  });

  it("拒绝无效 status", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [{ content: "任务1", activeForm: "执行1", status: "unknown" }],
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("status 无效");
  });

  it("拒绝无效输入（非数组）", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({ todos: "not_an_array" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("必须是数组");
  });

  it("拒绝缺少 content 的项", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [{ content: "", activeForm: "执行", status: "pending" }],
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("content");
  });

  it("拒绝缺少 activeForm 的项", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [{ content: "任务1", activeForm: "", status: "pending" }],
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("activeForm");
  });

  it("全部完成时清空列表并提示汇总", async () => {
    const tool = new TodoWriteTool();
    // 先设置一些任务
    await tool.execute({
      todos: [
        makeTodo("任务1", "in_progress"),
        makeTodo("任务2", "pending"),
      ],
    });
    // 全部完成
    const result = await tool.execute({
      todos: [
        makeTodo("任务1", "completed"),
        makeTodo("任务2", "completed"),
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("所有任务已完成");
    expect(result.output).toContain("汇总");
  });

  // 「补标记后重复输出整份报告」回归守卫（2026-07-30 实测缺陷）。
  // 旧文案是无条件祈使句「请汇总执行结果并告知用户」，模型在"正文已输出、回头补标
  // 最后一项"时也照做，把整份报告重打一遍。转录见
  // docs/_template/遗留最后一项todoitem…txt。这里锁住"必须带条件分流"。
  it("全部完成文案不得是无条件祈使句（必须给'已输出过则不重复'的分流）", async () => {
    const tool = new TodoWriteTool();
    await tool.execute({ todos: [makeTodo("任务1", "in_progress")] });
    const result = await tool.execute({ todos: [makeTodo("任务1", "completed")] });

    // 必须明确给出"已经输出过 → 不要重复"这条出路
    expect(result.output).toContain("不要重复输出");
    expect(result.output).toContain("已经完整输出过");
    // 汇总必须是带条件的（"若…尚未…"），不能是裸命令
    expect(result.output).toContain("尚未");
    // 锁死旧的无条件祈使句不再出现
    expect(result.output).not.toContain("请汇总执行结果并告知用户");
  });

  it("单 in_progress 正常工作", async () => {
    const tool = new TodoWriteTool();
    const result = await tool.execute({
      todos: [makeTodo("唯一任务", "in_progress")],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("1 进行中");
  });

  it("追踪完成状态变更", async () => {
    const tool = new TodoWriteTool();
    await tool.execute({
      todos: [
        makeTodo("任务1", "in_progress"),
        makeTodo("任务2", "pending"),
      ],
    });
    const result = await tool.execute({
      todos: [
        makeTodo("任务1", "completed"),
        makeTodo("任务2", "in_progress"),
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("✅ 已完成: 任务1");
  });

  it("状态切换后 in_progress 恰好一个", async () => {
    const tool = new TodoWriteTool();
    // 完成旧任务的同时必须指定新的 in_progress
    const result = await tool.execute({
      todos: [
        makeTodo("任务1", "completed"),
        makeTodo("任务2", "in_progress"),
        makeTodo("任务3", "pending"),
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("1 进行中");
  });

  it("getTodos 返回当前 todo 列表副本", async () => {
    const tool = new TodoWriteTool();
    await tool.execute({
      todos: [
        makeTodo("任务1", "completed"),
        makeTodo("任务2", "in_progress"),
      ],
    });
    const todos = tool.getTodos();
    expect(todos.length).toBe(2);
    expect(todos[0].content).toBe("任务1");
    expect(todos[1].content).toBe("任务2");
    // 验证返回的是副本（修改不影响内部状态）
    todos[0].content = "已修改";
    const todos2 = tool.getTodos();
    expect(todos2[0].content).toBe("任务1");
  });

  it("getTodos 在空列表时返回空数组", () => {
    const tool = new TodoWriteTool();
    const todos = tool.getTodos();
    expect(todos).toEqual([]);
  });

  // P0-2：writeVersion 用于"距上次 todo_write 多少轮"判定
  it("getWriteVersion 初始为 0，每次成功 execute 后递增", async () => {
    const tool = new TodoWriteTool();
    expect(tool.getWriteVersion()).toBe(0);

    await tool.execute({ todos: [makeTodo("任务1")] });
    expect(tool.getWriteVersion()).toBe(1);

    await tool.execute({ todos: [makeTodo("任务1", "in_progress")] });
    expect(tool.getWriteVersion()).toBe(2);
  });

  it("getWriteVersion 在校验失败时不递增", async () => {
    const tool = new TodoWriteTool();
    await tool.execute({ todos: [makeTodo("任务1")] });
    expect(tool.getWriteVersion()).toBe(1);

    // 非法输入（todos 不是数组）→ 失败，版本号不变
    await tool.execute({ todos: "not-an-array" });
    expect(tool.getWriteVersion()).toBe(1);
  });
});
