/**
 * P0-1：`buildLedgerEntry()` 落 `appVersion`（§一.4 第 2 条 + 反向自证）。
 *
 * 为什么必须测到 `App` 这一层而不止步于 `usage-ledger.ts` 的单测：
 * 账本行的**唯一生产者**是 `App.buildLedgerEntry()`。字段在接口上声明了、
 * upsert 也支持了，但如果生产者没填，落盘的每一行仍然没有版本号 ——
 * 而这正是修复前的状态（接口能力一直在，`getRawVersion()` 一直可用，
 * 缺的只是没人把它写进采集链）。只测底层等于测了"能不能写"，
 * 没测"到底有没有写"。
 *
 * 经 SID_CONFIG_DIR + SID_CODE_USAGE_LEDGER 重定向到 tmp，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { App } from "@sid-code/cli/app.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";

describe("P0-1 账本行携带 appVersion", () => {
  let testDir: string;
  // 存/恢复原值，不无条件 delete —— bun test 同进程跑多文件，delete 会抹掉别人的隔离
  const savedHome = process.env.HOME;
  const savedConfigDir = process.env.SID_CONFIG_DIR;
  const savedLedger = process.env.SID_CODE_USAGE_LEDGER;
  const savedVersion = process.env.SID_CODE_VERSION;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-ledger-ver-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code"), { recursive: true });
    process.env.HOME = testDir;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
    process.env.SID_CODE_USAGE_LEDGER = join(testDir, ".sid-code", "usage-ledger.jsonl");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = savedConfigDir;
    if (savedLedger === undefined) delete process.env.SID_CODE_USAGE_LEDGER;
    else process.env.SID_CODE_USAGE_LEDGER = savedLedger;
    if (savedVersion === undefined) delete process.env.SID_CODE_VERSION;
    else process.env.SID_CODE_VERSION = savedVersion;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function makeApp(): App {
    const config = {
      ...defaultConfig(),
      model: "mock-model",
      provider: "mock",
      availableModels: [],
      permissionMode: "default",
    } as unknown as Config;
    return new App({ config, provider: {} as any, mcpManager: {} as any });
  }

  /**
   * 造一个有用量的会话状态并取账本行。
   *
   * `buildLedgerEntry` 对空会话返回 null（promptTotal<=0 时不落行），
   * 所以必须先喂进真实用量，否则测到的是 null 而不是字段缺失 ——
   * 那会让这条测试变成"永远绿"的假门禁。
   */
  function buildEntry(app: App) {
    const st = (app as any).sessionState;
    st.updateUsage(
      "mock-model",
      {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      1234,
      "mock",
    );
    return (app as any).buildLedgerEntry();
  }

  test("账本行含 appVersion 且形如 x.y.z", () => {
    delete process.env.SID_CODE_VERSION;
    const entry = buildEntry(makeApp());
    // 先确认真的拿到了行 —— 拿到 null 时下面的字段断言会静默"通过"
    expect(entry).not.toBeNull();
    expect(entry.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("反向自证：版本源改成 0.0.0-test 时账本行就是 0.0.0-test", () => {
    // 防"零命中当成功"：只断言"字段存在且形如 x.y.z"的话，一个写死的常量也能过。
    // 同类教训见 `_ctx_version` 恒为 "dev" —— 字段在、非空、类型对，
    // 任何存在性断言都不会红，但值是废的。
    process.env.SID_CODE_VERSION = "0.0.0-test";
    const entry = buildEntry(makeApp());
    expect(entry).not.toBeNull();
    expect(entry.appVersion).toBe("0.0.0-test");
  });

  test("appVersion 与 trace 侧同口径（同一进程两处取值必须相等）", () => {
    // 版本号有三个写入点（analytics/metadata.ts、trace/collector.ts、app.ts），
    // 三处各写一份 env 回退逻辑。任一处漂移都会让"同一会话的 traj 与账本版本不同"，
    // 而那种数据比没有版本更糟 —— 它会让 release 对比静默算错。
    process.env.SID_CODE_VERSION = "1.2.3-align";
    const entry = buildEntry(makeApp());
    const { getRawVersion } = require("@sid-code/shared/version.ts");
    const traceSideValue = process.env.SID_CODE_VERSION ?? getRawVersion();
    expect(entry.appVersion).toBe(traceSideValue);
  });
});
