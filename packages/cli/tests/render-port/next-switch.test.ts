/**
 * B9 / T1.3：`SID_TUI_RENDERER` 开关与 next 骨架。
 *
 * 要钉住的是开关本身，不是 next 的功能（骨架阶段功能不全是预期的）：
 * - 解析规则：缺省 / 空 / 大小写 / 拼错都有确定结果，拼错不会让用户启动不了；
 * - 唯一选择点：端口模块不各自读环境变量（各读各的会混用两套底座）；
 * - 两套实现导出同一组符号：next 少导出一个，CLI 那边就是 undefined，CI 没有 tsc 拦不住；
 * - 未实现的符号用时就抛，并带任务号，而不是静默 no-op；
 * - 两个取值下最小 App 都能在子进程里启动并正常退出。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RENDERER, resolveRenderer } from "@sid-code/cli/ui/render-port/select.ts";

const PORT_DIR = join(import.meta.dir, "../../src/ui/render-port");
const MODULES = ["components", "hooks", "measure", "text", "termio", "runtime", "testing"] as const;
const FIXTURE = join(import.meta.dir, "fixtures", "next-minimal-app.tsx");

describe("resolveRenderer", () => {
  test("缺省与空串 → 默认 legacy", () => {
    expect(DEFAULT_RENDERER).toBe("legacy");
    expect(resolveRenderer(undefined)).toBe("legacy");
    expect(resolveRenderer("")).toBe("legacy");
    expect(resolveRenderer("  ")).toBe("legacy");
  });

  test("合法值大小写 / 空白不敏感", () => {
    expect(resolveRenderer("next")).toBe("next");
    expect(resolveRenderer(" NEXT ")).toBe("next");
    expect(resolveRenderer("Legacy")).toBe("legacy");
  });

  test("无法识别 → 回落默认值并告警一次，不抛", () => {
    const warns: string[] = [];
    expect(resolveRenderer("nxet", (m) => warns.push(m))).toBe("legacy");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("nxet");
  });
});

describe("唯一选择点", () => {
  test("只有 select.ts 读 SID_TUI_RENDERER，端口模块都从 select.ts 取 RENDERER", () => {
    const readers = readdirSync(PORT_DIR, { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f))
      // 只认真实读取（process.env.X / process.env["X"] / Bun.env.X），注释里提到这个名字不算
      .filter((f) =>
        /(process|Bun)\.env(\.SID_TUI_RENDERER|\[\s*["']SID_TUI_RENDERER["']\s*\])/.test(
          readFileSync(join(PORT_DIR, f), "utf8"),
        ),
      );
    expect(readers).toEqual(["select.ts"]);
    for (const m of MODULES) {
      const src = readFileSync(join(PORT_DIR, `${m}.ts`), "utf8");
      expect(src, `${m}.ts`).toContain('from "./select.ts"');
      expect(src, `${m}.ts`).toContain(`import("./next/${m}.ts")`);
      expect(src, `${m}.ts`).toContain(`import("./legacy/${m}.ts")`);
    }
  });
});

describe("legacy / next 导出同一组符号", () => {
  for (const m of MODULES) {
    test(`${m}`, async () => {
      const legacy = Object.keys(await import(`../../src/ui/render-port/legacy/${m}.ts`)).sort();
      const next = Object.keys(await import(`../../src/ui/render-port/next/${m}.ts`)).sort();
      const port = Object.keys(await import(`../../src/ui/render-port/${m}.ts`)).sort();
      expect(next).toEqual(legacy);
      // 端口模块自己额外导出的只有实例能力清单（runtime.ts 的 RENDER_INSTANCE_METHODS）
      expect(port.filter((k) => !legacy.includes(k))).toEqual(
        m === "runtime" ? ["RENDER_INSTANCE_METHODS"] : [],
      );
    });
  }
});

describe("next 骨架：未实现的符号用时就抛", () => {
  test("函数 / 值 / 组件三种占位都抛 NotImplementedError，并带任务号", async () => {
    // 样本挑阶段 5 之后才实现的符号；T4.3 实现了最后一个值占位（ResizeObserver），值占位改为直接测 helper
    // T7.2a 实现了 useTerminalTitle，剩下的函数占位（setSuppressTerminalProbe）也在并行实现中，
    // 函数占位样本与值占位一样改为直接测 helper，不再跟着实现进度换样本
    const { notImplementedFn, notImplementedValue } =
      await import("../../src/ui/render-port/next/not-implemented.ts");
    expect(() => notImplementedFn("SampleFn", "T9.9")()).toThrow(/SampleFn 尚未实现（T9\.9）/);
    const Value = notImplementedValue("Sample", "T9.9") as unknown as new () => unknown;
    expect(() => new Value()).toThrow(/Sample 尚未实现（T9\.9）/);
    // T6.1a 实现了最后一个组件占位（AlternateScreen），组件占位改为直接测 helper
    const { notImplementedComponent } =
      await import("../../src/ui/render-port/next/not-implemented.ts");
    const Comp = notImplementedComponent("SampleComp", "T9.9") as unknown as () => unknown;
    expect(() => Comp()).toThrow(/SampleComp 尚未实现（T9\.9）/);
  });

  test("next 的 Box / Text / Ansi / RawAnsi / AlternateScreen 来自 @sid-code/tui，不是 legacy", async () => {
    const next = await import("../../src/ui/render-port/next/components.ts");
    const legacy = await import("../../src/ui/render-port/legacy/components.ts");
    // 测试也只能经端口拿底座（lint:boundary 的 render-port 规则），所以不直接 import @sid-code/tui，
    // 改为核对 next/components.ts 的来源声明 + 与 legacy 不是同一个对象
    const src = readFileSync(join(PORT_DIR, "next/components.ts"), "utf8");
    expect(src).toMatch(
      /export \{ AlternateScreen, Ansi, Box, RawAnsi, Text \} from "@sid-code\/tui";/,
    );
    for (const k of ["Box", "Text", "Ansi", "RawAnsi", "AlternateScreen"] as const)
      expect(next[k]).not.toBe(legacy[k]);
  });

  test("next 的 Static 是新写的 History，不是上游 print-once 的 <Static>（D-3 定案 A，T4.2）", async () => {
    const next = await import("../../src/ui/render-port/next/components.ts");
    const legacy = await import("../../src/ui/render-port/legacy/components.ts");
    const src = readFileSync(join(PORT_DIR, "next/components.ts"), "utf8");
    expect(src).toMatch(/export \{ History as Static \} from "@sid-code\/tui";/);
    // 不允许不改名地把上游 Static 直接导出（`{ Static }` / `{ X, Static }`）；`History as Static` 才对
    expect(src).not.toMatch(/export \{(?:[^}]*,)? *Static\b/);
    expect(next.Static).not.toBe(legacy.Static);
  });
});

describe("最小 App 在两个取值下都能启动并退出", () => {
  function runApp(value: string | undefined) {
    const env: Record<string, string | undefined> = { ...process.env };
    if (value === undefined) delete env.SID_TUI_RENDERER;
    else env.SID_TUI_RENDERER = value;
    const r = Bun.spawnSync([process.execPath, FIXTURE], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  for (const [value, expected] of [
    [undefined, "legacy"],
    ["legacy", "legacy"],
    ["next", "next"],
    ["bogus", "legacy"],
  ] as const) {
    test(`SID_TUI_RENDERER=${value ?? "(未设置)"} → ${expected}`, () => {
      const r = runApp(value);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`renderer=${expected}`);
      expect(r.out).toContain(`MINIMAL_APP_OK ${expected}`);
      if (value === "bogus") expect(r.err).toContain("无法识别");
    });
  }
});
