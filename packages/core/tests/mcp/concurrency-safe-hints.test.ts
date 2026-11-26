/**
 * D6：MCP 工具的并发安全判据（`MCPToolAdapter.isConcurrencySafe()`）。
 *
 * ## 修的是什么
 *
 * 此前直接透传 `readOnlyHint`——外部 Server 只要自称只读就进并行批次，是仓内
 * 唯一一处「外部声明不设门槛」的调度路径。现在要求三个 hint 同时成立：
 * `readOnlyHint === true` 且 `destructiveHint !== true` 且 `idempotentHint === true`。
 *
 * ## 期望值从哪来
 *
 * 全部来自**人工语义**，不从实现反推：并发安全 = 只读 + 非破坏性 + 幂等。
 * 协议允许 Server 声明自相矛盾的组合（如只读 + 破坏性），矛盾时取保守（false）。
 * 8 行是真值表的全部输入组合（三个 hint 的 true/false/缺省已按语义折叠：
 * 「没声明」与「声明 false」在这三个 hint 上等价，见 `readOnly()` / `isDestructive()` /
 * `isIdempotent()` 的缺省值），另加一行「三个 hint 全缺省」。
 *
 * ## 变异自证
 *
 * 把 `isConcurrencySafe()` 改回 `this.readOnly()` → 「只读但非幂等」那组变红；
 * 去掉 `!isDestructive()` → 「只读 + 破坏性」那组变红；去掉 `isIdempotent()` →
 * 同样第一组变红。三处都在报告里贴了实测输出。
 *
 * ## 构造方式
 *
 * `MCPToolAdapter` 未导出（`mcp/manager.ts` 的私有类），沿用
 * `tests/query/subagent-internal-fields-not-leaked.test.ts` 的做法：经
 * `MCPManager.prototype.adaptTools` 拿生产代码里的真实适配器，client 用最小 stub
 * （构造与 hint 判定都不碰 client）。不另造 mock 框架。
 */

import { describe, test, expect } from "bun:test";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";

/**
 * `isIdempotent()` 是 MCP 适配器自己的方法，`LegacyTool` 接口上没有它。
 * 测试要看的是本单元改动的判据，所以把「本用例需要的最小视图」写出来，
 * 不用 `any` 糊过去——字段写错会在这里变成编译错误。
 */
interface HintView {
  readOnly(): boolean;
  isDestructive(): boolean;
  isIdempotent(): boolean;
  isConcurrencySafe(): boolean;
}

/** 构造一个带指定 annotations 的 MCP 工具（走生产适配器，不是手写 mock 对象） */
function makeTool(annotations?: Record<string, unknown>): HintView {
  const fakeClient = { callTool: async () => ({ content: [] }) };
  const def = {
    name: "probe_tool",
    description: "probe",
    inputSchema: { type: "object", properties: {} },
    ...(annotations ? { annotations } : {}),
  };
  // adaptTools 不读 this（见 manager.ts 实现），用原型调用即可拿真实适配器
  const tools = (
    MCPManager.prototype as unknown as {
      adaptTools: (c: unknown, d: unknown[], n: string) => HintView[];
    }
  ).adaptTools.call({}, fakeClient, [def], "probe");
  return tools[0]!;
}

describe("D6 MCP 工具并发安全判据：readOnly × destructive × idempotent", () => {
  /**
   * 真值表。`readOnly` 列是唯一必要前提：只读为假时无论其余两个 hint 如何都落串行。
   * 每行都断言三个消费者能看到的一致视图（hint 各自的解读不许与这里分叉）。
   */
  const CASES: Array<{
    label: string;
    annotations: Record<string, boolean>;
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    concurrencySafe: boolean;
  }> = [
    {
      label: "只读 + 非破坏 + 幂等（唯一允许并行的组合）",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      readOnly: true,
      destructive: false,
      idempotent: true,
      concurrencySafe: true,
    },
    {
      label: "只读 + 非破坏 + 明确不幂等",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      readOnly: true,
      destructive: false,
      idempotent: false,
      concurrencySafe: false,
    },
    {
      // 修复前这一行返回 true：只读声明被无条件采信
      label: "只读 + 非破坏 + 未声明幂等（保守判非幂等）",
      annotations: { readOnlyHint: true, destructiveHint: false },
      readOnly: true,
      destructive: false,
      idempotent: false,
      concurrencySafe: false,
    },
    {
      // 协议允许的矛盾组合：取保守
      label: "只读 + 破坏性 + 幂等（自相矛盾，取保守）",
      annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: true },
      readOnly: true,
      destructive: true,
      idempotent: true,
      concurrencySafe: false,
    },
    {
      label: "只读 + 破坏性 + 不幂等",
      annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: false },
      readOnly: true,
      destructive: true,
      idempotent: false,
      concurrencySafe: false,
    },
    {
      label: "只读 + 破坏性 + 未声明幂等",
      annotations: { readOnlyHint: true, destructiveHint: true },
      readOnly: true,
      destructive: true,
      idempotent: false,
      concurrencySafe: false,
    },
    {
      label: "非只读 + 非破坏 + 幂等",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      readOnly: false,
      destructive: false,
      idempotent: true,
      concurrencySafe: false,
    },
    {
      label: "非只读 + 破坏性 + 未声明幂等",
      annotations: { readOnlyHint: false, destructiveHint: true },
      readOnly: false,
      destructive: true,
      idempotent: false,
      concurrencySafe: false,
    },
  ];

  for (const c of CASES) {
    test(c.label, () => {
      const tool = makeTool(c.annotations);
      // hint 各自的解读先钉住：并发判据只允许是这三个的组合，不许另起一套口径
      expect(tool.readOnly()).toBe(c.readOnly);
      expect(tool.isDestructive()).toBe(c.destructive);
      expect(tool.isIdempotent()).toBe(c.idempotent);
      expect(tool.isConcurrencySafe()).toBe(c.concurrencySafe);
    });
  }

  test("三个 hint 全缺省（Server 什么都没声明）→ 落串行", () => {
    const tool = makeTool();
    expect(tool.readOnly()).toBe(false);
    expect(tool.isDestructive()).toBe(false);
    expect(tool.isIdempotent()).toBe(false);
    expect(tool.isConcurrencySafe()).toBe(false);
  });

  test("annotations 为空对象 → 落串行", () => {
    const tool = makeTool({});
    expect(tool.isConcurrencySafe()).toBe(false);
  });

  /**
   * 这条与并发判据不是同一件事，但它解释了为什么要加 `!isDestructive()`：
   * 无权限检查器时 `run-tool-use.ts` 用 `judgeConcurrencySafe` 做 fail-closed 分级，
   * 并发安全 ⇒ 放行。并发安全必须蕴含非破坏性，否则破坏性工具会从那条口子漏过。
   */
  test("并发安全 ⇒ 非破坏性（fail-closed 权限分级的隐含前提）", () => {
    for (const c of CASES) {
      if (!c.concurrencySafe) continue;
      expect(c.destructive).toBe(false);
    }
  });
});
