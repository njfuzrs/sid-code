/**
 * 内部消息来源 —— 防漂移哨兵测试
 *
 * 对标本项目 `ABORT_REASONS` 的防漂移哨兵套路：把"内部注入消息不泄漏到 TUI"从
 * "开发者自觉打标记"变成"机制强制 + 测试兜底"。
 *
 * 三道防线：
 *  1. helper 契约：markInternal / buildInternalMessage 打的标记能被 hasInternalOrigin 识别，
 *     且类型系统限制 origin 只能取白名单内的值。
 *  2. 源码扫描（核心）：扫描 src/ 下所有手写 `origin: "…"` 字面量注入点，断言每个 origin
 *     都已在 INTERNAL_ORIGINS 登记。任何人新增一个未登记的内部 origin → 本测试失败，
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

  test('所有手写 `_meta: { origin: "…" }` 的字面量 origin 都已登记到 INTERNAL_ORIGINS', () => {
    // P2-2 分包：生产源码分布在 4 个包，全扫。只扫一个包会让哨兵半瞎且不报错。
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
    const files = ["shared", "tui-renderer", "core", "cli"].flatMap((p) =>
      collectSourceFiles(join(repoRoot, "packages", p, "src")),
    );
    // 防空转：路径指错时会扫到 0 个文件而假绿。
    expect(files.length).toBeGreaterThan(500);

    // 匹配 `origin: "xxx"` / `origin: 'xxx'`（紧跟在 _meta 上下文里的内联来源标记）。
    // 只关心字符串字面量形式——REATTACH_ORIGIN 等常量引用由 helper/类型系统保证，不在扫描列。
    const ORIGIN_LITERAL = /origin:\s*["']([^"']+)["']/g;
    // 已知内部来源 = 整条隐藏类 + 专用渲染类。两类都算"已登记"，未登记才算漂移。
    const whitelist = new Set<string>([...INTERNAL_ORIGINS, ...INTERNAL_RENDER_ORIGINS]);

    const violations: Array<{ file: string; origin: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(ORIGIN_LITERAL)) {
        const origin = m[1];
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
