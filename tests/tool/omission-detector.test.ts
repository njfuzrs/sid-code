/**
 * 省略占位符检测器测试
 * 覆盖：各种语言的省略标记、TODO 占位符、独立省略号
 */

import { describe, test, expect } from "bun:test";
import { detectOmissionPlaceholders, hasOmissionPlaceholders } from "../../src/tool/omission-detector.ts";

describe("detectOmissionPlaceholders - JavaScript/TypeScript", () => {
  test("检测 // ... rest of 注释", () => {
    const code = `function foo() {
  console.log("start");
  // ... rest of implementation
  return true;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].line).toBe(3);
    expect(matches[0].text).toContain("rest of");
  });

  test("检测 /* ... */ 块注释", () => {
    const code = `function bar() {
  /* ... rest of code */
  return 42;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
  });

  test("检测 // existing code 注释", () => {
    const code = `class MyClass {
  constructor() {}
  // existing methods
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].text).toContain("existing");
  });

  test("检测 TODO 占位符", () => {
    const code = `function process() {
  // TODO: implement this
  return null;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].text).toContain("TODO");
  });

  test("正常注释不误报", () => {
    const code = `// This is a normal comment
function foo() {
  // Calculate the result
  return 42;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBe(0);
  });
});

describe("detectOmissionPlaceholders - Python", () => {
  test("检测 # ... rest of 注释", () => {
    const code = `def process():
    print("start")
    # ... rest of implementation
    return True`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].text).toContain("rest of");
  });

  test("检测 # existing code 注释", () => {
    const code = `class MyClass:
    def __init__(self):
        pass
    # existing methods`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("detectOmissionPlaceholders - HTML", () => {
  test("检测 <!-- ... --> 注释", () => {
    const code = `<div>
  <h1>Title</h1>
  <!-- ... rest of content -->
</div>`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].text).toContain("rest of");
  });

  test("检测 <!-- existing markup --> 注释", () => {
    const code = `<body>
  <header>Header</header>
  <!-- existing content -->
</body>`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("detectOmissionPlaceholders - 独立省略号", () => {
  test("检测独立行的省略号", () => {
    const code = `function foo() {
  console.log("start");
  ...
  return true;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].line).toBe(3);
  });

  test("检测带空白的省略号", () => {
    const code = `function bar() {
  console.log("start");
    ...
  return true;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
  });

  test("检测 [...] 括号省略号", () => {
    const code = `const config = {
  name: "test",
  [...]
};`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
  });

  test("检测 (...) 括号省略号", () => {
    const code = `function process(a, b, (...)) {
  return a + b;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
  });

  test("正常的展开运算符不误报", () => {
    const code = `const arr = [...items];
const obj = { ...props };`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBe(0);
  });
});

describe("hasOmissionPlaceholders", () => {
  test("有省略返回 true", () => {
    const code = "// ... rest of code";
    expect(hasOmissionPlaceholders(code)).toBe(true);
  });

  test("无省略返回 false", () => {
    const code = "function foo() { return 42; }";
    expect(hasOmissionPlaceholders(code)).toBe(false);
  });
});

describe("detectOmissionPlaceholders - 边界情况", () => {
  test("空字符串", () => {
    const matches = detectOmissionPlaceholders("");
    expect(matches.length).toBe(0);
  });

  test("多个省略标记", () => {
    const code = `function foo() {
  // ... rest of implementation
  console.log("middle");
  // TODO: complete this
  return true;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBe(2);
  });

  test("每行只记录第一个匹配", () => {
    const code = "// ... rest of code ... more stuff";
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBe(1);
  });
});
