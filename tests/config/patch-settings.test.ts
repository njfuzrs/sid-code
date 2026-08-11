/**
 * patchSettingsFile 回归测试
 *
 * 防止 persistKnob（/effort -p、/think -p）写回 settings.json 时因 Zod round-trip
 * strip 掉 availableModels[] 中的 api_key/base_url（snake_case）导致密钥丢失。
 *
 * 根因：ModelConfigSchema 无 .passthrough()，旧 persistKnob 走
 * getSettingsForSource → parseSettingsFile → SettingsSchema().safeParse() 有损解析后
 * 整体覆盖写回，顺手抹掉了 schema 未声明的嵌套字段。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// 用 SID_CONFIG_DIR 隔离测试，不碰真实用户配置
const TEST_HOME = join("/tmp", `sid-code-patch-test-${process.pid}`);
const SETTINGS_PATH = join(TEST_HOME, "settings.json");
/** 进程原有的 SID_CONFIG_DIR（可能是 preload 设的隔离兜底），afterEach 要还回去 */
const prevConfigDir = process.env.SID_CONFIG_DIR;

// 含 snake_case 密钥的典型配置（用户常见写法）
const ORIGINAL_SETTINGS = {
  model: "deepseek-v4-pro",
  fallbackModel: "deepseek-v4-flash",
  availableModels: [
    {
      name: "deepseek-v4-pro",
      provider: "openai",
      api_key: "${DEEPSEEK_API_KEY}",
      base_url: "https://api.deepseek.com/v1",
    },
    {
      name: "gpt-5.4",
      provider: "openai",
      apiKey: "sk-camel-key",
      baseURL: "https://openai.example.com/v1",
    },
  ],
  language: "zh",
  customField: "should-survive",
};

describe("patchSettingsFile", () => {
  beforeEach(() => {
    // 设置隔离目录
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(ORIGINAL_SETTINGS, null, 2));
  });

  afterEach(() => {
    // 恢复原值而非无条件 delete（见 tests/preload-isolate-sid-home.ts）：
    // 同进程后续测试文件会依赖 preload 设的隔离兜底，删了就写进真实 HOME。
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("写入新字段不丢失 snake_case 密钥（根因回归）", async () => {
    // 动态 import 以拿到 env 覆盖后的路径
    const { patchSettingsFile } = await import("@sid-code/core/config/settings/index.ts");

    patchSettingsFile("userSettings", "effortLevel", "max");

    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    // 新字段写入
    expect(after.effortLevel).toBe("max");
    // snake_case 密钥保留（这正是旧代码丢失的字段）
    expect(after.availableModels[0].api_key).toBe("${DEEPSEEK_API_KEY}");
    expect(after.availableModels[0].base_url).toBe("https://api.deepseek.com/v1");
    // camelCase 密钥也保留
    expect(after.availableModels[1].apiKey).toBe("sk-camel-key");
    expect(after.availableModels[1].baseURL).toBe("https://openai.example.com/v1");
  });

  test("env 占位符不被展开成明文写回", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-real-secret-12345";
    const { patchSettingsFile } = await import("@sid-code/core/config/settings/index.ts");

    patchSettingsFile("userSettings", "thinkingEnabled", true);

    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    // 占位符仍是占位符，没被展开成明文
    expect(after.availableModels[0].api_key).toBe("${DEEPSEEK_API_KEY}");
    delete process.env.DEEPSEEK_API_KEY;
  });

  test("删除字段(value=undefined)不影响其它内容", async () => {
    // 先写入一个字段
    const withEffort = { ...ORIGINAL_SETTINGS, effortLevel: "max" };
    writeFileSync(SETTINGS_PATH, JSON.stringify(withEffort, null, 2));

    const { patchSettingsFile } = await import("@sid-code/core/config/settings/index.ts");
    patchSettingsFile("userSettings", "effortLevel", undefined);

    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(after.effortLevel).toBeUndefined();
    // 其它字段完好
    expect(after.availableModels[0].api_key).toBe("${DEEPSEEK_API_KEY}");
    expect(after.customField).toBe("should-survive");
  });

  test("文件不存在时正常创建", async () => {
    rmSync(SETTINGS_PATH, { force: true });
    const { patchSettingsFile } = await import("@sid-code/core/config/settings/index.ts");

    patchSettingsFile("userSettings", "effortLevel", "high");

    expect(existsSync(SETTINGS_PATH)).toBe(true);
    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(after).toEqual({ effortLevel: "high" });
  });

  test("schema 外的顶层自定义字段保留（.passthrough 语义）", async () => {
    const { patchSettingsFile } = await import("@sid-code/core/config/settings/index.ts");

    patchSettingsFile("userSettings", "effortLevel", "low");

    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(after.customField).toBe("should-survive");
  });

  test("同会话内连续两次 patch 不丢字段（单来源缓存失效回归）", async () => {
    // 根因回归：patchSettingsFile 收尾曾用 setCachedSource(source, null)，而 getCachedSource
    // 把 null 当作"已缓存且该来源无设置"命中返回。于是同会话第二次 read-then-patch 读到 null、
    // 从空对象起步，整体覆盖掉第一次写入的字段（/skills、/mcp、/allow、/hooks 等 read-then-patch
    // 命令连续两次 -p 就会丢数据）。修复：改用 clearCachedSource 删键，强制下次读盘。
    const { patchSettingsFile, getSettingsForSource } = await import("@sid-code/core/config/settings/index.ts");

    // 第一次：追加 skill-a
    {
      const { settings } = getSettingsForSource("userSettings");
      const disabled = new Set<string>(settings?.disabledSkills ?? []);
      disabled.add("skill-a");
      patchSettingsFile("userSettings", "disabledSkills", [...disabled]);
    }
    // 第二次：追加 skill-b（关键：这里 read 必须读到含 skill-a 的最新盘内容，而非缓存的 null）
    {
      const { settings } = getSettingsForSource("userSettings");
      const disabled = new Set<string>(settings?.disabledSkills ?? []);
      disabled.add("skill-b");
      patchSettingsFile("userSettings", "disabledSkills", [...disabled]);
    }

    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    // 两个 skill 都在 —— 修复前 skill-a 会被第二次写入覆盖丢失
    expect(after.disabledSkills).toContain("skill-a");
    expect(after.disabledSkills).toContain("skill-b");
    // 原有字段照旧完好
    expect(after.customField).toBe("should-survive");
    expect(after.availableModels[0].api_key).toBe("${DEEPSEEK_API_KEY}");
  });
});

// ─── SEC-AUDIT-2026-07-19 P2：writeSettingsFile 运行时护栏 ───────────────────
//
// 背景：writeSettingsFile 的 JSDoc 长期写着"绝大多数场景应改用 patchSettingsFile"，
// 但那只是注释——没读过文档的调用方照样能把 resolveEnvVars 展开后的明文密钥落盘。
// 现在改为运行时 fail-closed：检测到明文凭证直接抛错。
describe("writeSettingsFile 明文凭证护栏", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    if (!existsSync(TEST_HOME)) mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("含明文 API key 时抛错且不落盘", async () => {
    const { writeSettingsFile } = await import("@sid-code/core/config/settings/settings.ts");
    const withPlaintext = {
      model: "gpt-5.4",
      availableModels: [
        { name: "gpt-5.4", provider: "openai", api_key: "sk-abcdefghij0123456789xyz" },
      ],
    } as any;

    expect(() => writeSettingsFile("userSettings", withPlaintext)).toThrow(/明文凭证/);
    // 关键：抛错发生在写盘之前，文件不该被创建
    expect(existsSync(SETTINGS_PATH)).toBe(false);
  });

  test("占位符形态正常写入（这是我们希望的写法）", async () => {
    const { writeSettingsFile } = await import("@sid-code/core/config/settings/settings.ts");
    const withPlaceholder = {
      model: "deepseek-v4-pro",
      availableModels: [
        { name: "deepseek-v4-pro", provider: "openai", api_key: "${DEEPSEEK_API_KEY}" },
      ],
    } as any;

    expect(() => writeSettingsFile("userSettings", withPlaceholder)).not.toThrow();
    const written = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(written.availableModels[0].api_key).toBe("${DEEPSEEK_API_KEY}");
  });

  test("无凭证的普通配置正常写入", async () => {
    const { writeSettingsFile } = await import("@sid-code/core/config/settings/settings.ts");
    expect(() =>
      writeSettingsFile("userSettings", { model: "claude-opus", theme: "dark" } as any),
    ).not.toThrow();
    expect(JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")).model).toBe("claude-opus");
  });
});
