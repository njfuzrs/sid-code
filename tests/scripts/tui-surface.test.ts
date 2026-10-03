/**
 * tui-surface（B9 / T0.1 端口面盘点）的正确性 + 变异自证。
 *
 * 这份清单是 T0.2 codemod「端口面零变化」的判据，所以它自己必须先被证明会红：
 * 漏扫一种导入形态 = codemod 少改一处而签名照样一致。下面每种形态都单独断言。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  analyze,
  extractDirectWrites,
  extractEnvVars,
  extractJsxProps,
  extractRendererImports,
  signature,
  stripComments,
  SURFACE_MD,
  symbolKey,
} from "../../scripts/tui-surface.ts";

describe("extractRendererImports：四种导入形态都要认", () => {
  test("默认导入 / 命名导入 / 类型导入 / 别名", () => {
    const src = [
      `import Box from "@sid-code/tui-renderer/components/Box.tsx";`,
      `import { Ansi as AnsiRaw } from "@sid-code/tui-renderer/Ansi.tsx";`,
      `import type { Color } from "@sid-code/tui-renderer/styles.ts";`,
      `import { useTabStatus, type TabStatusKind } from "@sid-code/tui-renderer/hooks/use-tab-status.ts";`,
      `import React from "react";`,
    ].join("\n");
    const got = extractRendererImports(src).map((s) => [symbolKey(s), s.typeOnly]);
    expect(got).toEqual([
      ["Box", false],
      ["Ansi", false],
      ["Color", true],
      ["useTabStatus", false],
      ["TabStatusKind", true],
    ]);
  });

  test("动态 import 解构（含 default: 重命名）", () => {
    const src =
      `const { default: render } = await import("@sid-code/tui-renderer/root.ts");\n` +
      `const { setClipboard } = await import("@sid-code/tui-renderer/termio/osc.ts");`;
    const got = extractRendererImports(src);
    expect(got.map(symbolKey)).toEqual(["render", "setClipboard"]);
    expect(got.every((s) => s.dynamic)).toBe(true);
  });

  test("多行 import 块", () => {
    const src = `import {\n  OSC,\n  osc,\n  wrapForMultiplexer,\n} from "@sid-code/tui-renderer/termio/osc.ts";`;
    expect(extractRendererImports(src).map(symbolKey)).toEqual([
      "OSC",
      "osc",
      "wrapForMultiplexer",
    ]);
  });

  test("注释里的示例导入不算依赖（§1.2 初稿 ScrollBox 误计的根因）", () => {
    const src =
      `// import ScrollBox from "@sid-code/tui-renderer/components/ScrollBox.tsx";\n` +
      `/* import { X } from "@sid-code/tui-renderer/x.ts"; */`;
    expect(extractRendererImports(src)).toEqual([]);
  });

  test("字符串里的 https:// 不被当成注释剥掉", () => {
    expect(stripComments(`const u = "https://a.b"; // 注释`)).toContain("https://a.b");
  });
});

describe("extractJsxProps", () => {
  test("字面量 / 表达式 / 裸属性 / spread / 嵌套花括号", () => {
    const src = `<Box flexDirection="column" marginTop={1} width={w} flexGrow {...rest} style={{ a: { b: 1 } }}>`;
    const got = extractJsxProps(src, ["Box"]).map((p) => [p.prop, p.literal]);
    expect(got).toEqual([
      ["flexDirection", "column"],
      ["marginTop", "1"],
      ["width", null],
      ["flexGrow", "true"],
      ["...spread", null],
      ["style", null],
    ]);
  });

  test("不把 <BoxFoo> 算成 <Box>", () => {
    expect(extractJsxProps(`<BoxFoo a="1" />`, ["Box"])).toEqual([]);
  });

  test("表达式里含 > 不截断（箭头函数）", () => {
    const got = extractJsxProps(`<Box onX={() => a > b} gap={1}>`, ["Box"]).map((p) => p.prop);
    expect(got).toEqual(["onX", "gap"]);
  });
});

describe("extractEnvVars", () => {
  test("process.env.X / process.env['X'] / 别名 env.X", () => {
    const src =
      `const env = opts?.env ?? process.env;\nif (process.env.TMUX) {}\n` +
      `process.env["WT_SESSION"];\nenv.TERM_PROGRAM; env["LC_TERMINAL"];`;
    expect(extractEnvVars(src).sort()).toEqual([
      "LC_TERMINAL",
      "TERM_PROGRAM",
      "TMUX",
      "WT_SESSION",
    ]);
  });

  test("文件里没出现 process.env 时，普通对象的 env.X 不算", () => {
    expect(extractEnvVars(`const env = { FOO: 1 }; env.FOO;`)).toEqual([]);
  });
});

describe("extractDirectWrites", () => {
  test("终端序列与普通输出分开", () => {
    const src = `process.stdout.write("\\x1b[?7l");\nprocess.stdout.write(json);\nfs.writeSync(process.stdout.fd, X_SEQUENCE);`;
    expect(extractDirectWrites(src, "f").map((w) => w.kind)).toEqual([
      "终端序列",
      "普通输出",
      "终端序列",
    ]);
  });
});

describe("真实仓库：清单与签名", () => {
  const surface = analyze();

  test("关键端口符号都在（与设计文档 §1.2 对得上）", () => {
    for (const name of [
      "Box",
      "Text",
      "Static",
      "AlternateScreen",
      "RawAnsi",
      "Ansi",
      "render",
      "inkInstances",
      "drainStdin",
      "setSuppressTerminalProbe",
      "useStdout",
      "useStdin",
      "measureElement",
      "getBoundingBox",
      "ResizeObserver",
      "stringWidth",
    ]) {
      expect(surface.symbols.has(name)).toBe(true);
    }
    // ScrollBox 只出现在注释里，不是依赖
    expect(surface.symbols.has("ScrollBox")).toBe(false);
  });

  test("CLI 的终端模式直写都被扫到（§1.5）", () => {
    const files = new Set(
      surface.directWrites.filter((w) => w.kind === "终端序列").map((w) => w.file),
    );
    expect(files).toContain("packages/cli/src/ui/fullscreen.ts");
    expect(files).toContain("packages/cli/src/ui/contexts/MouseContext.tsx");
    expect(files).toContain("packages/cli/src/ui/utils/terminalCapabilityManager.ts");
  });

  test("入库的 SURFACE.md 签名与源码一致（漂移就要重生成）", () => {
    const md = readFileSync(SURFACE_MD, "utf8");
    expect(md).toContain(`<!-- surface-signature: ${signature(surface)} -->`);
  });

  test("变异自证：多一个符号 / 多一个 prop / 多一个环境变量，签名都会变", () => {
    const base = signature(surface);
    const clone = () => ({
      ...surface,
      symbols: new Map(surface.symbols),
      props: new Map(surface.props),
      envVars: new Map(surface.envVars),
    });
    const a = clone();
    a.symbols.set("ScrollBox", {
      modules: new Set(["x"]),
      files: new Set(["f"]),
      typeOnly: false,
      dynamic: false,
    });
    expect(signature(a)).not.toBe(base);
    const b = clone();
    b.props.set("Box.scrollTop", {
      count: 1,
      files: new Set(["f"]),
      literals: new Map(),
      dynamic: 1,
    });
    expect(signature(b)).not.toBe(base);
    const c = clone();
    c.envVars.set("SID_TUI_RENDERER", new Set(["x"]));
    expect(signature(c)).not.toBe(base);
  });

  test("计数变化不影响签名（日常 UI 改动不应逼人重生成）", () => {
    const base = signature(surface);
    const box = surface.symbols.get("Box")!;
    const bumped = new Map(surface.symbols);
    bumped.set("Box", { ...box, files: new Set([...box.files, "packages/cli/src/ui/new.tsx"]) });
    expect(signature({ ...surface, symbols: bumped })).toBe(base);
  });
});
