/**
 * Dynamic Workflows M4 — 每代理 cwd 上下文单测
 *
 * 固化:
 *  - withAgentCwd 在并发 + 跨 await 下各自隔离不串台
 *  - getCwd() 在上下文内返回 agent cwd,上下文外回退全局
 */

import { test, expect, describe } from "bun:test";
import { withAgentCwd, getAgentCwd } from "@sid-code/core/bootstrap/cwd-context.ts";
import { getCwd, setCwd, getOriginalCwd } from "@sid-code/core/bootstrap/state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("M4 cwd-context — 基本", () => {
  test("上下文外 getAgentCwd() 为 undefined", () => {
    expect(getAgentCwd()).toBeUndefined();
  });

  test("withAgentCwd 内 getAgentCwd() 返回绑定值", () => {
    const r = withAgentCwd("/wt/x", () => getAgentCwd());
    expect(r).toBe("/wt/x");
    // 退出后恢复
    expect(getAgentCwd()).toBeUndefined();
  });

  test("getCwd() 在上下文内返回 agent cwd,上下文外返回全局", () => {
    const globalBefore = getCwd();
    expect(globalBefore).toBeTruthy();
    const inside = withAgentCwd("/wt/agent-1", () => getCwd());
    expect(inside).toBe("/wt/agent-1");
    // 上下文外仍是全局值(未被污染)
    expect(getCwd()).toBe(globalBefore);
  });
});

describe("M4 cwd-context — 并发隔离(真并行 worktree 的地基)", () => {
  test("三个并发 agent 各自 cwd 跨 await 不串台", async () => {
    async function agentWork(cwd: string, ms: number): Promise<string> {
      return withAgentCwd(cwd, async () => {
        await delay(ms);
        const a = getCwd();
        await delay(5);
        const b = getCwd();
        return `${a}|${b}`;
      });
    }
    const [ra, rb, rc] = await Promise.all([
      agentWork("/wt/a", 30),
      agentWork("/wt/b", 10),
      agentWork("/wt/c", 20),
    ]);
    expect(ra).toBe("/wt/a|/wt/a");
    expect(rb).toBe("/wt/b|/wt/b");
    expect(rc).toBe("/wt/c|/wt/c");
  });

  test("嵌套 withAgentCwd 内层覆盖外层,退出恢复", async () => {
    const result = await withAgentCwd("/outer", async () => {
      const before = getCwd();
      const inner = await withAgentCwd("/inner", async () => getCwd());
      const after = getCwd();
      return { before, inner, after };
    });
    expect(result.before).toBe("/outer");
    expect(result.inner).toBe("/inner");
    expect(result.after).toBe("/outer"); // 内层退出后恢复外层
  });

  test("并发 agent 不影响全局 cwd", async () => {
    const globalBefore = getCwd();
    await Promise.all([
      withAgentCwd("/wt/p", async () => {
        await delay(10);
      }),
      withAgentCwd("/wt/q", async () => {
        await delay(10);
      }),
    ]);
    expect(getCwd()).toBe(globalBefore);
  });
});

describe("M4 cwd-context — 与 setCwd 全局态共存", () => {
  // W16:旧断言是「上下文内 setCwd 改全局、上下文内读不到」——那正是缺陷本身:
  // 子代理 bash cd 不生效,主会话目录反被改掉。现在写与读落在同一个位置(本上下文)。
  test("上下文内 setCwd 只改本上下文,不改全局", () => {
    const original = getCwd();
    try {
      const r = withAgentCwd("/wt/iso", () => {
        setCwd("/wt/iso/sub");
        return getCwd();
      });
      expect(r).toBe("/wt/iso/sub");
      expect(getCwd()).toBe(original);
    } finally {
      setCwd(original);
    }
  });

  test("上下文外 setCwd 仍改全局", () => {
    const original = getCwd();
    try {
      setCwd("/some/other/global");
      expect(getCwd()).toBe("/some/other/global");
      // 已绑定的 agent 上下文不受全局改动影响
      expect(withAgentCwd("/wt/iso", () => getCwd())).toBe("/wt/iso");
    } finally {
      setCwd(original);
    }
  });

  test("getOriginalCwd 不受影响", () => {
    expect(getOriginalCwd()).toBeTruthy();
  });
});
