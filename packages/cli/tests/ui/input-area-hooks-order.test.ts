/**
 * InputArea 的 hook 调用顺序回归测试（Ctrl+R 崩溃）。
 *
 * 根因：反向搜索模式的提前 `return` 写在队列提示 / Shell 提示那两组
 * useRef/useEffect 之前。Ctrl+R 激活后本次渲染少调 6 个 hook，React 抛
 * #300（Rendered fewer hooks than expected），整个 TUI 直接崩掉。
 *
 * 为什么用静态扫描而不是真渲染：InputArea 依赖 Keypress / Keybinding / UIState /
 * Settings 四个 Provider，真渲染的 harness 成本远高于它要守的不变量本身。
 * 这里守的是「组件体内第一个提前 return 之后不再出现任何 hook 调用」——
 * 只要有人把新 hook 写到某个模式分支 return 之后，这条就红。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "../../src/ui/InputArea.tsx");

/** 取 InputArea 组件体（从 `export function InputArea(` 到文件末尾）。 */
function componentBody(source: string): string {
  const start = source.indexOf("export function InputArea(");
  if (start < 0) throw new Error("未找到 InputArea 组件定义");
  return source.slice(start);
}

/**
 * 找组件体顶层（两空格缩进）第一个「if (...) { ... return」形式的提前返回，
 * 返回其之后的源码；没有提前返回则返回空串。
 */
function afterFirstEarlyReturn(body: string): string {
  const re = /\n {2}if \([^\n]*\) \{\n(?: {4}[^\n]*\n)*? {4}return\b/;
  const m = re.exec(body);
  return m ? body.slice(m.index + m[0].length) : "";
}

/** 提前 return 之后出现的 hook 调用（use 开头 + 大写字母 + 左括号）。 */
export function hooksAfterEarlyReturn(source: string): string[] {
  const rest = afterFirstEarlyReturn(componentBody(source));
  return [...rest.matchAll(/\buse[A-Z]\w*\(/g)].map((m) => m[0]);
}

describe("InputArea hook 顺序", () => {
  test("任何模式分支的提前 return 之后都不再调用 hook（否则 Ctrl+R 触发 React #300）", () => {
    const source = readFileSync(SRC, "utf8");
    expect(hooksAfterEarlyReturn(source)).toEqual([]);
  });

  test("检测器自证：把 hook 写在提前 return 之后能被识别出来", () => {
    const bad = [
      "export function InputArea() {",
      "  const a = useState(0);",
      "  if (mode.active) {",
      "    return null;",
      "  }",
      "  const r = useRef(false);",
      "  useEffect(() => {}, []);",
      "  return null;",
      "}",
    ].join("\n");
    expect(hooksAfterEarlyReturn(bad)).toEqual(["useRef(", "useEffect("]);
  });
});
