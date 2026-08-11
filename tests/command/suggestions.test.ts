/**
 * 命令补全建议引擎测试（Task 5）
 */

import { describe, test, expect } from "bun:test";
import {
  rankCommandInfos,
  type RankableCommandInfo,
} from "@sid-code/cli/command/suggestions.ts";

const COMMANDS: RankableCommandInfo[] = [
  { name: "compact", aliases: [], description: "压缩对话历史" },
  { name: "config", aliases: [], description: "显示当前配置" },
  { name: "commit", aliases: [], description: "提交代码改动" },
  { name: "clear", aliases: [], description: "清空对话" },
  { name: "exit", aliases: ["quit", "q"], description: "退出程序" },
  { name: "model", aliases: ["m"], description: "显示或切换模型" },
];

describe("rankCommandInfos", () => {
  test("精确名称匹配排第一", () => {
    const r = rankCommandInfos(COMMANDS, "compact");
    expect(r[0].label).toBe("/compact");
  });

  test("精确别名匹配命中并标注别名", () => {
    const r = rankCommandInfos(COMMANDS, "q");
    expect(r[0].label).toBe("/exit");
    expect(r[0].description).toContain("(q)");
  });

  test("前缀匹配返回所有候选，短名优先", () => {
    const r = rankCommandInfos(COMMANDS, "co");
    const labels = r.map((s) => s.label);
    // compact / config / commit 都以 co 开头
    expect(labels).toContain("/compact");
    expect(labels).toContain("/config");
    expect(labels).toContain("/commit");
  });

  test("模糊匹配：漏字母也能命中", () => {
    const r = rankCommandInfos(COMMANDS, "cmpct");
    const labels = r.map((s) => s.label);
    expect(labels).toContain("/compact");
  });

  test("空查询返回全部命令", () => {
    const r = rankCommandInfos(COMMANDS, "");
    expect(r.length).toBe(COMMANDS.length);
  });

  test("limit 限制返回条数", () => {
    const r = rankCommandInfos(COMMANDS, "", 2);
    expect(r.length).toBe(2);
  });

  test("value 带尾随空格便于继续输入参数", () => {
    const r = rankCommandInfos(COMMANDS, "model");
    expect(r[0].value).toBe("/model ");
  });

  test("无匹配返回空数组", () => {
    const r = rankCommandInfos(COMMANDS, "zzzzzznotacommand");
    expect(r.length).toBe(0);
  });

  test("requiresArgs 透传（匹配路径）——决定补全列表回车是执行还是回填", () => {
    const cmds: RankableCommandInfo[] = [
      { name: "btw", aliases: [], description: "旁路提问", requiresArgs: true },
      { name: "model", aliases: [], description: "切换模型" }, // 未标记 = undefined
    ];
    const btw = rankCommandInfos(cmds, "btw")[0];
    expect(btw.requiresArgs).toBe(true);
    const model = rankCommandInfos(cmds, "model")[0];
    // 无参命令：undefined（falsy）→ UI 视为可直接执行
    expect(model.requiresArgs).toBeFalsy();
  });

  test("requiresArgs 透传（空查询路径）", () => {
    const cmds: RankableCommandInfo[] = [
      { name: "btw", aliases: [], description: "旁路提问", requiresArgs: true },
      { name: "clear", aliases: [], description: "清空对话" },
    ];
    const all = rankCommandInfos(cmds, "");
    expect(all.find((s) => s.label === "/btw")?.requiresArgs).toBe(true);
    expect(all.find((s) => s.label === "/clear")?.requiresArgs).toBeFalsy();
  });
});
