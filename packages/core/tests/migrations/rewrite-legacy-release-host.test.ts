/**
 * 旧 IP 服务地址改写（迁移 v3）测试
 *
 * 这个迁移的风险不对称：**漏改**只是让用户的搜索/轨迹继续静默不可用（可下次再修），
 * **错改**会把用户自建的内网 searxng / 私有轨迹平台地址指向我们的服务器
 * ——那是把用户数据送到别处，不可挽回。所以测试重点在「不该动的一律没动」，
 * 反向用例比正向用例多。
 *
 * 另一条必须守住的线：写盘不能走 Zod round-trip（会 strip 未声明字段、
 * 把 ${API_KEY} 展开成明文）。这里用「带 env 占位符 + 自定义嵌套字段」的配置做输入，
 * 断言它们原样存活。
 *
 * 用 SID_CONFIG_DIR 隔离，不碰真实用户配置。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_HOME = join("/tmp", `sid-code-rewrite-host-test-${process.pid}`);
const SETTINGS_PATH = join(TEST_HOME, "settings.json");
const MIGRATION_STATE_PATH = join(TEST_HOME, "state", "migrations.json");

const LEGACY_IP = "http://121.196.144.227";
const NEW_ORIGIN = "https://www.sid-code.cc";

/** 进程原有的 SID_CONFIG_DIR（可能是 preload 设的隔离兜底），afterEach 要还回去 */
const prevConfigDir = process.env.SID_CONFIG_DIR;

function writeSettings(obj: unknown): void {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
}

function readSettings(): any {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
}

/** 每个用例独立 import，避免 settings 模块内缓存跨用例串味 */
async function runMigrate(): Promise<void> {
  const mod = await import("@sid-code/core/migrations/rewrite-legacy-release-host.ts");
  mod.migrate();
}

describe("迁移 v3：旧 IP → 域名改写", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    // 恢复原值而非无条件 delete：bun test 同进程跑多文件，直接删会把 preload 的
    // 隔离兜底一起抹掉，导致后续测试文件写进用户真实 ~/.sid-code。
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("改写 search.searxngUrl 与 trace.upload.url，路径部分保留", async () => {
    writeSettings({
      search: { backend: "searxng", searxngUrl: `${LEGACY_IP}/searxng` },
      trace: {
        enabled: true,
        upload: { url: `${LEGACY_IP}/traj`, token: "secret-token", auto_upload: true },
      },
    });

    await runMigrate();
    const after = readSettings();

    expect(after.search.searxngUrl).toBe(`${NEW_ORIGIN}/searxng`);
    expect(after.trace.upload.url).toBe(`${NEW_ORIGIN}/traj`);
    // 同级字段必须原样留着（不是整块替换成模板）
    expect(after.search.backend).toBe("searxng");
    expect(after.trace.enabled).toBe(true);
    expect(after.trace.upload.token).toBe("secret-token");
    expect(after.trace.upload.auto_upload).toBe(true);
  });

  test("带 :80 端口的写法同样识别", async () => {
    writeSettings({ search: { searxngUrl: "http://121.196.144.227:80/searxng" } });
    await runMigrate();
    expect(readSettings().search.searxngUrl).toBe(`${NEW_ORIGIN}/searxng`);
  });

  test("origin 恰好等于旧 IP（无路径）也改", async () => {
    writeSettings({ trace: { upload: { url: LEGACY_IP } } });
    await runMigrate();
    expect(readSettings().trace.upload.url).toBe(NEW_ORIGIN);
  });

  // ── 以下是「不该动」的用例：错改的代价远高于漏改 ──

  test("用户自建的内网地址绝不改写", async () => {
    const selfHosted = {
      search: { backend: "searxng", searxngUrl: "http://192.168.1.50/searxng" },
      trace: { upload: { url: "https://traj.internal.corp/traj", token: "t" } },
    };
    writeSettings(selfHosted);
    await runMigrate();
    const after = readSettings();
    expect(after.search.searxngUrl).toBe("http://192.168.1.50/searxng");
    expect(after.trace.upload.url).toBe("https://traj.internal.corp/traj");
  });

  test("已经是域名的配置不动（幂等，重复跑不出问题）", async () => {
    writeSettings({
      search: { searxngUrl: `${NEW_ORIGIN}/searxng` },
      trace: { upload: { url: `${NEW_ORIGIN}/traj` } },
    });
    await runMigrate();
    await runMigrate();
    const after = readSettings();
    expect(after.search.searxngUrl).toBe(`${NEW_ORIGIN}/searxng`);
    expect(after.trace.upload.url).toBe(`${NEW_ORIGIN}/traj`);
  });

  test("IP 只出现在非 origin 位置（token/备注/query）时不做子串替换", async () => {
    writeSettings({
      search: { searxngUrl: "https://search.example.com/s?upstream=121.196.144.227" },
      trace: { upload: { url: "https://t.example.com/traj", token: `note-${LEGACY_IP}` } },
    });
    await runMigrate();
    const after = readSettings();
    // 值不以旧 origin 开头 → 整条不动，query 里的 IP 原样保留
    expect(after.search.searxngUrl).toBe("https://search.example.com/s?upstream=121.196.144.227");
    expect(after.trace.upload.token).toBe(`note-${LEGACY_IP}`);
  });

  test("https 形式的旧 IP 不改（不在已知失效清单里，宁可漏改）", async () => {
    writeSettings({ search: { searxngUrl: "https://121.196.144.227/searxng" } });
    await runMigrate();
    expect(readSettings().search.searxngUrl).toBe("https://121.196.144.227/searxng");
  });

  test("缺 search / trace 键，或类型不对，都不崩且不写坏文件", async () => {
    writeSettings({ model: "x", search: "not-an-object", trace: { upload: [1, 2] } });
    await runMigrate();
    const after = readSettings();
    expect(after.model).toBe("x");
    expect(after.search).toBe("not-an-object");
    expect(after.trace.upload).toEqual([1, 2]);
  });

  test("settings.json 不存在时静默返回，不创建文件", async () => {
    expect(existsSync(SETTINGS_PATH)).toBe(false);
    await runMigrate();
    expect(existsSync(SETTINGS_PATH)).toBe(false);
  });

  // ── 写盘保真：不能走 Zod round-trip ──

  test("改写时不 strip 未声明字段、不展开 env 占位符", async () => {
    writeSettings({
      search: { searxngUrl: `${LEGACY_IP}/searxng` },
      availableModels: [
        { name: "m", provider: "openai", api_key: "${MY_API_KEY}", base_url: "https://x/v1" },
      ],
      __userCustomField: { deeply: { nested: "value" } },
    });

    await runMigrate();
    const after = readSettings();

    expect(after.search.searxngUrl).toBe(`${NEW_ORIGIN}/searxng`);
    // 占位符必须仍是占位符——展开成明文就是把密钥落盘
    expect(after.availableModels[0].api_key).toBe("${MY_API_KEY}");
    // Zod 未声明的字段必须存活
    expect(after.__userCustomField).toEqual({ deeply: { nested: "value" } });
  });
});

describe("迁移 v3：runner 水位线", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("runMigrations 跑完后 v3 已登记，用户改回旧 IP 不会被再次改写", async () => {
    writeSettings({ search: { searxngUrl: `${LEGACY_IP}/searxng` } });

    const { runMigrations } = await import("@sid-code/core/migrations/runner.ts");
    runMigrations();
    expect(readSettings().search.searxngUrl).toBe(`${NEW_ORIGIN}/searxng`);

    const state = JSON.parse(readFileSync(MIGRATION_STATE_PATH, "utf-8"));
    expect(state.migrationVersion).toBeGreaterThanOrEqual(3);

    // 用户显式改回旧地址（视为用户表态）→ 水位线已过，不再自动改写
    writeSettings({ search: { searxngUrl: `${LEGACY_IP}/searxng` } });
    runMigrations();
    expect(readSettings().search.searxngUrl).toBe(`${LEGACY_IP}/searxng`);
  });
});
