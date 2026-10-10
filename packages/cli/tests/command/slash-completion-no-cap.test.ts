/**
 * 斜杠补全不得在数据层截断。
 *
 * 此前 useSlashCompletion 传 limit=20，而内置命令已 30 条：输入 "/" 时列表显示
 * 「20 条结果」，排在后面的命令无论怎么 ↑↓ 都翻不到。可见行数由
 * SuggestionsDisplay 的 MAX_VISIBLE 虚拟滚动负责，数据层只排序不截断。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toCompletionEntries } from "@sid-code/cli/command/completion-list.ts";
import { rankCommandInfos } from "@sid-code/cli/command/suggestions.ts";
import { BUILTIN_COMMANDS } from "@sid-code/cli/command/commands/index.ts";

describe("斜杠补全不截断", () => {
  test("空查询返回全部命令（且命令数确实超过旧上限 20）", () => {
    const entries = toCompletionEntries(BUILTIN_COMMANDS);
    // 排除「命令数 ≤ 20 时旧实现也能全绿」
    expect(entries.length).toBeGreaterThan(20);
    expect(rankCommandInfos(entries, "")).toHaveLength(entries.length);
  });

  test("模糊查询不截断：命中数超过 20 时全部返回", () => {
    // 合成 40 条同前缀命令，保证命中数 > 20
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `zz${String(i).padStart(2, "0")}`,
      aliases: [],
      description: "",
    }));
    expect(rankCommandInfos(many, "zz")).toHaveLength(40);
  });

  test("skill 命令（排序靠后）在空查询下也全部可见", () => {
    // 复现形态：30 条内置 + 17 个 skill 时旧上限 20 只露出 1 个 skill，
    // 用户误以为「skill 没变成命令」——实际已注册、可执行，只是补全里翻不到。
    const builtin = toCompletionEntries(BUILTIN_COMMANDS);
    const skills = Array.from({ length: 10 }, (_, i) => ({
      name: `zzz-skill-${i}`,
      aliases: [],
      description: "Skill",
    }));
    const labels = rankCommandInfos([...builtin, ...skills], "").map((r) => r.label);
    for (const s of skills) expect(labels).toContain(`/${s.name}`);
  });

  test("useSlashCompletion 调用点不传数字 limit", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/ui/hooks/useSlashCompletion.ts"),
      "utf8",
    );
    expect(src).toMatch(/rankCommandInfos\(commands, target\.query\)/);
  });
});
