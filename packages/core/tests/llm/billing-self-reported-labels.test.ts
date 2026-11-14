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

/**
 * 缺陷 16 防复发：llm/ 之外直调 `sendMessageNonStreaming` 的调用点必须走
 * `sendNonStreamingSideCall`（它无条件 recordSideCall + 挂 caller 身份）。
 * 五份手写 `if (resp.usage) recordSideCall` 就是这个门禁要拦的形态。
 */
describe("非流式影子调用必须走 sendNonStreamingSideCall", () => {
  /** 主循环路径：钱经 AfterModelRaw 入账，不是影子调用 */
  const ALLOW = new Set(["packages/core/src/api/stream-handler.ts"]);

  test("llm/ 之外无直调（白名单除外）", () => {
    const files = SRC_ROOTS.flatMap((r) => walk(r));
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of files) {
      const rel = f.replace(/.*\/packages\//, "packages/");
      if (rel.includes("/src/llm/")) continue;
      const src = readFileSync(f, "utf-8");
      // 有 `.sendMessageNonStreaming(` 或 `!(` 的调用，排除 typeof 探测
      const calls = src.match(/\.sendMessageNonStreaming!?\(/g) ?? [];
      if (calls.length === 0) continue;
      scanned++;
      if (!ALLOW.has(rel)) offenders.push(rel);
    }
    // 扫描器自证：白名单那一处必须被扫到，否则正则失效后恒绿
    expect(scanned).toBeGreaterThanOrEqual(1);
    expect(offenders).toEqual([]);
  });

  test("非流式影子调用点的 querySource 都在白名单（消费侧不二次加钱）", () => {
    const files = SRC_ROOTS.flatMap((r) => walk(r));
    let n = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      if (!src.includes("sendNonStreamingSideCall(")) continue;
      if (f.endsWith("side-call-nonstreaming.ts")) continue;
      for (const label of querySources(src)) {
        n++;
        expect(BILLING_SELF_REPORTED_LABELS.has(label)).toBe(true);
      }
    }
    // 扫描器自证下限 = 当前真实调用点数：tool_classifier / bash_classifier /
    // web_fetch_extract / title_generation。原为 5，cache_warmup 随 session/warmup.ts
    // 于 2026-10-22 下线（零调用）后减为 4。
    expect(n).toBeGreaterThanOrEqual(4);
  });
});

/**
 * 缺陷 CP-1 防复发：流式 usage 取数必须走 `collectStreamUsage`。
 *
 * ## 它拦的是什么
 *
 * 坏形态是这个（曾在 7 个辅助调用点各写一遍）：
 *
 * ```ts
 * } else if (event.type === "message_stop" && (event as any).usage) {
 * ```
 *
 * `message_stop` 在 `StreamEvent` 里**没有 usage 字段**，provider 也从不往它上面挂 usage。
 * `as any` 让类型系统彻底失声，于是这 7 条链的成功路径 usage 恒为 null、
 * `recordSideCall` 恒不触发；而它们又都在 `BILLING_SELF_REPORTED_LABELS` 里被豁免了
 * 发生侧计费 —— 两头都不记，钱静默漏了 199 次（轨迹实测）。
 *
 * ## 为什么判据是「同一行同时出现 message_stop 与 .usage」
 *
 * 取数必然把两者写在同一个条件表达式里，跨行写法在本仓不存在（真要跨行，
 * 这个门禁拦不住，但 `collectStreamUsage` 是唯一实现这件事由 review 兜）。
 * 判据读**代码**不读注释：`types.ts` 的 `collectStreamUsage` 文档注释里就引用了
 * 这个坏形态作为反例，不剥注释会把文档自己报出来。
 */

/** 剥掉注释（`//` 行注释、`/* *\/` 块注释），**保留字符串内容与换行**。
 *
 * ⚠️ 必须保留字符串内容：坏形态的 `message_stop` 就在字符串字面量里，
 * 早期版本把引号内字符也替换成空格，于是每处都被当成"没有 message_stop"跳过，
 * 门禁恒绿（2026-11-13 变异自证实测抓到）。字符串里的 `//` 也不该被当注释。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

describe("流式 usage 取数必须走 collectStreamUsage（缺陷 CP-1 防复发）", () => {
  test("src 内不再出现「message_stop 与 .usage 同处一行」的取数写法", () => {
    const files = SRC_ROOTS.flatMap((r) => walk(r));
    // 扫描器自证：根目录解析错了会扫出 0 个文件，然后这个测试恒绿。
    expect(files.length).toBeGreaterThan(300);

    const offenders: string[] = [];
    let scannedFiles = 0;

    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      if (!src.includes("message_stop")) continue;
      scannedFiles += 1;
      const lines = stripComments(src).split("\n");
      for (let i = 0; i < lines.length; i++) {
        const code = lines[i];
        if (!code.includes("message_stop")) continue;
        // 原 bug 形态：同一行既拿 message_stop 当判据，又用 .usage 取数。
        if (!/\.usage\b/.test(code)) continue;
        offenders.push(`${f.replace(/.*\/packages\//, "packages/")}:${i + 1}: ${lines[i].trim()}`);
      }
    }

    // 判据本身要有分母：src 里确实有人处理 message_stop（provider 收尾、mocks），
    // 否则上面的 include 判断一旦失效这个测试就恒绿。
    expect(scannedFiles).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });
});
