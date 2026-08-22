/**
 * 防漂移门禁：「既自报成本、又走漏斗」的调用链必须在白名单里（PR3 / 方案 §5.2.2 ①）
 *
 * ## 它拦的是什么
 *
 * 计费收口到发生侧之后，同一次 fetch 可能被记两次成本：
 *   ① 调用链自己的 `recordSideCall(...)`（老路）
 *   ② provider 发生侧事件 → 消费侧 `recordSideCall`（新路）
 *
 * 判据在 `llm/billing-sink.ts` 的 `BILLING_SELF_REPORTED_LABELS`。它是一张**手写表**，
 * 而手写表必然漂移 —— 所以这里按源码静态扫出「既 import recordSideCall
 * 又 import streamWithResilience」的文件，逐个核对它的 querySource 在表里。
 *
 * ⚠️ 为什么必须是静态扫描而不是列一份期望文件名清单：手写清单与手写表同病，
 * 两份手写的东西对齐只能证明它们互相抄对了，证明不了它们与代码一致
 * （本仓「手写哨兵数组必漂移」的教训）。
 *
 * ## 漏加一个标签会怎样（方向是安全的，但仍必须拦）
 *
 * 漏加 → 那条链的钱被记两次 → 我们的账本**高于**真实账单。
 * 这个方向可发现（`scripts/pricing-reconcile.ts` 会显示正偏差），
 * 但"成本数字终于上来了"极易被误读成"漏采修好了"，所以要在 CI 拦住。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BILLING_SELF_REPORTED_LABELS } from "@sid-code/core/llm/billing-sink.ts";

const SRC_ROOTS = [
  join(import.meta.dir, "../../src"), // packages/core/src
  join(import.meta.dir, "../../../cli/src"), // packages/cli/src
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      // vendor / 内置 skill 脚本不是调用链源码
      if (name === "_vendor" || name === "node_modules") continue;
      walk(p, out);
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/** 从一个文件里抽出所有 `querySource: "xxx"` 的字面值 */
function querySources(src: string): string[] {
  return [...src.matchAll(/querySource:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("双记防线：自报成本且走漏斗的链必须在白名单里", () => {
  test("静态扫描出的每条链，其 querySource 都在 BILLING_SELF_REPORTED_LABELS 中", () => {
    const files = SRC_ROOTS.flatMap((r) => walk(r));
    // 扫描器自证：根目录若解析错了会扫出 0 个文件，然后这个测试恒绿。
    expect(files.length).toBeGreaterThan(300);

    const offenders: Array<{ file: string; label: string }> = [];
    let selfReportingFunnelChains = 0;

    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      // 只看**自己调**的那些：`billing-sink.ts` 的定义、`app.ts` 里由发生侧事件
      // 触发的那一处消费侧调用都不算「链自报」。
      if (!src.includes("recordSideCall(")) continue;
      if (!src.includes("streamWithResilience")) continue;
      // app.ts 是消费侧本身（它的 recordSideCall 就是新路），不是被双记的链。
      if (f.endsWith("/app.ts")) continue;

      const labels = querySources(src);
      if (labels.length === 0) continue;
      selfReportingFunnelChains += 1;

      for (const label of labels) {
        if (!BILLING_SELF_REPORTED_LABELS.has(label)) {
          offenders.push({ file: f.replace(/.*\/packages\//, "packages/"), label });
        }
      }
    }

    // 判据本身要有分母：扫到 0 条链时上面的循环体从不执行，offenders 恒空。
    // 实测当日为 6 条（recall / auto-compact / context-collapse / partial-compact /
    // hook-runner / goal-evaluator），取 ≥4 作下界以免正常重构就红。
    expect(selfReportingFunnelChains).toBeGreaterThanOrEqual(4);

    expect(offenders).toEqual([]);
  });

  test("白名单里的标签都还有对应的源码（反向防漂移：删了链要删标签）", () => {
    const files = SRC_ROOTS.flatMap((r) => walk(r));
    const allLabels = new Set(files.flatMap((f) => querySources(readFileSync(f, "utf-8"))));
    for (const label of BILLING_SELF_REPORTED_LABELS) {
      expect(allLabels.has(label)).toBe(true);
    }
  });

  test("shouldChargeBilledRequest：主循环不加钱、白名单不加钱、其余加钱", async () => {
    const { shouldChargeBilledRequest } = await import("@sid-code/core/llm/billing-sink.ts");
    const base = {
      fetchId: "f1",
      model: "m",
      provider: "openai",
      usage: { inputTokens: 1, outputTokens: 1 },
      index: 0,
    };

    // 主循环：已由 updateUsage 入账
    expect(shouldChargeBilledRequest({ ...base, accounted: true })).toBe(false);
    // 自报链：会被记两次，必须跳过
    expect(
      shouldChargeBilledRequest({ ...base, accounted: false, callerLabel: "memory_recall" }),
    ).toBe(false);
    expect(shouldChargeBilledRequest({ ...base, accounted: false, callerLabel: "compact" })).toBe(
      false,
    );
    // fork：没人替它记账，这一条正是本次事故漏掉的 22 次
    expect(
      shouldChargeBilledRequest({
        ...base,
        accounted: false,
        callerLabel: "session-memory-update",
        agentId: "fork:session-memory-update",
      }),
    ).toBe(true);
    // 无标签无身份但 accounted=false（理论上不该出现）：宁可记上，漏记是静默错
    expect(shouldChargeBilledRequest({ ...base, accounted: false })).toBe(true);
  });
});
