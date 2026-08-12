/**
 * /language 交互面板接线的回归测试。
 *
 * 背景：`/language` 此前无参只吐一段纯文本（当前值 + 可用值列表 + 用法），用户得**照抄**
 * 其中一个值再敲一遍完整命令才能切换——同类的偏好切换命令（/model、/theme、/effort、
 * /think）无参全是开面板、键盘选。这个不一致就是本次修复的对象。
 *
 * 用例锁的是**行为不变量**而非文案：
 *   1. 无参开面板（且是 language 面板），不再回纯文本；
 *   2. 文本视图仍有逃生口（status/list/ls/show），无头/脚本化场景不被面板堵死；
 *   3. 面板选定值透传回命令后各档行为正确——尤其 `unset` 必须落到 undefined（清偏好），
 *      **不能**被当成 auto：auto 是"跟随用户输入语言"这一档有效偏好，两者行为不同，
 *      旧实现混淆过一次（auto 沦为 zh 别名），这里立哨兵防复发；
 *   4. 面板路径带 -p 持久化（App.tsx handleLanguageSelect 拼的就是 `<choice> -p`）。
 */

import { describe, test, expect, mock } from "bun:test";
import { LanguageCommand } from "@sid-code/cli/command/language.ts";
import type { AppContext } from "@sid-code/cli/command/types.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { LanguagePref } from "@sid-code/core/config/prompt-lang.ts";

interface Recorded {
  lang: LanguagePref | undefined;
  persist: boolean | undefined;
  calls: number;
}

function createCtx(language?: LanguagePref): { ctx: AppContext; rec: Recorded } {
  const rec: Recorded = { lang: undefined, persist: undefined, calls: 0 };
  const config = { language } as unknown as Config;
  const ctx = {
    config,
    ctxMgr: {} as any,
    registry: {} as any,
    sessionId: "test-session",
    provider: {} as any,
    setModel: mock(() => {}),
    setLanguage: mock((lang: LanguagePref | undefined, persist?: boolean) => {
      rec.lang = lang;
      rec.persist = persist;
      rec.calls += 1;
      config.language = lang;
    }),
    exitRequested: false,
    sessionState: {} as any,
  } as unknown as AppContext;
  return { ctx, rec };
}

describe("/language 交互面板", () => {
  test("无参 → 打开 language 面板（不再回纯文本）", async () => {
    const { ctx, rec } = createCtx("zh");
    const result = await new LanguageCommand().execute("", ctx);

    expect(result.kind).toBe("dialog");
    expect(result.dialog).toBe("language");
    // 开面板本身不应改动任何偏好——切换发生在用户按 Enter 之后。
    expect(rec.calls).toBe(0);
  });

  test("只带 -p 也开面板（-p 由面板选定后自身携带，不算参数）", async () => {
    const { ctx } = createCtx();
    const result = await new LanguageCommand().execute("-p", ctx);
    expect(result.kind).toBe("dialog");
    expect(result.dialog).toBe("language");
  });

  test.each(["status", "list", "ls", "show"])(
    "/language %s → 纯文本状态（面板之外的逃生口）",
    async (token) => {
      const { ctx, rec } = createCtx("en");
      const result = await new LanguageCommand().execute(token, ctx);

      expect(result.kind).toBe("message");
      expect(result.message).toContain("en");
      expect(rec.calls).toBe(0);
    },
  );

  test("状态文本提及面板入口（否则用户不知道有面板可用）", async () => {
    const { ctx } = createCtx();
    const result = await new LanguageCommand().execute("status", ctx);
    expect(result.message).toContain("面板");
  });

  test.each([
    ["zh", "zh"],
    ["en", "en"],
    ["auto", "auto"],
  ] as const)("面板选定 %s -p → setLanguage(%s, true)", async (choice, expected) => {
    const { ctx, rec } = createCtx();
    const result = await new LanguageCommand().execute(`${choice} -p`, ctx);

    expect(result.kind).toBe("message");
    expect(rec.lang).toBe(expected);
    expect(rec.persist).toBe(true);
  });

  test("面板选定 unset -p → setLanguage(undefined, true)，不得落成 auto", async () => {
    const { ctx, rec } = createCtx("en");
    const result = await new LanguageCommand().execute("unset -p", ctx);

    expect(result.kind).toBe("message");
    expect(rec.calls).toBe(1);
    // 关键哨兵：undefined（无偏好，回落缺省 zh）≠ "auto"（有偏好，跟随用户输入语言）。
    expect(rec.lang).toBeUndefined();
    expect(rec.lang).not.toBe("auto");
    expect(rec.persist).toBe(true);
  });

  test("非法值仍报错，不误开面板", async () => {
    const { ctx, rec } = createCtx();
    const result = await new LanguageCommand().execute("klingon", ctx);

    expect(result.kind).toBe("error");
    expect(rec.calls).toBe(0);
  });

  test("argumentHint 暴露 status 档（/commands 面板据此提示）", () => {
    expect(new LanguageCommand().argumentHint?.()).toContain("status");
  });
});
