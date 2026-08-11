/**
 * /color 命令测试（P2-5）
 *
 * 覆盖：无参展示 / 设 hex / 命名色归一化 / 非法色拒绝 / reset 清除 / -p 持久化标志。
 * themeManager 是单例，测试后复位 accentOverride 避免污染其它用例。
 */
import { describe, test, expect, afterEach } from "bun:test";
import colorCmd from "@sid-code/cli/command/commands/color/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";
import { themeManager } from "@sid-code/cli/ui/themes/theme-manager.ts";

const loadColor = () => (colorCmd as LocalCommand).load();
const ctx = {} as unknown as CommandContext;

afterEach(() => themeManager.setAccentOverride(undefined));

describe("/color 命令", () => {
  test("无参展示当前强调色", async () => {
    const mod = await loadColor();
    const r = await mod.call("", ctx);
    expect((r as { value: string }).value).toContain("当前强调色");
  });

  test("设 hex → override 生效", async () => {
    const mod = await loadColor();
    const r = await mod.call("#89b4fa", ctx);
    expect((r as { value: string }).value).toContain("#89b4fa");
    expect(themeManager.getAccentOverride()).toBe("#89b4fa");
    // 语义色 ui.active 被覆盖
    expect(themeManager.getSemanticColors().ui.active).toBe("#89b4fa");
  });

  test("CSS 命名色归一化为 hex", async () => {
    const mod = await loadColor();
    // rebeccapurple 是 CSS 色名（非 Ink 原生），resolveColor 会转 hex。
    await mod.call("rebeccapurple", ctx);
    const override = themeManager.getAccentOverride();
    expect(override).toMatch(/^#/); // 已归一化为 hex
  });

  test("Ink 命名色归一化为 ansi: 前缀形态（裸名在 ink fork 下不上色）", async () => {
    const mod = await loadColor();
    await mod.call("cyan", ctx);
    // 原断言是 toBe("cyan")，即「原样保留」——那是个把缺陷当规格的断言。
    // ink fork 的 colorize()（src/ink/colorize.ts）只识别 `ansi:*` / `#hex` /
    // `rgb()` / `ansi256()` 四种形态，裸 "cyan" 会落到函数末尾的 `return str`，
    // **静默不上色**（实测 FORCE_COLOR=3：`ansi:cyan` → `\e[36m`，裸 `cyan` → 原样）。
    // 也就是说 `/color cyan` 以前等于设了个不生效的强调色。resolveColor 现在统一
    // 把 ink 命名色映射到 `ansi:` 形态，故此处断言归一化后的值。
    expect(themeManager.getAccentOverride()).toBe("ansi:cyan");
  });

  test("非法颜色被拒绝，不改 override", async () => {
    const mod = await loadColor();
    const r = await mod.call("notacolor", ctx);
    expect((r as { value: string }).value).toContain("无效颜色");
    expect(themeManager.getAccentOverride()).toBeUndefined();
  });

  test("reset 清除覆盖", async () => {
    const mod = await loadColor();
    await mod.call("#ff0000", ctx);
    expect(themeManager.getAccentOverride()).toBe("#ff0000");
    const r = await mod.call("reset", ctx);
    expect((r as { value: string }).value).toContain("已清除");
    expect(themeManager.getAccentOverride()).toBeUndefined();
  });
});
