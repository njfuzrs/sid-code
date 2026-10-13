/**
 * bootstrap/cwd-context 最小行为保护。
 *
 * 这个目录之前没有测试，改它时 affected-tests 会回退整包。
 * 补上这几个用例后，改 bootstrap/ 时选测能精确命中本目录。
 *
 * AsyncLocalStorage 的语义是「跨 await 同一异步链共享 store」，
 * 所以验证点放在「作用域内外取值不同」和「作用域结束后恢复」。
 */
import { describe, expect, test } from "bun:test";
import {
  getAgentCwd,
  getAgentRoot,
  setAgentCwd,
  withAgentCwd,
} from "../../src/bootstrap/cwd-context.ts";

describe("bootstrap/cwd-context", () => {
  test("不在任何 withAgentCwd 内时 getAgentCwd 返回 undefined", () => {
    expect(getAgentCwd()).toBeUndefined();
  });

  test("withAgentCwd 内能取到绑定的目录，退出后恢复 undefined", () => {
    const inside = withAgentCwd("/tmp/fake-agent-cwd", () => {
      return getAgentCwd();
    });
    expect(inside).toBe("/tmp/fake-agent-cwd");
    // 作用域结束后，外层不应受影响
    expect(getAgentCwd()).toBeUndefined();
  });

  test("getAgentRoot 在作用域内返回进入时绑定的根目录", () => {
    const root = withAgentCwd("/tmp/fake-root", () => {
      return getAgentRoot();
    });
    expect(root).toBe("/tmp/fake-root");
  });

  test("setAgentCwd 在作用域内改写 cwd，但不改 root", () => {
    const { cwdAfter, rootAfter } = withAgentCwd("/tmp/fake-root", () => {
      const ok = setAgentCwd("/tmp/fake-sub-dir");
      return {
        ok,
        cwdAfter: getAgentCwd(),
        rootAfter: getAgentRoot(),
      };
    });
    expect(cwdAfter).toBe("/tmp/fake-sub-dir");
    // root 不随 cd 变化，记的是进入时绑定的隔离边界
    expect(rootAfter).toBe("/tmp/fake-root");
  });

  test("setAgentCwd 在不在作用域内时返回 false（不改全局 state）", () => {
    // 不在任何 withAgentCwd 内 → 返回 false，调用方不应再去碰全局 state.cwd
    expect(setAgentCwd("/tmp/should-not-take-effect")).toBe(false);
    expect(getAgentCwd()).toBeUndefined();
  });

  test("作用域内外不串台：嵌套 withAgentCwd 各自独立", () => {
    // 外层绑 /tmp/outer，内层绑 /tmp/inner，退出内层后应回到外层
    const result = withAgentCwd("/tmp/outer", () => {
      const outerCwd = getAgentCwd();
      const innerCwd = withAgentCwd("/tmp/inner", () => {
        return getAgentCwd();
      });
      const afterInner = getAgentCwd();
      return { outerCwd, innerCwd, afterInner };
    });
    expect(result.outerCwd).toBe("/tmp/outer");
    expect(result.innerCwd).toBe("/tmp/inner");
    expect(result.afterInner).toBe("/tmp/outer");
  });
});
