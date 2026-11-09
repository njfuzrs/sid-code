/**
 * D6 / D7：todo_write 的 S1 撤销必须「主会话专属」且「blocked 不算清单清零」
 *
 * 复现来源：docs-research/sid-code/bugfixes/todo/20261109-等待态四PR合入后review缺陷-修复与验收方案.md
 * 附录 A 的 R4（D6）/ R5（D7）。断言按 §3.2 的验收口径**反转**为期望的正确行为：
 *   - D6：子代理自己的清单清零，不许撤销主会话的唤醒（撤销动作是进程级全局副作用）。
 *   - D7：剩余项标 blocked（等外部系统）不算「清单清零」，不许撤销唤醒。
 *
 * 不写盘：等待登记表与调度器都是进程内状态。仍按测试约定把 `SID_CONFIG_DIR` 重定向到
 * tmpdir——调度器 / 轨迹链路可能落盘（与 `tests/task/wait-registry.test.ts` 同款装配）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  __resetWaitRegistryForTest,
  drainWaitNotices,
  isWaitInvalidated,
  listWaits,
  registerWait,
  setWakeupRegistrationEnabled,
} from "../../src/task/wait-registry.ts";
import { resetScheduler, getScheduler } from "../../src/cron/scheduler.ts";
import { TodoWriteTool } from "../../src/tool/todo-write.ts";
import type { CronTask } from "../../src/cron/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";

const FIRE_AT = Date.now() + 1_500_000;

/** 起一条会话级唤醒（等价于 schedule_wakeup 成功后的调度器 + 登记表状态） */
function scheduleWakeup(id: string): void {
  const task: CronTask = {
    id,
    cron: "",
    prompt: "检查 PR #662 的 CI 状态",
    createdAt: Date.now(),
    recurring: false,
    durable: false,
    fireAt: FIRE_AT,
    origin: "schedule_wakeup",
  };
  getScheduler().addSessionTask(task);
  registerWait({
    id,
    kind: "wakeup",
    promise: { kind: "deadline", deadlineAt: FIRE_AT },
    description: "检查 PR #662 的 CI",
    registeredAt: Date.now(),
  });
}

const item = (content: string, status: string) => ({ content, active_form: content, status });

const wakeupAlive = (id: string) => getScheduler().getSessionTask(id) !== undefined;

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-todo-wakeup-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  setWakeupRegistrationEnabled(true);
  resetScheduler();
  getScheduler({ onFire: () => {}, isLoading: () => false, sessionId: "t", workspaceDir: "/tmp" });
});

afterEach(() => {
  __resetWaitRegistryForTest();
  resetScheduler();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("D6：子代理的独立实例不许撤销主会话的唤醒", () => {
  test("R4：子代理实例（默认构造）把自己的清单做完，主会话唤醒仍在", async () => {
    scheduleWakeup("wk-main");
    expect(wakeupAlive("wk-main")).toBe(true);

    // `agent/sub-agent.ts` 给每个子代理构造的就是这份「无选项」实例
    const sub = new TodoWriteTool();
    await sub.execute({ todos: [item("读文件", "in_progress")] });
    await sub.execute({ todos: [item("读文件", "completed")] });

    expect(wakeupAlive("wk-main")).toBe(true);
    expect(listWaits().some((w) => w.id === "wk-main")).toBe(true);
    expect(drainWaitNotices()).toEqual([]);
    expect(isWaitInvalidated("wk-main")).toBe(false);
  });

  test("对照组：主会话实例（invalidatesWakeups: true）清零清单 → S1 照常撤销", async () => {
    scheduleWakeup("wk-main");
    const main = new TodoWriteTool({ invalidatesWakeups: true });
    await main.execute({ todos: [item("改代码", "in_progress")] });
    const r = await main.execute({ todos: [item("改代码", "completed")] });

    // T-W3-3 的口径不变：S1 本身仍然有效，撤销后不可恢复
    expect(wakeupAlive("wk-main")).toBe(false);
    expect(isWaitInvalidated("wk-main")).toBe(true);
    expect(drainWaitNotices().filter((n) => n.taskId === "wk-main")).toHaveLength(1);

    // 撤销是全局副作用，TUI 那条系统行（D9）不进模型上下文 → 返回值必须告诉模型一次，
    // 否则它以为自己还会被叫醒（同轮「清零 → 又写回新清单」的实测形态就是这样丢的）。
    expect(r.output).toContain("已随清单清零撤销");
    expect(r.output).toContain("schedule_wakeup");
  });

  test("子代理实例写清单不污染主会话清单（P1-2 的隔离仍成立）", async () => {
    const main = new TodoWriteTool({ invalidatesWakeups: true });
    const sub = new TodoWriteTool();
    await main.execute({ todos: [item("主任务", "in_progress")] });
    await sub.execute({ todos: [item("子任务", "in_progress")] });

    expect(main.getTodos().map((t) => t.content)).toEqual(["主任务"]);
    expect(sub.getTodos().map((t) => t.content)).toEqual(["子任务"]);
  });
});

describe("D7：blocked 不算「清单清零」", () => {
  test("R5：pending → blocked 写入后唤醒仍在（等 CI 是工具描述亲自教的正确用法）", async () => {
    scheduleWakeup("wk-b");
    const main = new TodoWriteTool({ invalidatesWakeups: true });
    await main.execute({
      todos: [item("提 PR", "in_progress"), item("等 CI 合并后改文档", "pending")],
    });
    await main.execute({
      todos: [item("提 PR", "completed"), item("等 CI 合并后改文档", "blocked")],
    });

    expect(wakeupAlive("wk-b")).toBe(true);
    expect(listWaits().some((w) => w.id === "wk-b")).toBe(true);
    expect(drainWaitNotices()).toEqual([]);
  });

  test("边界：[completed, blocked] 不触发；blocked → completed 才触发", async () => {
    scheduleWakeup("wk-b2");
    const main = new TodoWriteTool({ invalidatesWakeups: true });

    await main.execute({ todos: [item("改代码", "completed")] });
    // 一开始就 [completed]：之前 > 0 的前提不成立，不触发
    expect(wakeupAlive("wk-b2")).toBe(true);

    await main.execute({ todos: [item("改代码", "completed"), item("等 CI", "blocked")] });
    expect(wakeupAlive("wk-b2")).toBe(true);

    // 等的东西到了，模型自己标完成 → 这才算清零
    await main.execute({ todos: [item("改代码", "completed"), item("等 CI", "completed")] });
    expect(wakeupAlive("wk-b2")).toBe(false);
    expect(drainWaitNotices().filter((n) => n.taskId === "wk-b2")).toHaveLength(1);
  });

  test("边界：写入空清单 [] 不算清零（它什么都没说）", async () => {
    scheduleWakeup("wk-empty");
    const main = new TodoWriteTool({ invalidatesWakeups: true });
    await main.execute({ todos: [item("改代码", "in_progress")] });

    await main.execute({ todos: [] });

    expect(wakeupAlive("wk-empty")).toBe(true);
    expect(drainWaitNotices()).toEqual([]);
  });

  test("边界：从未写过清单的会话，首次就写全 completed 不触发（之前 > 0 的前提）", async () => {
    scheduleWakeup("wk-first");
    const main = new TodoWriteTool({ invalidatesWakeups: true });

    await main.execute({ todos: [item("顺手记的一项", "completed")] });

    expect(wakeupAlive("wk-first")).toBe(true);
  });
});

describe("构造点穷举：只有主会话注册点传 invalidatesWakeups: true", () => {
  /**
   * 反漂移哨兵：这个选项的意义完全依赖「谁会传 true」。以后新增一个隔离实例
   * （又一个子代理 / 后台执行器）却顺手传了 true，D6 就会以新形态复发。
   * 断言读**源码文本**而不是运行时实例（实例不可枚举）。
   */
  function walkTs(dir: string, out: string[]): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walkTs(full, out);
      else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
    }
  }

  test("packages/*/src 下 new TodoWriteTool 恰好两处，且只有 cli.ts 传 true", () => {
    // import.meta.dir = <repo>/packages/core/tests/tool → 上四层才是仓库根
    const repoRoot = join(import.meta.dir, "../../../..");
    const hits: Array<{ rel: string; line: number; text: string }> = [];
    for (const pkg of readdirSync(join(repoRoot, "packages"))) {
      const srcDir = join(repoRoot, "packages", pkg, "src");
      if (!existsSync(srcDir)) continue;
      const files: string[] = [];
      walkTs(srcDir, files);
      for (const file of files) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((text, i) => {
          if (!text.includes("new TodoWriteTool")) return;
          // 跳过注释：判据要读代码，不读注释（memory gate-assertions-must-read-code-not-comments）
          const trimmed = text.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
          hits.push({ rel: file.slice(repoRoot.length + 1), line: i + 1, text: trimmed });
        });
      }
    }

    expect(hits).toHaveLength(2);
    const main = hits.find((h) => h.rel === join("packages/cli/src/cli.ts"));
    const sub = hits.find((h) => h.rel === join("packages/core/src/agent/sub-agent.ts"));
    expect(main).toBeDefined();
    expect(sub).toBeDefined();
    // 主会话：必须显式开启
    expect(main!.text).toContain("invalidatesWakeups: true");
    // 子代理：必须保持默认（不传参数）
    expect(sub!.text).toBe("replacement = new TodoWriteTool();");
  });
});
