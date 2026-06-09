/**
 * 省略占位符检测器测试
 * 覆盖：各种语言的省略标记、TODO 占位符、独立省略号
 * 文档分级检测、isDocumentFile、m 标志修复验证
 */

import { describe, test, expect } from "bun:test";
import { detectOmissionPlaceholders, hasOmissionPlaceholders, isDocumentFile } from "../../src/tool/omission-detector.ts";

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
  test("检测独立行的三连点", () => {
    const code = `function foo() {
  console.log("start");
  ...
  return true;
}`;
    const matches = detectOmissionPlaceholders(code);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].line).toBe(3);
  });

  test("检测带空白的三连点", () => {
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

describe("isDocumentFile", () => {
  test("识别 .md 文件", () => {
    expect(isDocumentFile("/path/to/doc.md")).toBe(true);
  });

  test("识别 .mdx 文件", () => {
    expect(isDocumentFile("/path/to/doc.mdx")).toBe(true);
  });

  test("识别 .markdown 文件", () => {
    expect(isDocumentFile("/path/to/readme.markdown")).toBe(true);
  });

  test("识别 .txt 文件", () => {
    expect(isDocumentFile("/path/to/notes.txt")).toBe(true);
  });

  test("识别 .rst 文件", () => {
    expect(isDocumentFile("/path/to/doc.rst")).toBe(true);
  });

  test("识别 .adoc 文件", () => {
    expect(isDocumentFile("/path/to/doc.adoc")).toBe(true);
  });

  test("不识别 .ts 文件", () => {
    expect(isDocumentFile("/path/to/code.ts")).toBe(false);
  });

  test("不识别 .js 文件", () => {
    expect(isDocumentFile("/path/to/code.js")).toBe(false);
  });

  test("大小写不敏感", () => {
    expect(isDocumentFile("/path/to/README.MD")).toBe(true);
  });
});

describe("detectOmissionPlaceholders - 文档文件分级检测", () => {
  test("文档跳过独立省略号（三连点独占一行）", () => {
    const content = "# 标题\n一些内容\n...\n更多内容";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBe(0);
  });

  test("文档跳过多点号独立省略号", () => {
    const content = "# 标题\n......................\n更多内容";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBe(0);
  });

  test("文档跳过方括号省略号", () => {
    const content = "配置项：[...]其他内容";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBe(0);
  });

  test("文档跳过圆括号省略号", () => {
    const content = "函数签名：process(a, b, (...))";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBe(0);
  });

  test("文档跳过块注释省略号", () => {
    const content = "/* ... rest of code */";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBe(0);
  });

  test("文档跳过 HTML 注释省略", () => {
    const content = "<!-- ... rest of content -->";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBe(0);
  });

  test("文档仍检测 JS 注释省略", () => {
    const content = `function foo() {
  // ... rest of implementation
  return true;
}`;
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].pattern).toBe("JS comment ellipsis");
  });

  test("文档仍检测 TODO 占位符", () => {
    const content = "// TODO: implement this";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].pattern).toBe("TODO placeholder");
  });

  test("文档仍检测 Python/Shell 注释省略", () => {
    const content = "# ... rest of implementation";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].pattern).toBe("Python/Shell ellipsis");
  });

  test("文档仍检测 JS existing code", () => {
    const content = "// existing methods";
    const matches = detectOmissionPlaceholders(content, true);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].pattern).toBe("JS existing code");
  });

  test("代码文件全量检测不变 — 独立省略号", () => {
    const content = `function foo() {
  ...
  return true;
}`;
    const matches = detectOmissionPlaceholders(content, false);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].pattern).toBe("Standalone ellipsis");
  });

  test("代码文件全量检测不变 — 方括号省略号", () => {
    const content = "const config = { [...] }";
    const matches = detectOmissionPlaceholders(content, false);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].pattern).toBe("Bracketed ellipsis");
  });

  test("代码文件全量检测不变 — 圆括号省略号", () => {
    const content = "function process((...)) {}";
    const matches = detectOmissionPlaceholders(content, false);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].pattern).toBe("Parenthesized ellipsis");
  });

  test("向后兼容（不传 isDoc，默认为代码文件）", () => {
    const content = `function foo() {
  ...
  return true;
}`;
    const matches = detectOmissionPlaceholders(content);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("detectOmissionPlaceholders - m 标志修复验证", () => {
  test("正确报告三连点行的实际行号", () => {
    const content = "第1行正常内容\n第2行正常内容\n...\n第4行正常内容\n第5行正常内容";
    const matches = detectOmissionPlaceholders(content);
    expect(matches.length).toBe(1);
    expect(matches[0].line).toBe(3);
  });

  test("多行独立省略号各自报告正确行号", () => {
    const content = "开始\n...\n中间\n...\n结束";
    const matches = detectOmissionPlaceholders(content);
    expect(matches.length).toBe(2);
    expect(matches[0].line).toBe(2);
    expect(matches[1].line).toBe(4);
  });
});

describe("hasOmissionPlaceholders - 文档文件兼容", () => {
  test("有省略但 isDoc=true 时可能跳过", () => {
    // 独立省略号在文档中跳过
    const content = "# 标题\n...\n内容";
    expect(hasOmissionPlaceholders(content, true)).toBe(false);
  });

  test("有代码省略且 isDoc=true 时仍检测", () => {
    const content = "// ... rest of code";
    expect(hasOmissionPlaceholders(content, true)).toBe(true);
  });

  test("不传 isDoc 向后兼容", () => {
    const content = "// ... rest of code";
    expect(hasOmissionPlaceholders(content)).toBe(true);
  });
});
