/**
 * 上游 ink@7.1.1 声明 `engines.node >=22`，而 sid-code 跑在 Bun 上（B9 / T1.2）。
 *
 * 这里只核对上游源码**实际用到的** Node API 在 Bun 下存在且语义符合预期（清单由 grep `packages/tui/src` 得来），
 * 不追求覆盖 Node 22 全集。新底座以后用到新的 Node API，就补进这张表。
 */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import tty from "node:tty";

describe("上游 ink 用到的 Node API 在 Bun 下可用", () => {
  test("语言 / 全局 API", () => {
    expect(typeof [].findLast).toBe("function");
    expect(typeof queueMicrotask).toBe("function");
  });

  test("import.meta.resolve 对未安装的包会抛（reconciler.ts 的 devtools 探测依赖这个语义）", () => {
    expect(typeof import.meta.resolve).toBe("function");
    expect(() => import.meta.resolve("definitely-not-installed-pkg-b9-t12")).toThrow();
  });

  test("tty / stream / timer", () => {
    expect(typeof (tty.ReadStream.prototype as { setRawMode?: unknown }).setRawMode).toBe(
      "function",
    );
    expect(typeof (tty.WriteStream.prototype as { getWindowSize?: unknown }).getWindowSize).toBe(
      "function",
    );
    const t = setTimeout(() => {}, 1);
    expect(typeof t.ref).toBe("function");
    expect(typeof t.unref).toBe("function");
    clearTimeout(t);
    // App.tsx 只在 raw mode（stdin 是 TTY）路径上调 stdin.ref()/unref()，所以查 tty.ReadStream 原型。
    // ⚠️ 不要改成查 process.stdin：stdin 重定向到 /dev/null 时（全量 bun test 就是这样），
    // Bun 和 Node 下 process.stdin.ref 都是 undefined。实测这样写，单跑绿、全量红。
    const rs = tty.ReadStream.prototype as { ref?: unknown; unref?: unknown };
    expect(typeof rs.ref).toBe("function");
    expect(typeof rs.unref).toBe("function");
    expect(typeof new PassThrough().write).toBe("function");
  });
});
