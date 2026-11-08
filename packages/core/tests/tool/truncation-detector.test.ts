/**
 * 内容截断检测器 — 单元测试
 *
 * 覆盖 detectTruncation 的两大策略：
 * 1. 括号平衡检测（≥3 层不平衡视为截断）
 * 2. 末尾突然中断检测（未闭合标签/字符串）
 *
 * 设计原则：宁可漏报不误杀——正常代码不应触发。
 */

import { describe, it, expect } from "bun:test";
import { detectTruncation } from "@sid-code/core/tool/truncation-detector.ts";

describe("truncation-detector — 文档文件跳过", () => {
  it(".md 文件不检测", () => {
    const content = "{".repeat(100); // 严重不平衡但是 markdown
    expect(detectTruncation(content, "/a/b/readme.md").isTruncated).toBe(false);
  });

  it(".txt 文件不检测", () => {
    const content = "{\n".repeat(200);
    expect(detectTruncation(content, "/notes.txt").isTruncated).toBe(false);
  });
});

describe("truncation-detector — 短内容跳过", () => {
  it("少于 500 字符不检测", () => {
    const content = "{\n{\n{\n"; // 不平衡但太短
    expect(detectTruncation(content, "/a.ts").isTruncated).toBe(false);
  });
});

describe("truncation-detector — 括号平衡检测", () => {
  it("正常代码（平衡）不触发", () => {
    const content = `
function foo() {
  if (true) {
    const arr = [1, 2, 3];
    return arr.map(x => ({ value: x }));
  }
}

function bar() {
  return { a: 1, b: [2, 3] };
}
`.repeat(50); // 扩大到 >500 字符
    expect(detectTruncation(content, "/a.ts").isTruncated).toBe(false);
  });

  it("3 层大括号不平衡 → 截断", () => {
    // 模拟：函数开了 3 层嵌套但没闭合
    const padding = "// padding line\n".repeat(40); // 超过 500 字符
    const truncated =
      padding +
      `
function outer() {
  function middle() {
    function inner() {
      console.log("truncated here");
`;
    const result = detectTruncation(truncated, "/a.ts");
    expect(result.isTruncated).toBe(true);
    expect(result.reason).toContain("{}");
  });

  it("2 层不平衡 → 不触发（容忍度内）", () => {
    const padding = "// padding line\n".repeat(40);
    const content =
      padding +
      `
function outer() {
  function inner() {
    console.log("end");
`;
    expect(detectTruncation(content, "/a.ts").isTruncated).toBe(false);
  });

  it("字符串内的括号不计入", () => {
    const padding = "// padding line\n".repeat(40);
    const content =
      padding +
      `
const a = "{{{{{";
const b = "}}}}}";
function foo() {
  return "done";
}
`;
    expect(detectTruncation(content, "/a.ts").isTruncated).toBe(false);
  });

  it("注释内的括号不计入", () => {
    const padding = "// padding line\n".repeat(40);
    const content =
      padding +
      `
// {{{{{ lots of open braces in comment
/* {{{ more in block comment */
function foo() {
  return 1;
}
`;
    expect(detectTruncation(content, "/a.ts").isTruncated).toBe(false);
  });

  it("方括号 3 层不平衡 → 截断", () => {
    const padding = "// padding line\n".repeat(40);
    const content =
      padding +
      `
const data = [
  [
    [
      { name: "truncated
`;
    const result = detectTruncation(content, "/a.json");
    expect(result.isTruncated).toBe(true);
    expect(result.reason).toContain("[]");
  });
});

describe("truncation-detector — 末尾突然中断", () => {
  it("HTML 文件末尾未闭合标签 → 截断", () => {
    const padding = "<!-- padding -->\n".repeat(40);
    const content =
      padding +
      `<div class="container">
  <h1>Hello</h1>
  <div class="inner
`;
    const result = detectTruncation(content, "/page.html");
    expect(result.isTruncated).toBe(true);
    expect(result.reason).toContain("HTML 标签");
  });

  it("TSX 文件末尾未闭合标签 → 截断", () => {
    const padding = "// pad\n".repeat(80);
    const content =
      padding +
      `<Button variant="primary" onClick={handler} className="btn-lg
`;
    const result = detectTruncation(content, "/App.tsx");
    expect(result.isTruncated).toBe(true);
    expect(result.reason).toContain("HTML 标签");
  });

  it("正常 HTML 末尾（闭合标签）不触发", () => {
    const padding = "<!-- padding -->\n".repeat(40);
    const content =
      padding +
      `<div class="container">
  <h1>Hello</h1>
</div>
`;
    expect(detectTruncation(content, "/page.html").isTruncated).toBe(false);
  });

  it("末尾未闭合字符串字面量 → 截断", () => {
    const padding = "// padding line\n".repeat(40);
    const content =
      padding +
      `
function render() {
  return "This is a very long string that got cut off in the mid
`;
    const result = detectTruncation(content, "/a.ts");
    expect(result.isTruncated).toBe(true);
    expect(result.reason).toContain("字符串字面量");
  });

  it("正常末尾字符串（闭合）不触发", () => {
    const padding = "// padding line\n".repeat(40);
    const content =
      padding +
      `
function render() {
  return "complete string";
}
`;
    expect(detectTruncation(content, "/a.ts").isTruncated).toBe(false);
  });
});

/**
 * T3（Harness 厚薄归位专项，2026-11-08）：末行引号判据曾是「三种引号总数为奇数」，
 * 注释里的英文撇号、双引号串里的撇号、docstring 收尾、YAML 裸值都会被判成截断，
 * 合法的覆盖写入被拒。正反两组必须同时成立：放过合法末行，**不放过真截断**。
 */
describe("truncation-detector — 末行引号：撇号与注释不算未闭合（T3）", () => {
  const py = "def f(x):\n    return x + 1\n".repeat(30);
  const js = "const a = 1\n".repeat(60);

  it.each([
    ["py 注释里的撇号", py + "# it's done\n", "a.py"],
    ["js 行注释里的撇号", js + "// don't touch\n", "a.ts"],
    ["行内注释里的撇号", py + "x = 1  # it's fine\n", "a.py"],
    ["双引号串里的撇号", py + 'print("it\'s done")\n', "a.py"],
    ["sql 的 -- 注释", "select 1;\n".repeat(60) + "-- user's table\n", "a.sql"],
    ["同行闭合的块注释", js + "/* it's ok */ foo()\n", "a.ts"],
    // 下面三条注释里是**孤立引号**而非两侧带字母的撇号：撇号规则兜不住，只能靠注释识别
    ["# 注释里的孤立引号", py + 'x = 1  # strip the trailing " from input\n', "a.py"],
    ["// 注释里的孤立引号", js + "// matches a leading ' or a backslash\n", "a.ts"],
    ["sql -- 注释里的孤立引号", "select 1;\n".repeat(60) + "-- quote char is '\n", "a.sql"],
    ["docstring 收尾（单行看不出开关）", py + '"""\n', "a.py"],
    ["YAML 裸值里的撇号", "k: v\n".repeat(150) + "description: Don't do this\n", "a.yaml"],
    ["多行模板串的收尾反引号", js + "const s = `\nabc\n`\n", "a.js"],
  ])("%s → 不报截断", (_name, content, file) => {
    expect(detectTruncation(content, file).isTruncated).toBe(false);
  });

  it.each([
    ["双引号串没闭合", py + 'x = "hello wor\n', "a.py"],
    ["单引号串没闭合", py + "x = 'hello wor\n", "a.py"],
    ["模板串没闭合", js + "const s = `abc\n", "a.js"],
    ["f 前缀串没闭合（f' 不是撇号）", py + "x = f'value {y\n", "a.py"],
    ["没闭合的串里带撇号", py + "x = \"it's cut\n", "a.py"],
    ["串里的 # 不是注释", js + 'x = "color #fff\n', "a.ts"],
    ["串里的 // 不是注释", js + 'const u = "https://example.com/a\n', "a.ts"],
    ["shell 的 --flag 不是注释", "echo a\n".repeat(80) + 'git commit --message "wip\n', "a.sh"],
  ])("%s → 仍然报截断", (_name, content, file) => {
    const r = detectTruncation(content, file);
    expect(r.isTruncated).toBe(true);
    expect(r.reason).toContain("字符串字面量");
  });
});
