/**
 * ci-retry-report 的测试 —— 输入**全部是造的 bun 输出样本**
 *
 * 造数据的理由与 ci-flake-stats 同源：`--retry=1` 救回一条 flake 是不可控事件，
 * 等真实样本等于把结论押在不会按时发生的事上。这里覆盖的是解析层的全部分支：
 * 转绿 / 终败 / 无 attempt 标记 / ANSI 带色 / 用例名里含 "(attempt" 字面量。
 *
 * ⚠️ 样本的形态是从**真实 bun 输出**抄来的（2026-11-15 实测 bun 1.4.2）：
 *   `(pass) flaky: 第一次失败第二次通过 (attempt 2)`
 *   `(fail) always fail (attempt 2)`
 * 不是手搓一个"看起来像"的格式 —— 判据格式对不上时，测试会全绿而脚本在 CI 里静默失效。
 */

import { describe, expect, test } from "bun:test";
import { formatReport, parseRetryLines } from "../../scripts/ci-retry-report.ts";

describe("parseRetryLines：只认行首结论 + (attempt N≥2)", () => {
  test("转绿与终败两种结论都能识别，并区分 outcome", () => {
    // 这两行是 bun 的真实输出形态（见文件头注释）。
    const log = [
      "(pass) flaky: 第一次失败第二次通过 (attempt 2) [0.24ms]",
      "(fail) always fail (attempt 2) [0.03ms]",
    ].join("\n");
    expect(parseRetryLines(log)).toEqual([
      { name: "flaky: 第一次失败第二次通过", outcome: "pass", attempt: 2 },
      { name: "always fail", outcome: "fail", attempt: 2 },
    ]);
  });

  test("首次即通过的用例不带 attempt，不计入重试", () => {
    expect(parseRetryLines("(pass) stable pass [0.01ms]")).toEqual([]);
  });

  // bun 经 tee 落盘时**仍会带颜色**（bun 判断的是自己 stdout 是否 TTY，管道场景不总关色）。
  // 不剥 ANSI 的话带色行用肉眼看着正常，`^\(` 却匹配不上 —— 报告会静默漏报。
  test("剥掉 ANSI 颜色后仍能识别（带色日志不漏报）", () => {
    const colored = "\u001b[32m(pass) 带色的重试用例 (attempt 3) [1.00ms]\u001b[0m";
    expect(parseRetryLines(colored)).toEqual([
      { name: "带色的重试用例", outcome: "pass", attempt: 3 },
    ]);
  });

  // 这条防的是「用例正文里恰好写了 (attempt 2)」被当成标记位。
  // 判据要求行首就是 `(pass)` / `(fail)`，所以正文里的字面量不会误判。
  test("用例名里含 (attempt 2) 字面量不会误判（行首才是标记位）", () => {
    expect(parseRetryLines("(pass) 解析 (attempt 2) 这个字符串 [0.01ms]")).toEqual([]);
  });

  test("attempt 小于 2 的异常行被过滤（N=1 不是重试）", () => {
    expect(parseRetryLines("(pass) 奇怪的行 (attempt 1) [0.01ms]")).toEqual([]);
  });

  test("错误栈、快照等其它文本不参与匹配", () => {
    const log = [
      "error: expect(received).toBe(expected)",
      "Expected: > 1",
      "Received: 1",
      "      at <anonymous> (/private/tmp/x.test.ts:6:20)",
    ].join("\n");
    expect(parseRetryLines(log)).toEqual([]);
  });

  test("空日志返回空数组（测试步骤因超时没产出任何行也不能炸）", () => {
    expect(parseRetryLines("")).toEqual([]);
  });
});

describe("formatReport：给人看的报告", () => {
  test("零重试时给出明确的「无」而不是空白（否则会被读成脚本没跑）", () => {
    const text = formatReport([]);
    expect(text).toContain("本轮无重试用例");
  });

  test("有重试时分两档计数，并把每条用例列成表", () => {
    const text = formatReport([
      { name: "被救回来的", outcome: "pass", attempt: 2 },
      { name: "没救回来的", outcome: "fail", attempt: 2 },
    ]);
    expect(text).toContain("本轮有 2 条用例被重试");
    expect(text).toContain("重试后通过：1 条");
    expect(text).toContain("重试后仍失败：1 条");
    expect(text).toContain("| 被救回来的 | pass | 2 |");
    expect(text).toContain("| 没救回来的 | fail | 2 |");
  });

  // 用例名里出现竖线会破坏 markdown 表格列，必须转义 —— 否则 CI 上看到的是错位的表。
  test("用例名里的竖线被转义，不破坏表格列", () => {
    const text = formatReport([{ name: "a|b 用例", outcome: "pass", attempt: 2 }]);
    expect(text).toContain("a\\|b 用例");
    // 未转义的裸竖线只应出现在表格分隔里
    expect(text.split("\n").filter((l) => l.startsWith("| a|b"))).toEqual([]);
  });
});
