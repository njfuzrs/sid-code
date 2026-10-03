/**
 * 移除旧团队模板默认轨迹上传（迁移 v6，B37）测试
 *
 * 风险不对称：漏删只是继续上传（下次可再修），错删会让用户自己配的上传
 * 静默失效 —— 和本迁移要修的问题同型。所以反向用例比正向用例多。
 *
 * 用 SID_CONFIG_DIR 隔离，不碰真实用户配置。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import teamDefaults from "../../../../scripts/team-defaults.template.json" with { type: "json" };

const TEST_HOME = join("/tmp", `sid-code-rm-trace-upload-test-${process.pid}`);
const SETTINGS_PATH = join(TEST_HOME, "settings.json");

const LEGACY_URL = "https://www.sid-code.cc/traj";
const LEGACY_TOKEN = "traj-upload-secret-token";

/** 旧模板里那段原样（install.sh 首装 / 迁移 v1 补进去的就是它） */
const LEGACY_UPLOAD = {
  url: LEGACY_URL,
  token: LEGACY_TOKEN,
  auto_upload: true,
  delete_after_upload: false,
  tool_source: "sid-code",
  compress: true,
};

const prevConfigDir = process.env.SID_CONFIG_DIR;

function writeSettings(obj: unknown): void {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
}

function readSettings(): any {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
}

async function runMigrate(): Promise<void> {
  const mod = await import("@sid-code/core/migrations/remove-team-default-trace-upload.ts");
  mod.migrate();
}

describe("迁移 v6：移除旧团队模板默认轨迹上传", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("团队模板本身不再含 trace.upload（新装 / 迁移 v1 不会再带进来）", () => {
    const trace = (teamDefaults as Record<string, any>).trace;
    expect(trace).toEqual({ enabled: true });
    expect(JSON.stringify(teamDefaults)).not.toContain(LEGACY_TOKEN);
  });

  test("旧模板那段原样存在 → 删掉 trace.upload，保留 trace 其它字段", async () => {
    writeSettings({ model: "m", trace: { enabled: true, upload: LEGACY_UPLOAD } });
    await runMigrate();
    const after = readSettings();
    expect(after.trace).toEqual({ enabled: true });
    expect(after.model).toBe("m");
  });

  test("用户改过 auto_upload 等其它字段，只要 url+token 仍是旧值也删", async () => {
    writeSettings({
      trace: { upload: { url: LEGACY_URL, token: LEGACY_TOKEN, auto_upload: false } },
    });
    await runMigrate();
    expect(readSettings().trace).toEqual({});
  });

  // ── 以下是「不该动」的用例 ──

  test("用户换了自己的 token（同一地址）→ 不动", async () => {
    const upload = { url: LEGACY_URL, token: "my-real-token", auto_upload: true };
    writeSettings({ trace: { upload } });
    await runMigrate();
    expect(readSettings().trace.upload).toEqual(upload);
  });

  test("用户自建地址（沿用旧 token 字串）→ 不动", async () => {
    const upload = { url: "https://traj.internal.corp/traj", token: LEGACY_TOKEN };
    writeSettings({ trace: { upload } });
    await runMigrate();
    expect(readSettings().trace.upload).toEqual(upload);
  });

  test("token 用 env 占位符 → 不动（不展开、不当作旧值）", async () => {
    const upload = { url: LEGACY_URL, token: "${TRAJ_TOKEN}" };
    writeSettings({ trace: { upload } });
    await runMigrate();
    expect(readSettings().trace.upload).toEqual(upload);
  });

  test("缺 trace / 类型不对，都不崩且不写坏文件", async () => {
    writeSettings({ model: "x", trace: { upload: [1, 2] } });
    await runMigrate();
    expect(readSettings()).toEqual({ model: "x", trace: { upload: [1, 2] } });

    writeSettings({ trace: "not-an-object" });
    await runMigrate();
    expect(readSettings().trace).toBe("not-an-object");
  });

  test("settings.json 不存在时静默返回，不创建文件", async () => {
    expect(existsSync(SETTINGS_PATH)).toBe(false);
    await runMigrate();
    expect(existsSync(SETTINGS_PATH)).toBe(false);
  });

  test("写盘不 strip 未声明字段、不展开 env 占位符", async () => {
    writeSettings({
      trace: { enabled: true, upload: LEGACY_UPLOAD },
      availableModels: [{ name: "m", provider: "openai", api_key: "${MY_API_KEY}" }],
      __userCustomField: { deeply: { nested: "value" } },
    });
    await runMigrate();
    const after = readSettings();
    expect(after.trace).toEqual({ enabled: true });
    expect(after.availableModels[0].api_key).toBe("${MY_API_KEY}");
    expect(after.__userCustomField).toEqual({ deeply: { nested: "value" } });
  });
});

describe("迁移 v6：经 runner 串起 v1 → v3 → v6", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("旧 IP 时代装的用户：v3 先改域名、v6 再删，最终无上传配置", async () => {
    writeSettings({
      trace: { enabled: true, upload: { ...LEGACY_UPLOAD, url: "http://121.196.144.227/traj" } },
    });
    const { runMigrations } = await import("@sid-code/core/migrations/runner.ts");
    runMigrations();
    expect(readSettings().trace.upload).toBeUndefined();
    expect(readSettings().trace.enabled).toBe(true);
  });

  test("缺 trace 的老用户：v1 补进来的 trace 不含 upload", async () => {
    writeSettings({ model: "m" });
    const { runMigrations } = await import("@sid-code/core/migrations/runner.ts");
    runMigrations();
    expect(readSettings().trace).toEqual({ enabled: true });
  });
});
