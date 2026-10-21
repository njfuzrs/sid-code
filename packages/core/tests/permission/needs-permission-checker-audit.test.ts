/**
 * 子代理工具权限检查器对账审计（M-1，P0-1/P1-1 防复发）
 *
 * 背景：checker 注入是鸭子类型探测（app.ts wireToolPermissionChecker 对
 * `setPermissionChecker` 做 `typeof === "function"` 判断）——工具不实现该方法就被
 * **静默跳过**。WorkflowTool / SendMessageTool 正是这样漏掉的（P0-1/P1-1）：
 * workflow 编排的子代理与 send_message 恢复的后台 agent 全部落到 B0 分级 fail-closed
 * （写类全拒），症状只是子代理自述「权限拒绝: 未配置权限检查器」。
 *
 * 本审计把「自报 ↔ 实现」的**双向一致性**codify 成测试（对齐
 * loop-detection-exemption-audit.test.ts 的范式）：
 *   1. 【无缺声明】凡实现 setPermissionChecker 方法定义的工具类，必须自报
 *      needsPermissionChecker = true——否则将来 setter 被误删时又变回静默失效。
 *   2. 【无假声明】凡自报 needsPermissionChecker = true 的，必须有 setter 实现
 *      ——wire 层的告警对账（app.ts）管运行时，这里管源码静态一致性。
 *   3. 【锚定当前集合】自报文件集合 === 已知 7 个子代理入口文件，增删都要过 review。
 *
 * 排除项：agent/sub-agent.ts 的 SubAgent 本身不是工具（它是被注入方，setter 签名
 * `(checker: Checker | null)`），不在扫描范围。forked-command.ts 里的
 * `subAgent.setPermissionChecker(...)` 是调用形态（行首是接收者），不会被
 * 方法定义正则命中。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CORE_SRC = join(REPO_ROOT, "packages", "core", "src");
const TOOL_SRC_DIRS = [
  join(CORE_SRC, "tool"),
  join(CORE_SRC, "agent"),
  join(CORE_SRC, "skill"),
  join(CORE_SRC, "skill", "bundled"),
];
/** SubAgent 是被注入方不是工具类（setter 语义是"接收 checker"而非"转发给子代理"） */
const EXCLUDED_FILES = new Set(["sub-agent.ts"]);

interface ToolEntry {
  /** 相对 packages/core/src 的文件路径（锚定集合用） */
  relPath: string;
  /** 自报 needsPermissionChecker = true */
  declares: boolean;
  /**
   * 实现了 setPermissionChecker(...) 方法定义。正则说明：
   * - 行首缩进 + 方法名开头：排除 `subAgent.setPermissionChecker(...)` 调用形态
   * - 参数用贪婪 .+ 跨过 import("...").Checker 里的嵌套括号，吃到行尾最后一个 ")"
   * - 尾缀 `: void`：types.ts 注释里的字面量 "setPermissionChecker(checker)" 无此尾缀
   */
  implementsSetter: boolean;
}

function scanToolSources(): ToolEntry[] {
  const entries: ToolEntry[] = [];
  for (const dir of TOOL_SRC_DIRS) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      if (EXCLUDED_FILES.has(file)) continue;
      const src = readFileSync(join(dir, file), "utf8");
      // 接口定义（types.ts）写的是 `needsPermissionChecker?: boolean`，不会被命中
      const declares = /needsPermissionChecker\s*=\s*true/.test(src);
      const implementsSetter = /^\s+setPermissionChecker\s*\(.+\)\s*:\s*void/m.test(src);
      if (!declares && !implementsSetter) continue;
      entries.push({
        relPath: join(dir, file).slice(CORE_SRC.length + 1),
        declares,
        implementsSetter,
      });
    }
  }
  return entries;
}

describe("子代理工具权限检查器对账审计（M-1）", () => {
  test("【无缺声明】实现 setPermissionChecker 的工具类必须自报 needsPermissionChecker", () => {
    const scanned = scanToolSources();
    // 防正则漂移扫空后假绿：至少应扫到 7 个已知工具文件
    expect(scanned.length).toBeGreaterThanOrEqual(7);
    const missing = scanned.filter((e) => e.implementsSetter && !e.declares);
    expect(
      missing.map((e) => e.relPath),
      `以下文件实现了 setPermissionChecker 但未自报 needsPermissionChecker=true（将来 setter 被误删时会静默失效）：${missing.map((e) => e.relPath).join(", ")}`,
    ).toEqual([]);
  });

  test("【无假声明】自报 needsPermissionChecker 的必须有 setter 实现", () => {
    const scanned = scanToolSources();
    const fake = scanned.filter((e) => e.declares && !e.implementsSetter);
    expect(
      fake.map((e) => e.relPath),
      `以下文件自报 needsPermissionChecker=true 但没有 setPermissionChecker 方法实现（wire 层会告警）：${fake.map((e) => e.relPath).join(", ")}`,
    ).toEqual([]);
  });

  test("【锚定集合】自报 needsPermissionChecker 的文件集合 === 已知 7 个子代理入口", () => {
    const scanned = scanToolSources()
      .filter((e) => e.declares)
      .map((e) => e.relPath)
      .sort();
    expect(scanned).toEqual(
      [
        "agent/custom.ts", // 自定义 agent 基类（name() 由 def 提供）
        "agent/tool.ts", // sub_agent
        "skill/bundled/tool.ts", // builtin-skill（name() 动态）
        "skill/meta-tool.ts", // skill
        "tool/send-message.ts", // send_message
        "tool/team-create.ts", // team_create
        "tool/workflow.ts", // workflow
      ].sort(),
    );
  });
});
