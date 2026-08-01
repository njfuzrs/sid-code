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

  // ──────────────────────────────────────────────────────────────────────────
  // 2026-08-01 步骤 0：formatTodoDiff 按 content 配对，不按数组下标
  //
  // todos 是**全量替换**语义，模型可以插入/删除/重排。按下标比对会双向错报，
  // 而这是模型从 tool_result 能拿到的**唯一进度反馈**：假报让它以为已勾（于是不再去勾），
  // 漏报让它拿不到正反馈——两者都直接加重"非实时更新"缺陷。
  // ──────────────────────────────────────────────────────────────────────────
  describe("formatTodoDiff 按 key 比对（防假报/漏报）", () => {
    it("插入新项不假报已完成（旧实现按下标必假报）", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({
        todos: [makeTodo("A", "completed"), makeTodo("B", "pending"), makeTodo("C", "pending")],
      });
      // 最前面插入一个新项 → 下标全体右移
      const r = await tool.execute({
        todos: [
          makeTodo("新任务", "in_progress"),
          makeTodo("A", "completed"),
          makeTodo("B", "pending"),
          makeTodo("C", "pending"),
        ],
      });
      // 本轮无一项**新**完成（A 上一轮就完成了）→ 不该出现任何"已完成"播报
      expect(r.output).not.toContain("✅ 已完成:");
    });

    it("删除项不漏报真实完成（旧实现按下标必漏报）", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({
        todos: [makeTodo("X", "pending"), makeTodo("Y", "in_progress"), makeTodo("Z", "pending")],
      });
      // 删掉 X（下标全体左移），且 Y 真的完成了。留一项 pending 以免走"全完成清空"分支。
      // 旧实现按下标比：新[0]=Y(completed) 对旧[0]=X(pending) → content 不同却仍比 status，
      // 而真正该配对的旧 Y 在下标 1 上，于是这条真实完成被漏掉。
      const r = await tool.execute({ todos: [makeTodo("Y", "completed"), makeTodo("Z", "pending")] });
      expect(r.output).toContain("✅ 已完成: Y");
    });

    it("纯重排不报任何完成", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({
        todos: [makeTodo("P", "completed"), makeTodo("Q", "in_progress"), makeTodo("R", "pending")],
      });
      const r = await tool.execute({
        todos: [makeTodo("R", "pending"), makeTodo("Q", "in_progress"), makeTodo("P", "completed")],
      });
      expect(r.output).not.toContain("✅ 已完成:");
    });

    it("真实完成一项时正常播报", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({ todos: [makeTodo("M", "in_progress"), makeTodo("N", "pending")] });
      const r = await tool.execute({ todos: [makeTodo("M", "completed"), makeTodo("N", "in_progress")] });
      expect(r.output).toContain("✅ 已完成: M");
    });

    it("同名重复项不会互相覆盖（按桶逐个配对）", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({ todos: [makeTodo("同名", "in_progress"), makeTodo("同名", "pending")] });
      // 第一个完成、第二个仍 pending → 只报一次
      const r = await tool.execute({ todos: [makeTodo("同名", "completed"), makeTodo("同名", "pending")] });
      expect(r.output.match(/✅ 已完成:/g)?.length).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2026-08-01 修复 3：tool_result 前向推进指令（L1 必达通道）
  // ──────────────────────────────────────────────────────────────────────────
  describe("tool_result 前向推进指令（三分流）", () => {
    it("有 in_progress → 点名当前项，要求做完立即标记", async () => {
      const tool = new TodoWriteTool();
      const r = await tool.execute({
        todos: [makeTodo("写代码", "in_progress"), makeTodo("跑测试", "pending")],
      });
      expect(r.output).toContain("下一步");
      expect(r.output).toContain("写代码"); // 点名到具体项，而非泛化提醒
      expect(r.output).toContain("不要攒到最后一起标记");
    });

    it("无 in_progress 但有 pending → 强调实时流转", async () => {
      const tool = new TodoWriteTool();
      const r = await tool.execute({
        todos: [makeTodo("甲", "completed"), makeTodo("乙", "pending")],
      });
      expect(r.output).toContain("不要攒到最后一起标记");
    });

    it("全部完成 → 走清空分支，保持旧收尾文案（不得被指令覆盖）", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({ todos: [makeTodo("唯一项", "in_progress")] });
      const r = await tool.execute({ todos: [makeTodo("唯一项", "completed")] });
      // 全完成走的是"清单已清空"分支，那段文案是重复输出缺陷的修复成果，不能被改动
      expect(r.output).toContain("所有任务已完成，清单已清空");
      expect(r.output).toContain("不要重复输出");
    });

    it("每次调用都必达（不受任何节流/去重影响）", async () => {
      const tool = new TodoWriteTool();
      // 连续三次提交**逐字相同**的清单：指令必须每次都在
      for (let i = 0; i < 3; i++) {
        const r = await tool.execute({
          todos: [makeTodo("恒定项", "in_progress"), makeTodo("另一项", "pending")],
        });
        expect(r.output).toContain("下一步");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2026-08-01 修复 4：全 pending 首建必须有 advisory（旧守卫方向反了）
  // ──────────────────────────────────────────────────────────────────────────
  describe("全 pending 守卫", () => {
    it("全 pending 首建 → 必须提示置 in_progress 并点名首项", async () => {
      const tool = new TodoWriteTool();
      const r = await tool.execute({
        todos: [makeTodo("第一步"), makeTodo("第二步"), makeTodo("第三步")],
      });
      // 旧实现：hasNonPending===false → 两条分支都不触发 → 零提示（正是缺陷现场的形态）
      expect(r.output).toContain("没有 in_progress 任务");
      expect(r.output).toContain("第一步"); // 点名建议项
    });

    it("单个 in_progress 仍然不产生 advisory（不新增噪音）", async () => {
      const tool = new TodoWriteTool();
      const r = await tool.execute({
        todos: [makeTodo("干活", "in_progress"), makeTodo("待办", "pending")],
      });
      expect(r.output).not.toContain("没有 in_progress 任务");
      expect(r.output).not.toContain("建议同一时刻只保留");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2026-08-01 修复 5 / 发现 4a：终态清单必须可读（否则进度快照永久缺终态）
  // ──────────────────────────────────────────────────────────────────────────
  describe("getLastWrittenTodos：事实语义 vs 展示语义", () => {
    it("全部完成时 getTodos 清空，但 getLastWrittenTodos 保留终态", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({ todos: [makeTodo("活儿", "in_progress")] });
      await tool.execute({ todos: [makeTodo("活儿", "completed")] });

      // 展示语义：面板收起（这是刻意设计，不能改）
      expect(tool.getTodos()).toHaveLength(0);
      // 事实语义：终态仍可读，且状态是 completed —— 进度落盘靠它拿终态
      const terminal = tool.getLastWrittenTodos();
      expect(terminal).toHaveLength(1);
      expect(terminal[0].status).toBe("completed");
    });

    it("未全完成时两者一致", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({ todos: [makeTodo("甲", "completed"), makeTodo("乙", "in_progress")] });
      expect(tool.getTodos()).toHaveLength(2);
      expect(tool.getLastWrittenTodos()).toHaveLength(2);
    });

    it("reset() 同时清掉事实快照（防 /clear 后取到上个任务的终态）", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({ todos: [makeTodo("旧活", "completed")] });
      expect(tool.getLastWrittenTodos()).toHaveLength(1);
      tool.reset();
      expect(tool.getLastWrittenTodos()).toHaveLength(0);
    });

    it("返回深拷贝，外部修改不污染内部状态", async () => {
      const tool = new TodoWriteTool();
      await tool.execute({ todos: [makeTodo("活儿", "in_progress")] });
      const snap = tool.getLastWrittenTodos();
      snap[0].content = "被篡改";
      expect(tool.getLastWrittenTodos()[0].content).toBe("活儿");
    });
  });
});
