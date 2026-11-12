/**
 * D12：`--dump-tool-meta` 出口与 `tests/helpers/builtin-tool-meta.ts` 的自证。
 *
 * 这条测试是「门禁的门禁」：T3（zodSchema 全量覆盖）、T5（strict 预算）、T6（前缀碰撞
 * 改用真实注册表）都从这同一个出口取数。出口本身错了，那三条门禁会一起失明，
 * 而且是恒绿式失明——所以在这里把「注册表全集 + 延迟分组」先钉住。
 *
 * 数字（42 / 18 / `["notebook_edit"]`）是 2026-11-12 的基线，硬编码是刻意的：
 * 增删内置工具、改变延迟分层或补完 zodSchema 时，应当有人停下来确认下游门禁要不要跟进。
 * 它们变红不代表出口坏了，而是提醒「真实注册表变了」。
 */

import { describe, expect, test } from "bun:test";
import { builtinToolMeta } from "../helpers/builtin-tool-meta.ts";

describe("--dump-tool-meta：门禁取真实注册表的出口", () => {
  const meta = builtinToolMeta();

  test("每条都带齐 5 个字段且类型正确", () => {
    for (const t of meta) {
      expect(t.name.length, `工具名不能为空: ${JSON.stringify(t)}`).toBeGreaterThan(0);
      expect(typeof t.deferred, `deferred 应是 boolean: ${t.name}`).toBe("boolean");
      expect(typeof t.strict, `strict 应是 boolean: ${t.name}`).toBe("boolean");
      expect(typeof t.strictPriority, `strictPriority 应是 number: ${t.name}`).toBe("number");
      expect(typeof t.hasZodSchema, `hasZodSchema 应是 boolean: ${t.name}`).toBe("boolean");
    }
  });

  test("按名字码点序排列（不受注册顺序与 locale 影响）", () => {
    const names = meta.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  test("内置工具全集 42 个（与 --dump-tools 同口径）", () => {
    expect(meta.length).toBe(42);
  });

  test("延迟 18 个、常驻 24 个", () => {
    const deferred = meta.filter((t) => t.deferred).map((t) => t.name);
    expect(deferred.length).toBe(18);
    expect(meta.length - deferred.length).toBe(24);
  });

  test("含 dump 前补注册的两个 MCP 资源工具（与 --dump-tools 共用注册补齐）", () => {
    const names = meta.map((t) => t.name);
    // 这两个工具的真实注册受 `if (mcpManager)` 包裹，紧跟在 dump 之后才发生；
    // 出口漏掉它们，常驻集就少 2 个，T5 的 strict 预算门禁会算错最坏情况。
    expect(names).toContain("ListMcpResources");
    expect(names).toContain("ReadMcpResource");
  });

  test("hasZodSchema 只有 notebook_edit 是 false（T3 补完后这里应为空）", () => {
    expect(meta.filter((t) => !t.hasZodSchema).map((t) => t.name)).toEqual(["notebook_edit"]);
  });

  test("strict 与 strictPriority 反映真实声明", () => {
    const byName = new Map(meta.map((t) => [t.name, t]));
    // 内置工具全部发 strict；MCP 工具与 StructuredOutput 走另一条路径，不在 dump 里。
    expect(meta.filter((t) => !t.strict).map((t) => t.name)).toEqual([]);
    // 已声明的优先级（T5 的 strict 预算按它排序，值错了降级名单就错）
    expect(byName.get("ask_user_question")?.strictPriority).toBe(100);
    for (const name of ["edit", "write", "notebook_edit"]) {
      expect(byName.get(name)?.strictPriority, `${name} 应为 50`).toBe(50);
    }
    // 未声明 = 0（types.ts 里 strictPriority 的契约）
    expect(byName.get("read")?.strictPriority).toBe(0);
  });
});
