/**
 * `jitContext` 默认值单一事实源门禁（B3）
 *
 * 背景：`Config.jitContext` 是 `optional boolean`，「未设置=开启」这个事实
 * 无法由类型系统承载。落地前全仓 3 个消费点各自写 `=== false` 维持它，
 * 也就是说**默认值只存在于调用点的写法里**。新增第 4 个消费点写成
 * `if (config.jitContext)` 就静默把默认反转成 false —— 而且**测试测不出来**，
 * 因为它只在「用户没配」这条最常见的路径上反转：配了 `true` 的用户看不到差别，
 * 没配的用户静默失去整套 JIT 机制。
 *
 * 所以这里有两道断言：
 *  1. 行为契约：`isJitContextEnabled` 对三种输入（未设 / true / false）都正确。
 *  2. 静态扫描（核心）：`src/` 下不得出现裸比较。改回 `=== false` 会在 CI 变红。
 *
 * 形状同 `tests/telemetry/no-real-path-writes.test.ts` —— **靠纪律维持的约定必然漏网，
 * 得让违反在 CI 上变红。**
 *
 * ⚠ 刻意用 `Bun.file().text()` 而非 spawn `grep`：`src/app.ts` 含 NUL 字节，
 * shell `grep` 会把它当二进制文件而**静默跳过**（返回 "Binary file matches" 或直接不输出），
 * 于是门禁在最该守的那个文件上恰好失效。Bun API 读没有这个问题。
 */

import { describe, test, expect } from "bun:test";
import {
  JIT_CONTEXT_DEFAULT,
  isJitContextEnabled,
} from "@sid-code/core/config/jit-context.ts";

/** 实现自身豁免 —— 常量与判定函数就住在这里 */
const IMPLEMENTATION_FILE = "src/config/jit-context.ts";

describe("jitContext 默认值单一事实源", () => {
  test("默认值是开启", () => {
    expect(JIT_CONTEXT_DEFAULT).toBe(true);
  });

  test("isJitContextEnabled 三种输入都正确", () => {
    // 未设置 → 取默认（这条是整个 B3 的核心：optional 的语义不能靠各点自己记）
    expect(isJitContextEnabled({})).toBe(true);
    expect(isJitContextEnabled({ jitContext: undefined })).toBe(true);
    // 显式配置照采纳
    expect(isJitContextEnabled({ jitContext: true })).toBe(true);
    expect(isJitContextEnabled({ jitContext: false })).toBe(false);
  });

  test("生产源码下不得裸比较 config.jitContext（新增消费点必须走 isJitContextEnabled）", async () => {
    // P2-2 分包：生产源码在 packages/*/src/ 下（4 个包），不再是单一 src/。
    // 漏包 = 门禁少扫一片；下面的 files.length 断言就是防这种空转的
    // （分包时它真的红了：src/ 搬空后只扫到 1 个文件）。
    const files = await Array.fromAsync(
      new Bun.Glob("packages/{shared,tui-renderer,core,cli}/src/**/*.{ts,tsx}").scan("."),
    );
    // 门禁自身的有效性前提：真的扫到了文件。Glob 失效时应该红，不该静默通过。
    expect(files.length).toBeGreaterThan(100);

    const violations: string[] = [];
    for (const f of files) {
      const normalized = f.replaceAll("\\", "/");
      if (normalized.endsWith(IMPLEMENTATION_FILE)) continue;
      const src = await Bun.file(f).text();
      if (!src.includes("jitContext")) continue;
      src.split("\n").forEach((line, i) => {
        // 禁止 `=== false` / `!== false` / `!== true` 这类裸比较
        if (/\.jitContext\s*[!=]==/.test(line)) {
          violations.push(`${normalized}:${i + 1}  ${line.trim()}`);
        }
        // 禁止真值判断 —— 它会把「未设置」误判为关闭
        if (/if\s*\([^)]*\.jitContext\s*\)/.test(line)) {
          violations.push(`${normalized}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  test("门禁本身能抓到违规写法（防止正则写歪导致永远通过）", () => {
    // 这四行是真实可能被写出来的形态。若正则失效，门禁会变成一个永绿的装饰。
    const bad = [
      "if (this.config.jitContext === false) return;",
      "const x = cfg.jitContext !== false ? a : b;",
      "if (opts.jitContext !== true) skip();",
      "if (config.jitContext) enable();",
    ];
    for (const line of bad) {
      const hit =
        /\.jitContext\s*[!=]==/.test(line) ||
        /if\s*\([^)]*\.jitContext\s*\)/.test(line);
      expect(hit).toBe(true);
    }
    // 合规写法不得被误判
    for (const line of [
      "if (!isJitContextEnabled(this.config)) return;",
      "return config.jitContext ?? JIT_CONTEXT_DEFAULT;",
    ]) {
      const hit =
        /\.jitContext\s*[!=]==/.test(line) ||
        /if\s*\([^)]*\.jitContext\s*\)/.test(line);
      expect(hit).toBe(false);
    }
  });
});
