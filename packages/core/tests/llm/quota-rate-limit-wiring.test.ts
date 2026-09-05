/**
 * QuotaManager 速率限制接线检查（F5，2026-09-03 排查）
 *
 * ## 这个文件为什么单独存在
 *
 * `quota.test.ts` 里有 7 条断言证明 `checkRateLimit()` 的**逻辑正确**，全绿。
 * 但排查发现它的**生产调用点 = 0** —— 每轮往滑动窗口里 `recordRequest` 写数据，
 * 从来没人问「超了吗」。这是「仅被测试消费」这一档的典型形态：
 * 函数对，测试对，就是没接线，而用户以为配了 RPM/TPM 就有保护。
 *
 * 单测证明不了「它被接线了吗」，所以这里做**形态断言**：直接读生产源码，
 * 断言调用点存在。与 `gateway-request-id.test.ts` 的 PR8 段同一范式。
 *
 * 这类测试的价值不在首次修复（首次修复靠行为测试），而在**防回退**：
 * 将来有人重构主循环、顺手把这段删掉时，这里会红。
 *
 * ⚠️ 断言一律用 `.includes()` 转成 boolean 再比，**不要**对整份源码用 `toContain`
 * —— 后者失败时会把整个文件（数百 KB）打进输出。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QuotaManager } from "@sid-code/core/llm/quota.ts";

const coreSrc = (p: string) => readFileSync(join(import.meta.dir, "../../src", p), "utf8");
const cliSrc = (p: string) => readFileSync(join(import.meta.dir, "../../../cli/src", p), "utf8");

describe("F5①：checkRateLimit 必须有生产调用点", () => {
  test("loop.ts 在发请求前查速率限制（变异自证：修复前必失败）", () => {
    expect(coreSrc("query/loop.ts").includes("checkRateLimit()")).toBe(true);
  });

  test("等待必须走可被 abort 打断的 sleep，不能是裸 setTimeout", () => {
    // 20260707 的坑：abort 叫不醒阻塞层，ESC 后仍空等。
    // sleepUnlessAborted 的语义是「睡满 or abort 立即 resolve」，正是这里需要的。
    const src = coreSrc("query/loop.ts");
    const idx = src.indexOf("checkRateLimit()");
    expect(idx).toBeGreaterThan(0);
    // 取调用点附近一小段，确认等待用的是可中断实现
    const near = src.slice(idx, idx + 1500);
    expect(near.includes("sleepUnlessAborted")).toBe(true);
  });
});

describe("F5②：只配 RPM/TPM 不配 costLimit 时也要创建 QuotaManager", () => {
  // 原实现 `if (effectiveCostLimit && effectiveCostLimit > 0)` 才 new，
  // 于是只想配速率限制的用户压根拿不到 QuotaManager —— 配置静默失效、无任何警告。
  test("app.ts 的实例化条件覆盖三者任一（变异自证）", () => {
    const src = cliSrc("app.ts");
    const idx = src.indexOf("hasAnyQuota");
    expect(idx).toBeGreaterThan(0);
    const decl = src.slice(idx, idx + 500);
    expect(decl.includes("requestsPerMinute")).toBe(true);
    expect(decl.includes("tokensPerMinute")).toBe(true);
  });

  test("costLimit=0 且只配 RPM 时，QuotaManager 仍能正常限流", () => {
    // 行为侧对照：证明「不配 costLimit」这个组合本身是可用的，
    // 不是因为 QuotaManager 依赖 costLimit 才必须配它。
    const qm = new QuotaManager({ requestsPerMinute: 2 });
    qm.recordRequest(10);
    qm.recordRequest(10);
    expect(qm.checkRateLimit()).toBeGreaterThan(0);
    // 未配 costLimit → 成本告警自然不触发，两者互不依赖
    expect(qm.check(999)).toBeNull();
  });
});

describe("F5③：配了但机制未生效时必须告警，不得静默", () => {
  test("app.ts 对「配了 RPM/TPM 却没有 QuotaManager」有显式告警路径", () => {
    // 这条比 ①② 更重要：它防的是同类缺陷再次静默存在。
    expect(cliSrc("app.ts").includes("QUOTA_RATE_LIMIT_INERT")).toBe(true);
  });
});
