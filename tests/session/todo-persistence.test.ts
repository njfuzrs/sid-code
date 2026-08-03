/**
 * todo 清单持久化与恢复测试（修复：`-c` 恢复对话后 TodoPanel 任务清单整块消失）
 *
 * 根因：TodoWriteTool.currentTodos 是纯内存态，此前从未写入可恢复的会话文件，
 * restoreSession 也从不回灌 → resume 后 TodoWriteTool 全新空实例 →
 * TodoPanel 因 todos 为空整块隐藏，用户感知为"任务清单恢复后消失"。
 *
 * 修复三段：
 *  1. TodoWriteTool.serialize() / hydrate()（本文件覆盖 round-trip + 脏快照容错）
 *  2. app.persistTodoState() 每轮 done 后 appendMetadata("todo_state", …)
 *  3. app.restoreSession 读取 metadata["todo_state"] 回灌
 * 这里覆盖 1（round-trip + 容错）+ 2 的落盘/读回（通过 SessionStore 端到端）。
 *
 * 命名说明：传给 execute() 的对象走 tool_use 协议层，字段是 active_form；
 * 直接传给 hydrate() 的字面量是持久化快照格式，字段是内部结构 TodoItem.activeForm
 * （两者不是同一层，字段名刻意不同，见 src/tool/todo-write.ts 的桥接注释）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TodoWriteTool, type TodoItem } from "../../src/tool/todo-write.ts";
import { SessionStore } from "../../src/session/store.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/** 构造一个已注入若干 todo 的工具实例（直接走 execute 更贴近真实写入路径） */
async function toolWithTodos(
  todos: Array<{ content: string; active_form: string; status: TodoItem["status"] }>,
): Promise<TodoWriteTool> {
  const tool = new TodoWriteTool();
  await tool.execute({ todos } as any, {} as any);
  return tool;
}

describe("todo 清单 serialize/hydrate round-trip", () => {
  test("执行若干 todo 后，snapshot 回灌到新实例，清单完全一致", async () => {
    const orig = await toolWithTodos([
      { content: "新增 crash-marker.ts", active_form: "正在新增 crash-marker.ts", status: "completed" },
      { content: "接线 restoreSession", active_form: "正在接线 restoreSession", status: "in_progress" },
      { content: "写单测", active_form: "正在写单测", status: "pending" },
    ]);

    const snap = orig.serialize();

    // 模拟 resume：全新空实例
    const restored = new TodoWriteTool();
    expect(restored.getTodos()).toEqual([]); // 复现 bug 现象：恢复前为空

    restored.hydrate(snap);

    expect(restored.getTodos()).toEqual(orig.getTodos());
    expect(restored.getTodos().length).toBe(3);
    expect(restored.getTodos()[1].status).toBe("in_progress");
  });

  test("回灌后 serialize 再次 round-trip 仍等价（多次 resume 不失真）", async () => {
    const orig = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "completed" },
      { content: "任务B", active_form: "正在做B", status: "pending" },
    ]);
    const restored = new TodoWriteTool();
    restored.hydrate(orig.serialize());
    const restored2 = new TodoWriteTool();
    restored2.hydrate(restored.serialize());
    expect(restored2.getTodos()).toEqual(orig.getTodos());
  });

  test("回灌后继续 execute 全量替换（续做不断档，可在恢复的清单上更新）", async () => {
    const orig = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "in_progress" },
      { content: "任务B", active_form: "正在做B", status: "pending" },
    ]);
    const restored = new TodoWriteTool();
    restored.hydrate(orig.serialize());

    // resume 后把 A 标完成、B 进行中
    await restored.execute({
      todos: [
        { content: "任务A", active_form: "正在做A", status: "completed" },
        { content: "任务B", active_form: "正在做B", status: "in_progress" },
      ],
    } as any, {} as any);

    expect(restored.getTodos()[0].status).toBe("completed");
    expect(restored.getTodos()[1].status).toBe("in_progress");
  });

  test("serialize 返回深拷贝，修改快照不影响工具内部状态", async () => {
    const orig = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "pending" },
    ]);
    const snap = orig.serialize();
    snap.todos[0].status = "completed";
    snap.todos[0].content = "被篡改";
    // 工具内部状态不受快照被外部改写影响
    expect(orig.getTodos()[0].status).toBe("pending");
    expect(orig.getTodos()[0].content).toBe("任务A");
  });
});

describe("全部完成后的终态穿越 resume（2026-08-02，方案 §9-5）", () => {
  /**
   * `currentTodos` 在全部完成时被刻意清空（TUI 面板收起），于是**恰好在任务全做完这个
   * 最该留痕的时刻**，旧快照是 `{todos: []}`：resume 后事实清单恒空 →
   * `getTodoTerminalState()` 返 null → 续接会话的终态进度快照静默失效。
   *
   * 修法是快照里多带一份事实语义（`lastWritten`），**不是**让 `todos` 改读事实清单——
   * 那会让 resume 后 TUI 挂着全绿清单不消失，是行为回退。下面第二条正是钉住这一点。
   */
  test("全部完成 → resume 后仍能取回完整 completed 清单", async () => {
    const orig = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "completed" },
      { content: "任务B", active_form: "正在做B", status: "completed" },
    ]);
    // 展示语义已清空（面板收起），事实语义仍在
    expect(orig.getTodos()).toEqual([]);
    expect(orig.getLastWrittenTodos().length).toBe(2);

    const restored = new TodoWriteTool();
    restored.hydrate(orig.serialize());

    // 修复前：这里是 []，终态进度快照在续接会话里落不了盘
    expect(restored.getLastWrittenTodos().length).toBe(2);
    expect(restored.getLastWrittenTodos().every((t) => t.status === "completed")).toBe(true);
  });

  test("resume 后 TUI 展示清单仍为空（不复活全绿面板，防行为回退）", async () => {
    const orig = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "completed" },
    ]);
    const restored = new TodoWriteTool();
    restored.hydrate(orig.serialize());
    // 展示语义必须保持"收起"——这条与上一条是一对，缺了就分不清"修好了"和"改回退了"
    expect(restored.getTodos()).toEqual([]);
  });

  test("未全完成时两份语义一致，且快照不带多余字段（格式不 churn）", async () => {
    const orig = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "in_progress" },
      { content: "任务B", active_form: "正在做B", status: "pending" },
    ]);
    const snap = orig.serialize();
    // 非 allDone 时两者等价，无需额外字段 → 与旧格式逐字节一致
    expect(snap.lastWritten).toBeUndefined();

    const restored = new TodoWriteTool();
    restored.hydrate(snap);
    expect(restored.getTodos()).toEqual(orig.getTodos());
    expect(restored.getLastWrittenTodos()).toEqual(orig.getLastWrittenTodos());
  });

  test("旧快照（无 lastWritten 字段）回灌不崩，事实清单回退到展示清单", () => {
    const restored = new TodoWriteTool();
    restored.hydrate({
      todos: [{ content: "旧格式", activeForm: "正在旧格式", status: "pending" }],
    } as any);
    expect(restored.getTodos().length).toBe(1);
    expect(restored.getLastWrittenTodos().length).toBe(1);
  });

  test("lastWritten 脏数据被逐项清洗，不抛错也不污染", () => {
    const restored = new TodoWriteTool();
    expect(() =>
      restored.hydrate({
        todos: [],
        lastWritten: [
          { content: "好的", activeForm: "正在好的", status: "completed" },
          { bad: 1 },
          null,
          { content: "无效状态", activeForm: "x", status: "nope" },
        ],
      } as any),
    ).not.toThrow();
    expect(restored.getLastWrittenTodos().length).toBe(1);
    expect(restored.getLastWrittenTodos()[0].content).toBe("好的");
  });

  test("多次 resume 不失真（终态快照可反复 round-trip）", async () => {
    const orig = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "completed" },
    ]);
    const r1 = new TodoWriteTool();
    r1.hydrate(orig.serialize());
    const r2 = new TodoWriteTool();
    r2.hydrate(r1.serialize());
    expect(r2.getLastWrittenTodos()).toEqual(orig.getLastWrittenTodos());
    expect(r2.getTodos()).toEqual([]);
  });

  test("/clear 后落空快照 → 恢复后两份语义都为空（不复活幽灵终态）", async () => {
    const orig = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "completed" },
    ]);
    orig.reset();
    const restored = new TodoWriteTool();
    restored.hydrate(orig.serialize());
    // reset 把两份都清了，快照也就不带 lastWritten → 不该反向复活上一个任务的终态
    expect(restored.getTodos()).toEqual([]);
    expect(restored.getLastWrittenTodos()).toEqual([]);
  });
});

describe("hydrate 对脏/空快照容错，不抛错", () => {
  test("undefined / null / 非对象 全部安全跳过", () => {
    const tool = new TodoWriteTool();
    expect(() => tool.hydrate(undefined)).not.toThrow();
    expect(() => tool.hydrate(null)).not.toThrow();
    expect(() => tool.hydrate("bad" as any)).not.toThrow();
    expect(() => tool.hydrate(123 as any)).not.toThrow();
    expect(tool.getTodos()).toEqual([]);
  });

  test("todos 非数组时安全跳过", () => {
    const tool = new TodoWriteTool();
    expect(() => tool.hydrate({ todos: "not-array" } as any)).not.toThrow();
    expect(() => tool.hydrate({ todos: { a: 1 } } as any)).not.toThrow();
    expect(tool.getTodos()).toEqual([]);
  });

  test("脏项被逐条过滤：缺字段/类型不符/status 非法都跳过，合法项保留", () => {
    const tool = new TodoWriteTool();
    tool.hydrate({
      todos: [
        { content: "合法项", activeForm: "正在做合法项", status: "pending" }, // ✓ 保留
        { content: "缺 activeForm", status: "pending" }, // ✗ 缺字段
        { content: "非法 status", activeForm: "x", status: "unknown" }, // ✗ status 非法
        { content: "", activeForm: "空内容", status: "pending" }, // ✗ 空 content
        { activeForm: "缺 content", status: "pending" }, // ✗ 缺 content
        null, // ✗ 非对象
        { content: 123, activeForm: "x", status: "pending" }, // ✗ content 非字符串
      ],
    } as any);
    const todos = tool.getTodos();
    expect(todos.length).toBe(1);
    expect(todos[0].content).toBe("合法项");
  });

  test("全脏快照回灌后为空清单（等价于无历史），不污染", async () => {
    // 先注入合法清单，再用全脏快照回灌 → 覆盖为空（脏项全过滤），不抛错
    const tool = await toolWithTodos([
      { content: "旧任务", active_form: "正在做旧任务", status: "pending" },
    ]);
    expect(() => tool.hydrate({ todos: [{ bad: 1 }, "x", null] } as any)).not.toThrow();
    expect(tool.getTodos()).toEqual([]);
  });
});

describe("todo_state metadata 落盘 + 读回（SessionStore 端到端）", () => {
  let testDir: string;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-code-todo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("serialize → appendMetadata → load 后可回灌，端到端等价", async () => {
    const tool = await toolWithTodos([
      { content: "排查根因", active_form: "正在排查根因", status: "completed" },
      { content: "落地修复", active_form: "正在落地修复", status: "in_progress" },
      { content: "跑测试", active_form: "正在跑测试", status: "pending" },
    ]);

    const store = new SessionStore();
    store.startSession("todo-e2e-001", "claude-opus-4-8", "anthropic", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    store.appendMetadata("todo_state", tool.serialize());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("todo-e2e-001");
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata?.["todo_state"]).toBeDefined();

    // 模拟 restoreSession 的回灌
    const resumed = new TodoWriteTool();
    resumed.hydrate(loaded!.metadata!["todo_state"] as any);

    expect(resumed.getTodos()).toEqual(tool.getTodos());
    expect(resumed.getTodos().length).toBe(3);
  });

  test("覆盖语义：多次 appendMetadata 后 load 取最后一条（模拟每轮 done 落盘）", async () => {
    const store = new SessionStore();
    store.startSession("todo-e2e-002", "claude-opus-4-8", "anthropic", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });

    // 第一轮：2 项
    const t1 = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "in_progress" },
      { content: "任务B", active_form: "正在做B", status: "pending" },
    ]);
    store.appendMetadata("todo_state", t1.serialize());

    // 第二轮：A 完成、B 进行中（全量替换后再落盘）
    const t2 = await toolWithTodos([
      { content: "任务A", active_form: "正在做A", status: "completed" },
      { content: "任务B", active_form: "正在做B", status: "in_progress" },
    ]);
    store.appendMetadata("todo_state", t2.serialize());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("todo-e2e-002");
    const resumed = new TodoWriteTool();
    resumed.hydrate(loaded!.metadata!["todo_state"] as any);

    // 恢复到最后一条：A completed / B in_progress
    expect(resumed.getTodos()[0].status).toBe("completed");
    expect(resumed.getTodos()[1].status).toBe("in_progress");
  });

  test("空清单快照落盘后恢复为空（/clear 后退出的边界：不复活幽灵清单）", async () => {
    const store = new SessionStore();
    store.startSession("todo-e2e-003", "claude-opus-4-8", "anthropic", "/cwd");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] });

    // 先落一条非空（模拟 clear 前）
    const before = await toolWithTodos([
      { content: "旧清单", active_form: "正在做旧清单", status: "pending" },
    ]);
    store.appendMetadata("todo_state", before.serialize());

    // /clear 后立即落一条空快照（persistTodoState 在 clear 分支被调用）
    const cleared = new TodoWriteTool(); // 空实例代表 reset 后
    store.appendMetadata("todo_state", cleared.serialize());
    SessionStore.flushPendingWrites();

    const loaded = await store.load("todo-e2e-003");
    const resumed = new TodoWriteTool();
    resumed.hydrate(loaded!.metadata!["todo_state"] as any);

    // 恢复到最后一条（空），不复活 clear 前的旧清单
    expect(resumed.getTodos()).toEqual([]);
  });
});
