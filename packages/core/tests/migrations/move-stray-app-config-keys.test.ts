/**
 * 迁移 v4：app.json 越界键搬回 settings.json。
 *
 * 风险不对称：漏搬只是残留还在（下次启动再搬），错搬会用一份来源不明的残留值
 * 覆盖用户在 settings.json 里的显式设置。所以「两边都有时保留 settings」是
 * 首要断言，其次才是「只在 app.json 里的键不丢」。
 *
 * 写盘不走 Zod round-trip：用带 ${API_KEY} 占位符与自定义嵌套字段的 settings 做输入，
 * 断言它们原样存活。
 *
 * 用 SID_CONFIG_DIR 隔离，不碰真实用户配置。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_HOME = join("/tmp", `sid-code-stray-keys-test-${process.pid}`);
const SETTINGS_PATH = join(TEST_HOME, "settings.json");
const APP_PATH = join(TEST_HOME, "app.json");

const prevConfigDir = process.env.SID_CONFIG_DIR;

function writeJson(path: string, obj: unknown): void {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

async function runMigrate(): Promise<void> {
  const mod = await import("@sid-code/core/migrations/move-stray-app-config-keys.ts");
  mod.migrate();
}

describe("迁移 v4：app.json 越界键搬回 settings.json", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("两边都有的键保留 settings 的值，只在 app.json 的键补进去", async () => {
    writeJson(SETTINGS_PATH, {
      model: "m",
      alternateBuffer: false,
      openaiKey: "${OPENAI_API_KEY}",
      availableModels: [{ name: "m", provider: "openai", api_key: "${OPENAI_API_KEY}" }],
    });
    writeJson(APP_PATH, {
      numStartups: 12,
      showLineNumbers: true,
      alternateBuffer: true,
      // audit 的默认就是 true：值等于默认的残留不补进 settings，只从 app.json 删除。
      audit: true,
      ide: { autoConnect: false, autoInstallExtension: true },
      sanitizeEnv: false,
    });

    await runMigrate();

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    // 用户显式的 false 不被 app.json 的残留 true 覆盖。
    expect(settings.alternateBuffer).toBe(false);
    // 只存在于 app.json、且值不同于默认的键被补进 settings。
    expect(settings.ide).toEqual({ autoConnect: false, autoInstallExtension: true });
    expect(settings.sanitizeEnv).toBe(false);
    // 值等于默认的残留不搬，免得换个文件继续压着默认值。
    expect(settings.audit).toBeUndefined();
    // 不经 Zod round-trip：占位符与未声明嵌套字段原样存活。
    expect(settings.openaiKey).toBe("${OPENAI_API_KEY}");
    expect(settings.availableModels[0].api_key).toBe("${OPENAI_API_KEY}");
    expect(settings.model).toBe("m");

    const app = JSON.parse(readFileSync(APP_PATH, "utf-8"));
    expect(app.alternateBuffer).toBeUndefined();
    expect(app.ide).toBeUndefined();
    expect(app.sanitizeEnv).toBeUndefined();
    // AppConfig 自己的键不动。
    expect(app.numStartups).toBe(12);
    expect(app.showLineNumbers).toBe(true);
  });

  test("没有越界键时不改任何文件", async () => {
    writeJson(SETTINGS_PATH, { model: "m" });
    writeJson(APP_PATH, { numStartups: 3, debug: false });
    const beforeSettings = readFileSync(SETTINGS_PATH, "utf-8");
    const beforeApp = readFileSync(APP_PATH, "utf-8");

    await runMigrate();

    expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(beforeSettings);
    expect(readFileSync(APP_PATH, "utf-8")).toBe(beforeApp);
  });

  test("settings.json 不存在时用越界键创建它", async () => {
    writeJson(APP_PATH, { numStartups: 1, jitContext: false });

    await runMigrate();

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(settings).toEqual({ jitContext: false });
    const app = JSON.parse(readFileSync(APP_PATH, "utf-8"));
    expect(app.jitContext).toBeUndefined();
    expect(app.numStartups).toBe(1);
  });

  test("没有 app.json 时什么都不做", async () => {
    writeJson(SETTINGS_PATH, { model: "m" });
    await runMigrate();
    expect(JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"))).toEqual({ model: "m" });
  });

  // 回归：settings.json 里有一批与 defaultConfig() 完全相同的键（sessionId:""、
  // print:false、verbose:false……），是整份运行时默认配置被灌进文件的残留。
  // 文件层优先级高于默认值，残留把「代码里后来改掉的默认」压死。
  // 只删值仍等于默认的；值不同的是用户改过的，必须留。
  // alternateBuffer 即使值是 true 也不删：代码默认已改回 false，文件里的 true
  // 分不清是灌入的旧默认还是用户开过全屏，删了会把后者打回主屏。
  test("值等于默认的灌入键被删除，用户改过的同名键保留", async () => {
    writeJson(SETTINGS_PATH, {
      model: "my-model",
      openaiKey: "${OPENAI_API_KEY}",
      alternateBuffer: true,
      print: false,
      sessionId: "",
      verbose: false,
      // 与默认不同 → 用户显式开过，不能删。
      skipPermissions: true,
    });
    const before = readFileSync(SETTINGS_PATH, "utf-8");

    await runMigrate();

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    expect(settings.alternateBuffer).toBe(true);
    expect(settings.print).toBeUndefined();
    expect(settings.sessionId).toBeUndefined();
    expect(settings.verbose).toBeUndefined();
    expect(settings.skipPermissions).toBe(true);
    expect(settings.model).toBe("my-model");
    expect(settings.openaiKey).toBe("${OPENAI_API_KEY}");

    // 再跑一次必须是空操作：幂等，不能每次都重写文件。
    const once = readFileSync(SETTINGS_PATH, "utf-8");
    await runMigrate();
    expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(once);
    expect(once).not.toBe(before);
  });
});
