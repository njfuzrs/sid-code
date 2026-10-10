/**
 * B32：settings 未知顶层键告警 + passthrough 字段入 schema。
 *
 * 防的是「拼错静默不生效」：用户写 `autoMemroy: false` 想关后台提取，此前什么都不发生。
 * 两个方向都要锁：拼错要报（召回），合法字段不能报（误报 —— 一旦误报，用户会学会无视横幅）。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@sid-code/core/config/config.ts";
import { SettingsSchema } from "@sid-code/core/config/settings/types.ts";
import { findUnknownSettingKeys } from "@sid-code/core/config/settings/validation.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/index.ts";
import { levenshteinDistance } from "@sid-code/core/tool/path-utils.ts";

/** 在隔离的 SID_CONFIG_DIR 下用给定 settings.json 跑一次 loadConfig，返回未知键提示 */
async function unknownKeyWarnings(settings: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "sid-b32-"));
  const saved = process.env.SID_CONFIG_DIR;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
    process.env.SID_CONFIG_DIR = dir;
    resetSettingsCache();
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    return (cfg._validationDiagnostics?.warnings ?? []).filter((w) =>
      w.message.startsWith("未知配置项"),
    );
  } finally {
    if (saved === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = saved;
    resetSettingsCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("B32 未知顶层键告警", () => {
  test("拼错的字段进启动提示，并建议正确拼写", async () => {
    const hits = await unknownKeyWarnings({ autoMemroy: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toEndWith("settings.json#autoMemroy");
    expect(hits[0]!.message).toContain("「autoMemory」");
  });

  test("合法字段不报：schema 声明的、原 passthrough 的、snake_case 别名、$schema", async () => {
    const hits = await unknownKeyWarnings({
      $schema: "https://example.com/settings.schema.json",
      language: "zh",
      autoMemory: false,
      toolSearch: "auto",
      trace: { enabled: true },
      bridge: { enabled: false },
      sandboxAutoAllowBash: false,
      max_thinking_tokens: 2048,
    });
    expect(hits).toEqual([]);
  });

  test("离得远的键不硬给建议（短键不能乱配）", () => {
    const declared = Object.keys(SettingsSchema().shape);
    const known = new Set(declared);
    const [u] = findUnknownSettingKeys({ xyz: 1 }, known, declared, levenshteinDistance);
    expect(u).toEqual({ key: "xyz" });
  });

  test("大小写拼错也能建议", () => {
    const declared = Object.keys(SettingsSchema().shape);
    const [u] = findUnknownSettingKeys(
      { automemory: true },
      new Set(declared),
      declared,
      levenshteinDistance,
    );
    expect(u!.suggestion).toBe("autoMemory");
  });
});

describe("B32 passthrough 字段入 schema", () => {
  // 原 ref/settings.md 上 26 个标 ⚠ 的字段 + 漏登记的 bridge
  const FORMER_PASSTHROUGH = [
    "trace",
    "telemetry",
    "analytics",
    "ide",
    "bridge",
    "teamMemory",
    "sessionRetention",
    "checkpoint",
    "toolSearch",
    "pluginDirs",
    "showLineNumbers",
    "goal",
    "enableSandbox",
    "sandboxAutoAllowBash",
    "outputStyle",
    "speculativeClassifier",
    "autoDream",
    "autoMemory",
    "conflictDetection",
    "conflictSeverity",
    "mcpPolicy",
    "toolSearchKeepLoaded",
    "audit",
    "auditLogFile",
    "debug",
    "debugLevel",
    "debugLogFile",
  ];

  test("全部已声明", () => {
    const shape = SettingsSchema().shape as Record<string, unknown>;
    expect(FORMER_PASSTHROUGH.filter((k) => !(k in shape))).toEqual([]);
  });

  test("toolSearch 三种运行时取值都接受（不比 parseToolSearchConfig 更严）", () => {
    for (const v of [true, false, "auto", 30]) {
      expect(SettingsSchema().safeParse({ toolSearch: v }).success).toBe(true);
    }
  });

  test("对象字段的子键原样保留（子结构由消费点解析，schema 不剥）", () => {
    const r = SettingsSchema().safeParse({ trace: { enabled: true, upload: { url: "x" } } });
    expect(r.success).toBe(true);
    expect((r as any).data.trace).toEqual({ enabled: true, upload: { url: "x" } });
  });
});
