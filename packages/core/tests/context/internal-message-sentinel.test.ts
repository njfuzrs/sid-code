/**
 * 内部消息来源 —— 防漂移哨兵测试
 *
 * 对标本项目 `ABORT_REASONS` 的防漂移哨兵套路：把"内部注入消息不泄漏到 TUI"从
 * "开发者自觉打标记"变成"机制强制 + 测试兜底"。
 *
 * 三道防线：
 *  1. helper 契约：markInternal / buildInternalMessage 打的标记能被 hasInternalOrigin 识别，
 *     且类型系统限制 origin 只能取白名单内的值。
 *  2. 源码扫描（核心）：扫描 src/ 下所有手写 `_meta: { origin: "…" }` 字面量注入点，断言每个
 *     origin 都已在 INTERNAL_ORIGINS 登记。任何人新增一个未登记的内部 origin → 本测试失败，
 *     强制其先登记到单一事实源。
 *  3. 隐藏行为：带白名单 origin 的消息确实被 history-adapter 判定为隐藏。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  INTERNAL_ORIGINS,
  INTERNAL_RENDER_ORIGINS,
  isInternalOrigin,
  hasInternalOrigin,
  markInternal,
  buildInternalMessage,
} from "@sid-code/core/context/internal-message.ts";
import { isHiddenFromDisplay } from "@sid-code/cli/ui/history-adapter.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

describe("internal-message helper 契约", () => {
  test("buildInternalMessage 打的标记能被 hasInternalOrigin 识别", () => {
    const msg = buildInternalMessage("compact-summary", "assistant", "了解，继续。");
    expect(hasInternalOrigin(msg)).toBe(true);
    expect(msg._meta?.origin).toBe("compact-summary");
    expect(msg.content).toEqual([{ type: "text", text: "了解，继续。" }]);
  });

  test("buildInternalMessage 支持合并 extraMeta（如 isMeta）", () => {
    const msg = buildInternalMessage("task-notification", "user", "通知", { isMeta: true });
    expect(msg._meta?.origin).toBe("task-notification");
    expect(msg._meta?.isMeta).toBe(true);
  });

  test("markInternal 保留原有 _meta 其它字段", () => {
    const base: Message = {
      role: "user",
      content: [{ type: "text", text: "x" }],
      _meta: { foo: "bar" },
    };
    const marked = markInternal(base, "resume-summary");
    expect(marked._meta?.origin).toBe("resume-summary");
    expect(marked._meta?.foo).toBe("bar");
    // 不原地修改
    expect(base._meta?.origin).toBeUndefined();
  });

  test("isInternalOrigin 只认白名单，不认未登记文案", () => {
    expect(isInternalOrigin("compact-summary")).toBe(true);
    expect(isInternalOrigin("未登记的来源")).toBe(false);
    expect(isInternalOrigin(undefined)).toBe(false);
    expect(isInternalOrigin(123)).toBe(false);
  });
});

describe("防漂移哨兵：源码扫描所有 origin 注入点", () => {
  /** 递归收集 src/ 下所有 .ts 文件（排除测试与本模块自身）。 */
  function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        collectSourceFiles(full, acc);
      } else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".test.ts") &&
        // 单一事实源自身声明白名单，其 origin 字面量不是"注入点"，跳过
        !full.endsWith(join("context", "internal-message.ts"))
      ) {
        acc.push(full);
      }
    }
    return acc;
  }

  /**
   * 从源码文本里收集「`_meta: { … }` 对象字面量内」的 origin 字面量。
   *
   * 为什么不直接扫 `origin: "…"`：`origin` 是通用词，别的领域字段也叫它 ——
   * `CronTask.origin` 记定时任务来源（cron/types.ts）、`NormalizedLLMError.origin`
   * 记错误来源（llm/error-normalize.ts 甚至为避开旧正则绕成了先声明变量再写键）。
   * 2026-11-05 实测：CronTask 新增 origin 字段后，旧正则把三个任务来源
   * （cron_create / schedule_wakeup / loop）误报成未登记的内部消息 origin。
   * 判据必须锚定 `_meta: {` 这个真实注入形态，而不是靠「字段名叫 origin」猜。
   *
   * `[^{}]*?` 只允许在同一层对象内寻找：跨过 `}` 就说明那是另一个对象了，
   * 不能把别的对象的 origin 记到 `_meta` 头上。
   */
  function collectMetaOrigins(text: string): string[] {
    const META_ORIGIN = /_meta\s*:\s*\{[^{}]*?\borigin:\s*["']([^"']+)["']/g;
    return [...text.matchAll(META_ORIGIN)].map((m) => m[1]);
  }

  test('所有手写 `_meta: { origin: "…" }` 的字面量 origin 都已登记到 INTERNAL_ORIGINS', () => {
    // P2-2 分包：生产源码分布在 4 个包，全扫。只扫一个包会让哨兵半瞎且不报错。
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
    const files = ["shared", "tui", "core", "cli"].flatMap((p) =>
      collectSourceFiles(join(repoRoot, "packages", p, "src")),
    );
    // 防空转：路径指错时会扫到 0 个文件而假绿。
    expect(files.length).toBeGreaterThan(500);

    // 已知内部来源 = 整条隐藏类 + 专用渲染类。两类都算"已登记"，未登记才算漂移。
    const whitelist = new Set<string>([...INTERNAL_ORIGINS, ...INTERNAL_RENDER_ORIGINS]);

    const violations: Array<{ file: string; origin: string }> = [];
    for (const file of files) {
      for (const origin of collectMetaOrigins(readFileSync(file, "utf-8"))) {
        if (!whitelist.has(origin)) {
          violations.push({ file: file.replace(`${repoRoot}/`, ""), origin });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations.map((v) => `  - "${v.origin}"  (${v.file})`).join("\n");
      throw new Error(
        `发现未登记的内部消息 origin（会泄漏到 TUI 或行为不一致）：\n${detail}\n\n` +
          `修复：把该 origin 登记到 src/context/internal-message.ts 的 INTERNAL_ORIGINS，` +
          `并确认它确实该在 TUI 隐藏；或改用 buildInternalMessage/markInternal 构造。`,
      );
    }
  });

  // 判据自证：三条一组，前两条证明「不再误报」，第三条证明「没有因此变松」。
  // 缺了第三组，收窄正则的风险就是"把真注入点也一起漏掉"，而门禁照样全绿。
  test("不误报：领域字段 origin 不算内部消息 origin", () => {
    const text = [
      `const task: CronTask = { id: "x", origin: "cron_create" };`,
      `const err = { origin: "network", arrival: "thrown" };`,
      `const msg = { role: "user", _meta: { origin: "compact-summary" } };`,
    ].join("\n");
    expect(collectMetaOrigins(text)).toEqual(["compact-summary"]);
  });

  test("不误报：_meta 对象之后别的对象里的 origin 不算", () => {
    const text = `const x = { _meta: { foo: 1 }, other: { origin: "not-internal" } };`;
    expect(collectMetaOrigins(text)).toEqual([]);
  });

  test("仍能抓到：多行 _meta 对象内的 origin", () => {
    const text = [
      "const msg = {",
      '  role: "user",',
      "  _meta: {",
      "    isMeta: true,",
      '    origin: "promise-nudge",',
      "  },",
      "};",
    ].join("\n");
    expect(collectMetaOrigins(text)).toEqual(["promise-nudge"]);
  });
});

describe("隐藏行为：白名单 origin 的消息被判定隐藏", () => {
  test("每个登记的整条隐藏 origin 都让消息整条隐藏", () => {
    for (const origin of INTERNAL_ORIGINS) {
      const msg = buildInternalMessage(origin, "assistant", "了解，继续。");
      expect(isHiddenFromDisplay(msg)).toBe(true);
    }
  });

  test("专用渲染 origin（task-notification/command-expansion）不被整条隐藏（回归守卫）", () => {
    // 回归：这两类走专用渲染分流，若被塞进 INTERNAL_ORIGINS 会被 isHiddenFromDisplay
    // 误吞导致渲染丢失（task_notification 折叠项 / 命令名消失）。
    for (const origin of INTERNAL_RENDER_ORIGINS) {
      const msg = buildInternalMessage(origin, "user", "内容", { isMeta: true });
      expect(isHiddenFromDisplay(msg)).toBe(false);
    }
  });

  test("同款 ack 文案但无 origin 标记 → 不被误隐藏（只认标记不认文案）", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "了解，继续。" }],
    };
    expect(isHiddenFromDisplay(msg)).toBe(false);
  });
});
