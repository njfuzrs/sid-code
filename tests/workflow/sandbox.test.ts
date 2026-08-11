/**
 * Dynamic Workflows M0 — 沙箱单测
 *
 * 覆盖路线图 M0 三条验收 + 安全逃逸对抗:
 *  1. require('fs')/process.exit() 被拦截
 *  2. log() 透传到主会话
 *  3. meta(name/description/phases)能解析,且校验它是纯字面量
 *  4. 确定性守卫:Date.now/Math.random/无参 new Date 被禁(运行时,非字符串扫描)
 *  5. 逃逸对抗:globalThis/Function 构造器/this 逃逸/import() 全被堵
 */

import { test, expect, describe } from "bun:test";
import {
  runInSandbox,
  parseAndValidateMeta,
  stripStringsAndComments,
} from "@sid-code/core/workflow/sandbox.ts";
import type { WorkflowApi } from "@sid-code/core/workflow/types.ts";

/** 构造一个最小可用的 WorkflowApi(测试用,agent 返回固定值) */
function makeApi(overrides: Partial<WorkflowApi> = {}): { api: WorkflowApi; logs: string[] } {
  const logs: string[] = [];
  const api: WorkflowApi = {
    agent: async (prompt: string) => `agent-result:${prompt}`,
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    pipeline: async (items) => items,
    phase: () => {},
    log: (m: string) => logs.push(m),
    args: undefined,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    ...overrides,
  };
  return { api, logs };
}

const META_HEADER = `export const meta = { name: 'test-wf', description: '测试用 workflow' }`;

describe("M0 sandbox — meta 解析与校验", () => {
  test("能解析纯字面量 meta(name/description/phases)", () => {
    const src = `export const meta = {
      name: 'find-flaky',
      description: 'Find flaky tests',
      whenToUse: '当测试偶发失败',
      phases: [{ title: 'Scan', detail: 'grep logs' }, { title: 'Fix', model: 'opus' }],
    }`;
    const r = parseAndValidateMeta(src);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta.name).toBe("find-flaky");
      expect(r.meta.description).toBe("Find flaky tests");
      expect(r.meta.phases?.length).toBe(2);
      expect(r.meta.phases?.[0]?.title).toBe("Scan");
      expect(r.meta.phases?.[1]?.model).toBe("opus");
    }
  });

  test("缺 meta → 报错", () => {
    const r = parseAndValidateMeta(`const x = agent('hi')`);
    expect(r.ok).toBe(false);
  });

  test("meta.name 缺失 → 报错", () => {
    const r = parseAndValidateMeta(`export const meta = { description: '只有描述' }`);
    expect(r.ok).toBe(false);
  });

  test("meta 引用变量(非纯字面量)→ 报错", () => {
    const src = `const n = 'dynamic'; export const meta = { name: n, description: 'x' }`;
    const r = parseAndValidateMeta(src);
    expect(r.ok).toBe(false);
  });

  test("meta 含函数调用(非纯字面量)→ 报错", () => {
    const src = `export const meta = { name: makeName(), description: 'x' }`;
    const r = parseAndValidateMeta(src);
    expect(r.ok).toBe(false);
  });

  test("meta 含模板插值(非纯字面量)→ 报错", () => {
    const src = "export const meta = { name: `wf-${1+1}`, description: 'x' }";
    const r = parseAndValidateMeta(src);
    // 模板插值里有表达式,求值时引用不到的变量会抛错;纯常量插值则不应误判
    // 这里 ${1+1} 是常量,实际可求值 → 允许;改测引用变量的插值
    const src2 = "const v=1; export const meta = { name: `wf-${v}`, description: 'x' }";
    const r2 = parseAndValidateMeta(src2);
    expect(r2.ok).toBe(false);
    void r;
  });

  test("字符串里出现 'const meta =' 不会误判", () => {
    const src = `export const meta = { name: 'real', description: "注意 const meta = 假的" }`;
    const r = parseAndValidateMeta(src);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.name).toBe("real");
  });
});

describe("M0 sandbox — log() 透传", () => {
  test("log() 写到注入的 logs 数组", async () => {
    const { api, logs } = makeApi();
    const src = `${META_HEADER}\nlog('第一行'); log('第二行');`;
    await runInSandbox(src, api);
    expect(logs).toEqual(["第一行", "第二行"]);
  });

  test("agent() 返回值可被脚本使用并 return", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nconst r = await agent('查 bug'); return r;`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe("agent-result:查 bug");
  });

  test("args 注入可见", async () => {
    const { api } = makeApi({ args: { question: "为什么慢" } });
    const src = `${META_HEADER}\nreturn args.question;`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe("为什么慢");
  });
});

describe("M0 sandbox — 危险全局被拦截", () => {
  test("require('fs') 被拦(静态扫描)", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nconst fs = require('fs');`;
    await expect(runInSandbox(src, api)).rejects.toThrow(/require/);
  });

  test("process.exit() 被拦(process 在 context 里为 undefined)", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nprocess.exit(1);`;
    await expect(runInSandbox(src, api)).rejects.toThrow();
  });

  test("动态 import() 被拦(静态扫描)", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nawait import('fs');`;
    await expect(runInSandbox(src, api)).rejects.toThrow(/import/);
  });

  test("eval 被拦(静态扫描)", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\neval('1+1');`;
    await expect(runInSandbox(src, api)).rejects.toThrow(/eval/);
  });

  test("globalThis 在 context 里不可见(typeof undefined)", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nreturn typeof globalThis === 'undefined' ? 'gone' : typeof globalThis.process;`;
    const { value } = await runInSandbox(src, api);
    // globalThis 在 vm context 里指向 context 自身,其上没有 process
    expect(value === "gone" || value === "undefined").toBe(true);
  });

  test("【关键回归】constructor 链逃逸被 vm 隔离(拿不到真 process)", async () => {
    // 这是 param-shadow 方案被击穿的那一句:Array.constructor === 真 Function。
    // vm context 下,它编译出的代码只在隔离 realm 跑,process 仍不可见。
    const { api } = makeApi();
    const src = `${META_HEADER}
      const F = [].constructor.constructor;
      return String(F('return typeof process')());`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe("undefined");
  });

  test("【关键回归】constructor 链拿 globalThis 也碰不到宿主 process", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}
      const F = [].constructor.constructor;
      const g = F('return globalThis')();
      return String(typeof g.process);`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe("undefined");
  });

  test("宿主全局 setTimeout / queueMicrotask 在 context 里不可见", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nreturn typeof setTimeout + '/' + typeof queueMicrotask;`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe("undefined/undefined");
  });

  test("宿主全局 crypto / performance 在 context 里不可见(堵确定性绕过)", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nreturn typeof crypto + '/' + typeof performance;`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe("undefined/undefined");
  });

  test("Bun 全局在 context 里不可见", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nreturn typeof Bun;`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe("undefined");
  });

  test("【CPU 兜底】同步死循环被 timeout 掐断", async () => {
    const { api } = makeApi();
    // 用环境变量把同步超时压到 500ms,避免单测等太久
    const prev = process.env.SID_WORKFLOW_SYNC_TIMEOUT_MS;
    process.env.SID_WORKFLOW_SYNC_TIMEOUT_MS = "500";
    try {
      const src = `${META_HEADER}\nwhile(true){}`;
      await expect(runInSandbox(src, api)).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SID_WORKFLOW_SYNC_TIMEOUT_MS;
      else process.env.SID_WORKFLOW_SYNC_TIMEOUT_MS = prev;
    }
  });
});

describe("M0 sandbox — 确定性守卫(运行时影子)", () => {
  test("Date.now() 被禁", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nreturn Date.now();`;
    await expect(runInSandbox(src, api)).rejects.toThrow(/Date\.now/);
  });

  test("无参 new Date() 被禁", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nreturn new Date();`;
    await expect(runInSandbox(src, api)).rejects.toThrow(/new Date/);
  });

  test("带参 new Date(ts) 放行(确定性)", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nconst d = new Date(0); return d.getUTCFullYear();`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe(1970);
  });

  test("Math.random() 被禁", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nreturn Math.random();`;
    await expect(runInSandbox(src, api)).rejects.toThrow(/Math\.random/);
  });

  test("Math.max 等确定性方法放行", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nreturn Math.max(3, 7, 5) + Math.floor(2.9);`;
    const { value } = await runInSandbox(src, api);
    expect(value).toBe(9);
  });

  test("prompt 字符串里含 'Date.now' 不被误杀(避开 cc #63759)", async () => {
    const { api, logs } = makeApi();
    // 关键:'Date.now' 出现在字符串里,不应触发守卫
    const src = `${META_HEADER}\nlog('请分析 Date.now() 的调用'); await agent('解释 Math.random 的用途');`;
    await runInSandbox(src, api);
    expect(logs[0]).toContain("Date.now");
  });
});

describe("M0 sandbox — 标准 JS 内置可用", () => {
  test("JSON / Array / Object / Promise 可用", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}
      const arr = [3, 1, 2].sort();
      const obj = JSON.parse('{"k": 42}');
      const mapped = arr.map(x => x * 2);
      return JSON.stringify({ arr, k: obj.k, mapped });`;
    const { value } = await runInSandbox(src, api);
    expect(JSON.parse(value as string)).toEqual({ arr: [1, 2, 3], k: 42, mapped: [2, 4, 6] });
  });

  test("TypeScript 类型标注 → 语法错误(纯 JS 约束)", async () => {
    const { api } = makeApi();
    const src = `${META_HEADER}\nconst x: string = 'hi'; return x;`;
    await expect(runInSandbox(src, api)).rejects.toThrow();
  });
});

describe("M0 sandbox — stripStringsAndComments 工具", () => {
  test("剥离行注释/块注释/字符串后保留结构与长度", () => {
    const src = `const a = "hello"; // comment\n/* block */ const b = 1;`;
    const stripped = stripStringsAndComments(src);
    expect(stripped.length).toBe(src.length); // 等长
    expect(stripped).not.toContain("hello");
    expect(stripped).not.toContain("comment");
    expect(stripped).not.toContain("block");
    expect(stripped).toContain("const a =");
    expect(stripped).toContain("const b = 1;");
  });

  test("转义引号不破坏字符串边界", () => {
    const src = `const s = "a\\"b"; const t = 1;`;
    const stripped = stripStringsAndComments(src);
    expect(stripped).toContain("const s =");
    expect(stripped).toContain("const t = 1;");
  });
});
