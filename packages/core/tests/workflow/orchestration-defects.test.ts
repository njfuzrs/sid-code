/**
 * 编排侧缺陷回归（顺着 sc-16 核出的 8 条：P0-1/2/3/4、P1-1/2/3/8）
 *
 * 这些缺陷能长期存活的共同原因：既有门禁单测全走**串行**路径，而生产路径是扇出。
 * 所以这里每条都经过 parallel/pipeline 断言，不只测 `await api.agent(...)`。
 */

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowRuntime,
  BudgetExceededError,
  AgentLimitError,
  WorkflowAbortedError,
  UndeclaredPhaseError,
  MAX_AGENTS_PER_RUN,
} from "@sid-code/core/workflow/runtime.ts";
import { Journal, isStructurallyAfter } from "@sid-code/core/workflow/journal.ts";
import { Scheduler } from "@sid-code/core/workflow/scheduler.ts";
import { runInSandbox } from "@sid-code/core/workflow/sandbox.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tmpDirs: string[] = [];
function freshJournalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-orch-"));
  tmpDirs.push(dir);
  return join(dir, "journal.jsonl");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function loadJournal(path: string): Journal {
  const j = new Journal(path);
  j.load();
  return j;
}

describe("P0-1 journal 不缓存失败（null）", () => {
  test("第一次子代理失败 → resume 时重跑而不是永久回放 null", async () => {
    const path = freshJournalPath();
    const rt1 = new WorkflowRuntime({
      runner: { run: async () => null },
      journal: loadJournal(path),
    });
    expect(await rt1.buildApi().agent("x")).toBe(null);

    let called = 0;
    const rt2 = new WorkflowRuntime({
      runner: {
        run: async () => {
          called++;
          return "OK";
        },
      },
      journal: loadJournal(path),
    });
    expect(await rt2.buildApi().agent("x")).toBe("OK");
    expect(called).toBe(1);
  });

  test("老 journal 里已写下的 null 记录回放时视为未命中", () => {
    const j = new Journal(null);
    // 直接构造老数据形态：绕过 record 的 null 门
    (j as unknown as { entries: Map<string, unknown> }).entries.set("0", {
      callIndex: 0,
      fingerprint: "fp",
      result: null,
    });
    expect(j.lookup(0, "fp")).toBe(null);
  });
});

describe("P0-2 指纹失效让其后序号全部重跑", () => {
  test("改了第 2 个 agent → 第 3 个也重跑", async () => {
    const path = freshJournalPath();
    const script = (b: string) => `export const meta = { name: 'r', description: 'd' }
      return [await agent('A'), await agent('${b}'), await agent('C')];`;
    await runInSandbox(
      script("B"),
      new WorkflowRuntime({
        runner: { run: async (p) => `v1(${p})` },
        journal: loadJournal(path),
      }).buildApi(),
    );
    const ran: string[] = [];
    const { value } = await runInSandbox(
      script("B-CHANGED"),
      new WorkflowRuntime({
        runner: {
          run: async (p) => {
            ran.push(p);
            return `v2(${p})`;
          },
        },
        journal: loadJournal(path),
      }).buildApi(),
    );
    expect(value).toEqual(["v1(A)", "v2(B-CHANGED)", "v2(C)"]);
    expect(ran).toEqual(["B-CHANGED", "C"]);
  });

  test("扇出里只连坐真正的下游：兄弟分支照常命中", async () => {
    const path = freshJournalPath();
    const script = (p1: string) => `export const meta = { name: 'r', description: 'd' }
      const xs = await parallel([() => agent('P0'), () => agent('${p1}'), () => agent('P2')]);
      const after = await agent('AFTER');
      return [...xs, after];`;
    await runInSandbox(
      script("P1"),
      new WorkflowRuntime({
        runner: { run: async (p) => `v1(${p})` },
        journal: loadJournal(path),
      }).buildApi(),
    );
    const ran: string[] = [];
    await runInSandbox(
      script("P1-CHANGED"),
      new WorkflowRuntime({
        runner: {
          run: async (p) => {
            ran.push(p);
            return `v2(${p})`;
          },
        },
        journal: loadJournal(path),
      }).buildApi(),
    );
    // P0/P2 是兄弟，不依赖 P1；AFTER 在 parallel 之后，依赖它
    expect(ran.sort()).toEqual(["AFTER", "P1-CHANGED"]);
  });

  test("isStructurallyAfter：顺序作用域里序号更大才算之后，兄弟分支独立", () => {
    expect(isStructurallyAfter("2", "1")).toBe(true);
    expect(isStructurallyAfter("0", "1")).toBe(false);
    expect(isStructurallyAfter("1p0/0", "1p1/0")).toBe(false);
    expect(isStructurallyAfter("1p1/1", "1p1/0")).toBe(true);
    expect(isStructurallyAfter("2", "1p1/0")).toBe(true);
    expect(isStructurallyAfter("1p0/0", "0")).toBe(true);
  });
});

describe("P0-3 缓存键由脚本结构决定，不随完成顺序漂移", () => {
  // 同 prompt 的并行分支：只有 label 不同（label 不进指纹），结果由分支下标决定
  const SCRIPT = `export const meta = { name: 'r', description: 'd' }
    return await pipeline([0, 1, 2],
      (item) => agent('same', { label: 's1-' + item }),
      (prev, item) => agent('same', { label: 's2-' + item }));`;

  test("两次 run 时序相反 → resume 结果与第一次逐项一致", async () => {
    const path = freshJournalPath();
    const delays1 = [30, 5, 1];
    const { value: first } = await runInSandbox(
      SCRIPT,
      new WorkflowRuntime({
        runner: {
          run: async (_p, _o, ctx) => {
            const item = Number(ctx.label.slice(3));
            await delay(delays1[item]!);
            return ctx.label;
          },
        },
        journal: loadJournal(path),
      }).buildApi(),
    );
    expect(first).toEqual(["s2-0", "s2-1", "s2-2"]);

    let called = 0;
    const { value: second } = await runInSandbox(
      SCRIPT,
      new WorkflowRuntime({
        runner: {
          run: async () => {
            called++;
            return "SHOULD-NOT-RUN";
          },
        },
        journal: loadJournal(path),
      }).buildApi(),
    );
    expect(called).toBe(0);
    expect(second).toEqual(first);
  });

  test("记录的 key 与完成顺序无关", async () => {
    const run = async (delays: number[]) => {
      const j = new Journal(null);
      await runInSandbox(
        SCRIPT,
        new WorkflowRuntime({
          runner: {
            run: async (_p, _o, ctx) => {
              await delay(delays[Number(ctx.label.slice(3))]!);
              return ctx.label;
            },
          },
          journal: j,
        }).buildApi(),
      );
      return Object.fromEntries(j.all().map((e) => [e.key, e.result]));
    };
    expect(await run([30, 5, 1])).toEqual(await run([1, 5, 30]));
  });
});

describe("P0-4 + P1-2 预算硬门在扇出下生效，且不被吞成 null", () => {
  function spendingRuntime(budgetTotal: number, concurrency = 4) {
    let spent = 0;
    const rt = new WorkflowRuntime({
      runner: {
        run: async () => {
          await delay(1);
          spent += 1000;
          return "ok";
        },
      },
      budgetTotal,
      spentReader: () => spent,
      concurrency,
    });
    return { rt, spent: () => spent };
  }

  test("parallel(100)、预算 1500、并发 1 → 抛 BudgetExceededError，只花 2 个", async () => {
    const { rt, spent } = spendingRuntime(1500, 1);
    const api = rt.buildApi();
    await expect(
      api.parallel(Array.from({ length: 100 }, () => () => api.agent("x"))),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(spent()).toBe(2000);
  });

  test("pipeline(100)、预算 1500 → 超支被限制在一个并发批次内", async () => {
    const { rt, spent } = spendingRuntime(1500, 4);
    const api = rt.buildApi();
    await expect(
      api.pipeline(
        Array.from({ length: 100 }, (_, i) => i),
        () => api.agent("x"),
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // 第一批 4 个在任何花费前已取到槽位；之后的全被拦下
    expect(spent()).toBeLessThanOrEqual(4000);
  });

  test("runaway 上限在 parallel 里穿透为 AgentLimitError", async () => {
    const rt = new WorkflowRuntime({ runner: { run: async () => "ok" } });
    const api = rt.buildApi();
    await expect(
      api.parallel(Array.from({ length: MAX_AGENTS_PER_RUN + 5 }, () => () => api.agent("x"))),
    ).rejects.toBeInstanceOf(AgentLimitError);
  });

  test("普通子代理失败仍然落 null，不拖累兄弟（无屏障语义不变）", async () => {
    const rt = new WorkflowRuntime({
      runner: {
        run: async (p) => {
          if (p === "bad") throw new Error("boom");
          return p;
        },
      },
    });
    const api = rt.buildApi();
    expect(await api.parallel([() => api.agent("a"), () => api.agent("bad")])).toEqual(["a", null]);
    expect(await api.pipeline(["a", "bad"], (item) => api.agent(item as string))).toEqual([
      "a",
      null,
    ]);
  });
});

describe("P1-3 abort 后不再发起剩余 agent，排队任务被放弃", () => {
  test("并发 1、6 个任务，第 1 个跑到一半 abort → 只执行 1 个，整体 reject", async () => {
    const ac = new AbortController();
    let started = 0;
    const rt = new WorkflowRuntime({
      runner: {
        run: async () => {
          started++;
          await delay(20);
          return "ok";
        },
      },
      concurrency: 1,
      signal: ac.signal,
    });
    const api = rt.buildApi();
    const p = api.parallel(Array.from({ length: 6 }, () => () => api.agent("x")));
    await delay(5);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(WorkflowAbortedError);
    expect(started).toBe(1);
  });

  test("pipeline 在 abort 后不进入后续 stage", async () => {
    const ac = new AbortController();
    const seen: string[] = [];
    const rt = new WorkflowRuntime({
      runner: {
        run: async (p) => {
          seen.push(p);
          if (p.startsWith("s1")) ac.abort();
          return p;
        },
      },
      signal: ac.signal,
    });
    const api = rt.buildApi();
    await expect(
      api.pipeline(
        [0, 1, 2],
        (item) => api.agent(`s1-${item}`),
        (_prev, item) => api.agent(`s2-${item}`),
      ),
    ).rejects.toBeInstanceOf(WorkflowAbortedError);
    expect(seen.some((p) => p.startsWith("s2"))).toBe(false);
  });

  test("Scheduler：排队中的任务在 abort 时出队并 reject，槽位不泄漏", async () => {
    const s = new Scheduler(1);
    const ac = new AbortController();
    const first = s.run(() => delay(10).then(() => 1), ac.signal);
    const queued = s.run(async () => 2, ac.signal);
    expect(s.queued).toBe(1);
    ac.abort();
    await expect(queued).rejects.toBeDefined();
    expect(s.queued).toBe(0);
    expect(await first).toBe(1);
    expect(s.running).toBe(0);
  });
});

describe("P1-1 影子 Date 不能经 prototype 链拿回真 Date", () => {
  const META = "export const meta = { name: 'd', description: 'd' }";
  const api = new WorkflowRuntime({ runner: { run: async () => null } }).buildApi();
  const escapes = [
    "return Date.prototype.constructor.now()",
    "return new Date(0).constructor()",
    "return new (Date.prototype.constructor)()",
    "return new Date(0).constructor.now()",
  ];
  for (const body of escapes) {
    test(`被拦：${body}`, async () => {
      await expect(runInSandbox(`${META}\n${body}`, api)).rejects.toThrow(/被禁/);
    });
  }

  test("带参 new Date 的实例方法、instanceof、比较、JSON 照常工作", async () => {
    const { value } = await runInSandbox(
      `${META}
       const d = new Date(86400000);
       return [d instanceof Date, d.getUTCDate(), d.toISOString(), +d, d < new Date(9e7), JSON.stringify({d}), Date.prototype.constructor === Date];`,
      api,
    );
    expect(value).toEqual([
      true,
      2,
      "1970-01-02T00:00:00.000Z",
      86400000,
      true,
      '{"d":"1970-01-02T00:00:00.000Z"}',
      true,
    ]);
  });
});

describe("P1-8 并发子 workflow 的 phase 声明互不串台", () => {
  test("A 的 phase() 落在兄弟 B 的窗口内仍按 A 自己的声明对账（strict 下不误拒）", async () => {
    const rt = new WorkflowRuntime({
      runner: { run: async () => "ok" },
      declaredPhases: ["父"],
      strictPhases: true,
    });
    const api = rt.buildApi();
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => (releaseA = r));
    const results = await api.parallel([
      () =>
        rt.withDeclaredPhases(["A阶段"], async () => {
          await aGate; // 等 B 已进入窗口
          api.phase("A阶段");
          return "A";
        }),
      () =>
        rt.withDeclaredPhases(["B阶段"], async () => {
          releaseA();
          await delay(5);
          api.phase("B阶段");
          return "B";
        }),
    ]);
    expect(results).toEqual(["A", "B"]);
    // 子 workflow 结束后父声明照旧
    expect(() => api.phase("父")).not.toThrow();
    expect(() => api.phase("A阶段")).toThrow(UndeclaredPhaseError);
  });

  test("strict 对账失败本身穿透 parallel（不被吞成 null）", async () => {
    const rt = new WorkflowRuntime({
      runner: { run: async () => "ok" },
      declaredPhases: ["父"],
      strictPhases: true,
    });
    const api = rt.buildApi();
    await expect(
      api.parallel([
        async () => {
          api.phase("没声明");
        },
      ]),
    ).rejects.toBeInstanceOf(UndeclaredPhaseError);
  });

  test("并发子 workflow 的 agent() 拿到各自独立的缓存键前缀", async () => {
    const j = new Journal(null);
    const rt = new WorkflowRuntime({
      runner: {
        run: async (_p, _o, ctx) => {
          await delay(ctx.label === "a" ? 10 : 1);
          return ctx.label;
        },
      },
      journal: j,
    });
    const api = rt.buildApi();
    await api.parallel([
      () => rt.withDeclaredPhases([], () => api.agent("same", { label: "a" })),
      () => rt.withDeclaredPhases([], () => api.agent("same", { label: "b" })),
    ]);
    expect(Object.fromEntries(j.all().map((e) => [e.key, e.result]))).toEqual({
      "0p0/0w/0": "a",
      "0p1/0w/0": "b",
    });
  });
});
