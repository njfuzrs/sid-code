/**
 * D5（T8，2026-11-15）：`bg_task_get` 并入 `task_output` 后的旧名兼容。
 *
 * 退役一个模型可见的工具名是破坏性契约变更：历史会话、模型记忆、用户
 * `disallowedTools` 配置里都还可能出现旧名。两层兜底必须同时生效——
 *   1. 注册表 `aliases`：`get("bg_task_get")` 能拿到 task_output 实例（模型仍能调）；
 *   2. 归一表 `RETIRED_INTERNAL_TOOL_NAMES`：权限规则 / hook matcher / 子代理黑名单
 *      按内部名比较，旧名必须归一到现行名，否则这些名单对旧名静默失效。
 */

import { describe, test, expect } from "bun:test";
import { Registry } from "../../src/tool/registry.ts";
import { TaskOutputTool } from "../../src/tool/task-output.ts";
import {
  RETIRED_INTERNAL_TOOL_NAMES,
  toCcToolName,
  toInternalToolName,
} from "../../src/tool/tool-name-aliases.ts";

describe("D5（T8）：bg_task_get 退役后的旧名兼容", () => {
  test("注册表别名：get('bg_task_get') 解析到 task_output 实例", () => {
    const registry = new Registry();
    const tool = new TaskOutputTool();
    registry.register(tool);
    expect(registry.get("bg_task_get")).toBe(tool);
    expect(registry.get("task_output")).toBe(tool);
  });

  test("归一表：旧名 → 现行名，权限/hook/子代理名单同一口径", () => {
    expect(RETIRED_INTERNAL_TOOL_NAMES.bg_task_get).toBe("task_output");
    expect(toInternalToolName("bg_task_get")).toBe("task_output");
    // 大小写不敏感（权限规则允许任意大小写写法）
    expect(toInternalToolName("BG_TASK_GET")).toBe("task_output");
  });

  test("反查不受影响：task_output 的 CC 名仍是 TaskOutput", () => {
    expect(toCcToolName("task_output")).toBe("TaskOutput");
    // 退役名不参与反查（它不是 CC 名，也不该被当成现行工具对外呈现）
    expect(toCcToolName("bg_task_get")).toBeUndefined();
  });
});
