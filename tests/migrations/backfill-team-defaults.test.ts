/**
 * 团队默认配置补全（迁移 v1）测试
 *
 * 覆盖两条路径的正确性：
 * - mergeMissingTopLevelKeys 单次浅合并：只补缺失顶层键、绝不覆盖已有（含改过的 model /
 *   api_key / 空数组 / env 占位符）。
 * - runMigrations 水位线：每台机器只补一次，用户之后删掉的键不会被反复加回。
 *
 * 用 SID_CONFIG_DIR 隔离，不碰真实用户配置。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { join } from "path";

const TEST_HOME = join("/tmp", `sid-code-backfill-test-${process.pid}`);
const SETTINGS_PATH = join(TEST_HOME, "settings.json");
const MIGRATION_STATE_PATH = join(TEST_HOME, "state", "migrations.json");

// 早期用户的残缺配置：只有 model / fallbackModel / availableModels，缺 subAgentModels /
// search / trace 等后来新增的顶层字段。api_key 用 env 占位符 + 改过的自定义值。
const LEGACY_SETTINGS = {
  model: "my-custom-model",
  fallbackModel: "ali-deepseek-v4-flash",
  availableModels: [
    {
      name: "my-custom-model",
      provider: "openai",
      api_key: "${MY_API_KEY}",
      base_url: "https://custom.example.com/v1",
    },
  ],
  language: "en",
};

/** 进程原有的 SID_CONFIG_DIR（可能是 preload 设的隔离兜底），afterEach 要还回去 */
const prevConfigDir = process.env.SID_CONFIG_DIR;

describe("mergeMissingTopLevelKeys（单次浅合并）", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(LEGACY_SETTINGS, null, 2));
  });

  afterEach(() => {
    // 恢复原值而非无条件 delete：bun test 同进程跑多文件，直接删会把
    // preload 设的隔离兜底（tests/preload-isolate-sid-home.ts）一起抹掉，
    // 导致后续测试文件写进用户真实 ~/.sid-code。实测曾因此泄漏 84 行审计日志。
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("补齐缺失顶层键，且不覆盖用户已有任何字段", async () => {
    const { mergeMissingTopLevelKeys } = await import("@sid-code/core/config/settings/index.ts");
    const defaults = {
      model: "ali-deepseek-v4-pro", // 用户已有 → 不覆盖
      language: "zh", // 用户已有 → 不覆盖
      subAgentModels: { default: "ali-deepseek-v4-flash", task: "ali-deepseek-v4-pro" },
      trace: { enabled: true },
      costLimit: 100,
    };

    const added = mergeMissingTopLevelKeys("userSettings", defaults);

    // 只补了缺失的三个键
    expect(added.sort()).toEqual(["costLimit", "subAgentModels", "trace"]);

    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    // 已有字段原样不动（含用户自定义 model / 改过的 api_key）
    expect(after.model).toBe("my-custom-model");
    expect(after.language).toBe("en");
    expect(after.availableModels[0].api_key).toBe("${MY_API_KEY}");
    expect(after.availableModels[0].base_url).toBe("https://custom.example.com/v1");
    // 缺失字段补入
    expect(after.subAgentModels).toEqual({
      default: "ali-deepseek-v4-flash",
      task: "ali-deepseek-v4-pro",
    });
    expect(after.trace).toEqual({ enabled: true });
    expect(after.costLimit).toBe(100);
  });

  test("配置已完整时空操作、不写文件（内容字节不变）", async () => {
    const complete = { ...LEGACY_SETTINGS, subAgentModels: { default: "x" }, trace: { enabled: false } };
    writeFileSync(SETTINGS_PATH, JSON.stringify(complete, null, 2));
    const before = readFileSync(SETTINGS_PATH, "utf-8");

    const { mergeMissingTopLevelKeys } = await import("@sid-code/core/config/settings/index.ts");
    const added = mergeMissingTopLevelKeys("userSettings", {
      subAgentModels: { default: "should-not-overwrite" },
      trace: { enabled: true },
    });

    expect(added).toEqual([]);
    // 字节完全不变（既没覆盖已有值，也没重排 JSON）
    expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(before);
  });

  test("用户把某键显式设成空数组/空对象 → 视为已表态，不覆盖", async () => {
    const withEmpties = { ...LEGACY_SETTINGS, disabledSkills: [], mcpServers: {} };
    writeFileSync(SETTINGS_PATH, JSON.stringify(withEmpties, null, 2));

    const { mergeMissingTopLevelKeys } = await import("@sid-code/core/config/settings/index.ts");
    const added = mergeMissingTopLevelKeys("userSettings", {
      disabledSkills: ["some-skill"],
      mcpServers: { foo: {} },
    });

    expect(added).toEqual([]);
    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(after.disabledSkills).toEqual([]);
    expect(after.mcpServers).toEqual({});
  });

  test("settings.json 不存在 → 直接返回，不创建文件（首装交给 install.sh）", async () => {
    rmSync(SETTINGS_PATH, { force: true });

    const { mergeMissingTopLevelKeys } = await import("@sid-code/core/config/settings/index.ts");
    const added = mergeMissingTopLevelKeys("userSettings", { trace: { enabled: true } });

    expect(added).toEqual([]);
    expect(existsSync(SETTINGS_PATH)).toBe(false);
  });

  test("补全写回时 env 占位符不被展开成明文", async () => {
    process.env.MY_API_KEY = "sk-real-secret-should-not-leak";

    const { mergeMissingTopLevelKeys } = await import("@sid-code/core/config/settings/index.ts");
    mergeMissingTopLevelKeys("userSettings", { trace: { enabled: true } });

    const after = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(after.availableModels[0].api_key).toBe("${MY_API_KEY}");
    delete process.env.MY_API_KEY;
  });

  test("文件损坏时抛错、不覆盖用户配置", async () => {
    writeFileSync(SETTINGS_PATH, "{ this is not valid json");

    const { mergeMissingTopLevelKeys } = await import("@sid-code/core/config/settings/index.ts");
    expect(() => mergeMissingTopLevelKeys("userSettings", { trace: {} })).toThrow(/解析失败/);
    // 损坏内容原样保留，没被覆盖
    expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe("{ this is not valid json");
  });
});

describe("runMigrations 水位线（只补一次）", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(LEGACY_SETTINGS, null, 2));
  });

  afterEach(() => {
    // 恢复原值而非无条件 delete：bun test 同进程跑多文件，直接删会把
    // preload 设的隔离兜底（tests/preload-isolate-sid-home.ts）一起抹掉，
    // 导致后续测试文件写进用户真实 ~/.sid-code。实测曾因此泄漏 84 行审计日志。
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("首次 runMigrations 补全并写水位线；用户删键后二次 runMigrations 不再补回", async () => {
    const { runMigrations } = await import("@sid-code/core/migrations/runner.ts");

    // 第一次：补全团队默认字段
    runMigrations();
    const afterFirst = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(afterFirst.trace).toBeDefined();
    expect(afterFirst.subAgentModels).toBeDefined();
    // 水位线已写到当前版本（≥1）
    expect(existsSync(MIGRATION_STATE_PATH)).toBe(true);
    expect(JSON.parse(readFileSync(MIGRATION_STATE_PATH, "utf-8")).migrationVersion).toBeGreaterThanOrEqual(1);

    // 用户主动删掉 trace
    delete afterFirst.trace;
    writeFileSync(SETTINGS_PATH, JSON.stringify(afterFirst, null, 2));
    const mtimeBefore = statSync(SETTINGS_PATH).mtimeMs;

    // 第二次：水位线到位 → 迁移不再执行 → trace 不被加回，settings 文件不被改写
    runMigrations();
    const afterSecond = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(afterSecond.trace).toBeUndefined();
    expect(statSync(SETTINGS_PATH).mtimeMs).toBe(mtimeBefore);
  });
});
