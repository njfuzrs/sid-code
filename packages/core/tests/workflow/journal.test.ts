/**
 * Dynamic Workflows M5 — resume journal 单测
 *
 * 固化:
 *  - 同脚本同 args → 100% 命中(全部 agent 走缓存)
 *  - 改了第 N 个 agent → 前 N-1 命中、第 N 起重跑(指纹失效)
 *  - append-only:崩溃中断后回放能重建缓存
 *  - 指纹只认影响结果的字段(label/phase 变化不破坏缓存)
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Journal, computeFingerprint } from "@sid-code/core/workflow/journal.ts";
import { WorkflowRuntime, type AgentRunner } from "@sid-code/core/workflow/runtime.ts";
import { runInSandbox } from "@sid-code/core/workflow/sandbox.ts";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDirs: string[] = [];
function freshJournalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-journal-"));
  tmpDirs.push(dir);
  return join(dir, "journal.jsonl");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("M5 journal — 指纹", () => {
  test("相同 (prompt, opts) → 相同指纹", () => {
    const a = computeFingerprint("查 bug", { model: "opus" });
    const b = computeFingerprint("查 bug", { model: "opus" });
    expect(a).toBe(b);
  });

  test("prompt 变 → 指纹变", () => {
    expect(computeFingerprint("a", undefined)).not.toBe(computeFingerprint("b", undefined));
  });

  test("label/phase 变化不影响指纹(只展示用)", () => {
    const a = computeFingerprint("x", { label: "L1", phase: "Scan" });
    const b = computeFingerprint("x", { label: "L2", phase: "Verify" });
    expect(a).toBe(b);
  });

  test("model/schema 变 → 指纹变(影响结果)", () => {
    expect(computeFingerprint("x", { model: "opus" })).not.toBe(
      computeFingerprint("x", { model: "haiku" }),
    );
    expect(computeFingerprint("x", { schema: { type: "object" } })).not.toBe(
      computeFingerprint("x", { schema: { type: "string" } }),
    );
  });

  test("schema 键顺序不同但内容相同 → 指纹相同(稳定序列化)", () => {
    const a = computeFingerprint("x", { schema: { type: "object", title: "T" } });
    const b = computeFingerprint("x", { schema: { title: "T", type: "object" } });
    expect(a).toBe(b);
  });
});

describe("M5 journal — lookup/record/load", () => {
  test("record 后 lookup 命中(指纹一致)", () => {
    const j = new Journal(freshJournalPath());
    const fp = computeFingerprint("p", undefined);
    expect(j.lookup(0, fp)).toBe(null); // 未记录
    j.record({ callIndex: 0, fingerprint: fp, result: "R0" });
    expect(j.lookup(0, fp)).toEqual({ result: "R0" });
  });

  test("指纹不一致 → 不命中(脚本改过)", () => {
    const j = new Journal(freshJournalPath());
    j.record({ callIndex: 0, fingerprint: "OLD", result: "R0" });
    expect(j.lookup(0, "NEW")).toBe(null);
  });

  test("load 回放磁盘记录重建缓存", () => {
    const path = freshJournalPath();
    const j1 = new Journal(path);
    j1.record({ callIndex: 0, fingerprint: "fp0", result: { a: 1 } });
    j1.record({ callIndex: 1, fingerprint: "fp1", result: "R1" });
    // 新实例回放
    const j2 = new Journal(path);
    j2.load();
    expect(j2.size).toBe(2);
    expect(j2.lookup(0, "fp0")).toEqual({ result: { a: 1 } });
    expect(j2.lookup(1, "fp1")).toEqual({ result: "R1" });
  });

  test("append-only:文件确实在追加", () => {
    const path = freshJournalPath();
    const j = new Journal(path);
    j.record({ callIndex: 0, fingerprint: "f0", result: 1 });
    j.record({ callIndex: 1, fingerprint: "f1", result: 2 });
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  test("无 path → 纯内存 no-op(不写盘但内存缓存仍工作)", () => {
    const j = new Journal(null);
    j.record({ callIndex: 0, fingerprint: "f", result: "mem" });
    expect(j.lookup(0, "f")).toEqual({ result: "mem" });
  });
});

describe("M5 journal — 与 runtime 集成(resume 端到端)", () => {
  /** 计数 runner:记录真跑了哪些 prompt */
  function countingRunner(realRuns: string[]): AgentRunner {
    return {
      run: async (prompt: string) => {
        realRuns.push(prompt);
        return `R:${prompt}`;
      },
    };
  }

  const SCRIPT = `export const meta = { name: 'resume-test', description: 'd' }
    const a = await agent('step-A');
    const b = await agent('step-B');
    const c = await agent('step-C');
    return [a, b, c];`;

  test("首次跑:全部真跑 + 写 journal", async () => {
    const path = freshJournalPath();
    const realRuns: string[] = [];
    const journal = new Journal(path);
    journal.load();
    const rt = new WorkflowRuntime({ runner: countingRunner(realRuns), journal });
    const { value } = await runInSandbox(SCRIPT, rt.buildApi());
    expect(value).toEqual(["R:step-A", "R:step-B", "R:step-C"]);
    expect(realRuns).toEqual(["step-A", "step-B", "step-C"]); // 三个都真跑
    expect(journal.size).toBe(3);
  });

  test("【关键】同脚本同 args 重跑 → 100% 命中,零真跑", async () => {
    const path = freshJournalPath();
    // 第一次:建立 journal
    const firstRuns: string[] = [];
    const j1 = new Journal(path);
    j1.load();
    const rt1 = new WorkflowRuntime({ runner: countingRunner(firstRuns), journal: j1 });
    await runInSandbox(SCRIPT, rt1.buildApi());
    expect(firstRuns.length).toBe(3);

    // 第二次:新 journal 实例,load 回放,重跑同脚本
    const secondRuns: string[] = [];
    const j2 = new Journal(path);
    j2.load();
    const rt2 = new WorkflowRuntime({ runner: countingRunner(secondRuns), journal: j2 });
    const { value } = await runInSandbox(SCRIPT, rt2.buildApi());
    expect(value).toEqual(["R:step-A", "R:step-B", "R:step-C"]); // 结果一致
    expect(secondRuns).toEqual([]); // 零真跑(全命中)
  });

  test("【关键】改了第 2 个 agent → 前 1 命中,第 2 起重跑", async () => {
    const path = freshJournalPath();
    // 第一次:原脚本
    const j1 = new Journal(path);
    j1.load();
    await runInSandbox(
      SCRIPT,
      new WorkflowRuntime({ runner: countingRunner([]), journal: j1 }).buildApi(),
    );

    // 第二次:把 step-B 改成 step-B2(step-A 不变,step-C 不变但序号在 B 之后)
    const EDITED = `export const meta = { name: 'resume-test', description: 'd' }
      const a = await agent('step-A');
      const b = await agent('step-B2');
      const c = await agent('step-C');
      return [a, b, c];`;
    const secondRuns: string[] = [];
    const j2 = new Journal(path);
    j2.load();
    const rt2 = new WorkflowRuntime({ runner: countingRunner(secondRuns), journal: j2 });
    const { value } = await runInSandbox(EDITED, rt2.buildApi());
    // step-A(callIndex 0)命中缓存;step-B2(callIndex 1)指纹变→真跑;
    // step-C(callIndex 2)指纹未变但... 注:序号 2 的指纹仍是 step-C,命中缓存
    expect(secondRuns).toContain("step-B2"); // 改动的真跑了
    expect(secondRuns).not.toContain("step-A"); // 前面的命中
    expect(value).toEqual(["R:step-A", "R:step-B2", "R:step-C"]);
  });
});
