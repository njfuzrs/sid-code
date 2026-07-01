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
import { detectTruncation } from "../../src/tool/truncation-detector.ts";

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
    const truncated = padding + `
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
    const content = padding + `
function outer() {
  function inner() {
    console.log("end");
`;
    expect(detectTruncation(content, "/a.ts").isTruncated).toBe(false);
  });

  it("字符串内的括号不计入", () => {
    const padding = "// padding line\n".repeat(40);
    const content = padding + `
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
    const content = padding + `
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
    const content = padding + `
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
    const content = padding + `<div class="container">
  <h1>Hello</h1>
  <div class="inner
`;
    const result = detectTruncation(content, "/page.html");
    expect(result.isTruncated).toBe(true);
    expect(result.reason).toContain("HTML 标签");
  });

  it("TSX 文件末尾未闭合标签 → 截断", () => {
    const padding = "// pad\n".repeat(80);
    const content = padding + `<Button variant="primary" onClick={handler} className="btn-lg
`;
    const result = detectTruncation(content, "/App.tsx");
    expect(result.isTruncated).toBe(true);
    expect(result.reason).toContain("HTML 标签");
  });

  it("正常 HTML 末尾（闭合标签）不触发", () => {
    const padding = "<!-- padding -->\n".repeat(40);
    const content = padding + `<div class="container">
  <h1>Hello</h1>
</div>
`;
    expect(detectTruncation(content, "/page.html").isTruncated).toBe(false);
  });

  it("末尾未闭合字符串字面量 → 截断", () => {
    const padding = "// padding line\n".repeat(40);
    const content = padding + `
function render() {
  return "This is a very long string that got cut off in the mid
`;
    const result = detectTruncation(content, "/a.ts");
    expect(result.isTruncated).toBe(true);
    expect(result.reason).toContain("字符串字面量");
  });

  it("正常末尾字符串（闭合）不触发", () => {
    const padding = "// padding line\n".repeat(40);
    const content = padding + `
function render() {
  return "complete string";
}
`;
    expect(detectTruncation(content, "/a.ts").isTruncated).toBe(false);
  });
});
