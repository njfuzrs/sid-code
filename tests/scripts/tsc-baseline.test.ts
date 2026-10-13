/**
 * tsc 增量门禁自身的正确性 + 变异自证。
 *
 * ## 这道测试存在的理由
 *
 * 门禁有一个比「报错」糟糕得多的失败模式：扫出一个空集，然后全程绿。
 * 本仓已经踩过这个形态（见 `tests/scripts/affected-tests.test.ts` 的「选空集然后全绿」），
 * 而 tsc 棘轮还多一层风险 —— 它的输入是**另一个工具的输出**，格式一变，
 * 解析器就可能默默返回空数组，让整道门禁退化成装饰。
 *
 * 所以下面的用例分两类，两个方向都要锁：
 *
 *   1. **口径**：解析（含缩进续行不能混进消息）、归一化（worktree / CI 路径必须归一成同一个键）；
 *   2. **变异自证**：造一条已知的新错误，必须数到；造一处行号漂移，必须不数它。
 *      只锁一个方向，无法排除「恒返回空集」与「恒把所有错误都当新的」这两种恰好也能通过的实现。
 *
 * 全部用例只调导出的纯函数，**不 spawn tsc**（跑真实 tsc 要十几秒，且结果随环境漂移）。
 */

import { describe, expect, test } from "bun:test";
import {
  countByKey,
  diffAgainstBaseline,
  looksLikeParserFailure,
  normalizeForCompare,
  parseTscOutput,
  type Baseline,
  type TscError,
} from "../../scripts/tsc-baseline.ts";

const ROOT = "/repo";

/** 解析单行错误，顺带断言「单行恰好解析出一条」——否则是测试自己写错了样例。 */
function one(line: string): TscError {
  const errors = parseTscOutput(line, ROOT);
  expect(errors).toHaveLength(1);
  return errors[0];
}

function makeBaseline(errors: TscError[]): Baseline {
  return {
    tscVersion: "5.9.3",
    total: errors.length,
    note: "测试用基线",
    errors: countByKey(errors),
  };
}

describe("parseTscOutput 口径", () => {
  test("解析出全部错误行，缩进续行与汇总行都不混进消息", () => {
    const text = [
      "src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  The expected type comes from property 'x' which is declared here on type 'Y'.",
      "src/b.ts(30,4): error TS2339: Property 'failed' does not exist on type 'Result'.",
      "src/c.ts(5,6): error TS7006: Parameter 'e' implicitly has an 'any' type.",
      "Found 3 errors in 3 files.",
    ].join("\n");
    const errors = parseTscOutput(text, ROOT);

    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.code)).toEqual(["TS2322", "TS2339", "TS7006"]);
    // 续行若被拼进消息，这条全等断言会立刻失败
    expect(errors[0].message).toBe("Type 'string' is not assignable to type 'number'.");
    expect(errors[1].file).toBe("src/b.ts");
    expect(errors[1].line).toBe(30);
    expect(errors[1].column).toBe(4);
  });

  test("身份键 = 文件|错误码|消息，且不含行号列号", () => {
    const e = one("src/a.ts(1,2): error TS2322: boom");
    expect(e.key).toBe("src/a.ts|TS2322|boom");
    expect(e.key).not.toContain("(1,2)");
  });

  test("空文本解析出空集（调用方靠退出码把它与「真故障」区分开）", () => {
    expect(parseTscOutput("", ROOT)).toEqual([]);
  });
});

describe("归一化口径", () => {
  test("仓库根绝对路径替换成 <root>", () => {
    expect(normalizeForCompare("/Users/me/sid-code/src/foo.ts", "/Users/me/sid-code")).toBe(
      "<root>/src/foo.ts",
    );
  });

  test("Windows 反斜杠统一成 /", () => {
    expect(normalizeForCompare("C:\\repo\\src\\a.ts", "C:\\repo")).toBe("<root>/src/a.ts");
  });

  test("worktree 归一化：node_modules 前缀不同，键必须相同", () => {
    // 这条对应真实差异：消息里的 node_modules 绝对路径在 worktree（`.bun` 住在仓库
    // node_modules 下）与 CI（`/home/runner/...`）上完全不同。不归一化，同一份代码
    // 在两台机器上产出的键就不一样，CI 必红。
    const line = (nm: string) =>
      `packages/tui/src/ink.tsx(5,24): error TS7016: Could not find a declaration file for module 'signal-exit'. '${nm}/.bun/signal-exit@3.0.7/node_modules/signal-exit/index.js' implicitly has an 'any' type.`;
    const a = parseTscOutput(line("/A/sid-code/node_modules"), "/A/sid-code")[0];
    const b = parseTscOutput(line("/B/sid-code-wt-x/node_modules"), "/B/sid-code-wt-x")[0];

    expect(a.key).toBe(b.key);
    expect(a.message).toContain("<nm>/<nm>/signal-exit/index.js");
  });
});

describe("diffAgainstBaseline 判定", () => {
  test("行号漂移不触发门禁（这正是身份键不含行列号的理由）", () => {
    const base = makeBaseline([one("src/a.ts(1,2): error TS1000: boom")]);
    const diff = diffAgainstBaseline([one("src/a.ts(999,88): error TS1000: boom")], base);

    expect(diff.added).toEqual([]);
    expect(diff.tightened).toEqual([]);
  });

  test("变异自证：新增一条错误必须被数到（排除「恒返回空集」实现）", () => {
    const base = makeBaseline([one("src/a.ts(1,2): error TS1000: boom")]);
    const cur = [
      one("src/a.ts(1,2): error TS1000: boom"),
      one("src/new.ts(9,9): error TS9999: 新错误"),
    ];
    const diff = diffAgainstBaseline(cur, base);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].error.file).toBe("src/new.ts");
    expect(diff.added[0].baselineCount).toBe(0);
  });

  test("变异自证：同一错误出现两次必须报新增（证明比较的是计数而不是集合）", () => {
    const base = makeBaseline([one("src/a.ts(1,2): error TS1000: boom")]);
    const cur = [
      one("src/a.ts(1,2): error TS1000: boom"),
      one("src/a.ts(7,7): error TS1000: boom"),
    ];
    const diff = diffAgainstBaseline(cur, base);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].currentCount).toBe(2);
    expect(diff.added[0].baselineCount).toBe(1);
  });

  test("减少一处错误：无新增，且可收紧（棘轮允许往下走）", () => {
    const base = makeBaseline([
      one("src/a.ts(1,2): error TS1000: a"),
      one("src/b.ts(1,2): error TS2000: b"),
    ]);
    const diff = diffAgainstBaseline([one("src/a.ts(1,2): error TS1000: a")], base);

    expect(diff.added).toEqual([]);
    expect(diff.tightened).toEqual(["src/b.ts|TS2000|b"]);
  });

  test("--update-baseline 拒绝放宽：出现基线中没有的键（main 以 added 非空为判据）", () => {
    const base = makeBaseline([one("src/a.ts(1,2): error TS1000: a")]);
    const diff = diffAgainstBaseline(
      [one("src/a.ts(1,2): error TS1000: a"), one("src/b.ts(1,2): error TS2000: b")],
      base,
    );

    expect(diff.added.length).toBeGreaterThan(0);
  });
});

describe("空解析保护（本仓反复踩过的「零命中被当成通过」）", () => {
  test("解析 0 条 + 退出码非 0 → 判为脚本故障，不能判为通过", () => {
    expect(looksLikeParserFailure(0, 1)).toBe(true);
    expect(looksLikeParserFailure(0, 2)).toBe(true);
  });

  test("解析 0 条 + 退出码 0 → 是合法状态（真的没有类型错误）", () => {
    expect(looksLikeParserFailure(0, 0)).toBe(false);
  });

  test("解析到错误时无论退出码都不算故障", () => {
    expect(looksLikeParserFailure(5, 1)).toBe(false);
    expect(looksLikeParserFailure(5, 2)).toBe(false);
  });
});
