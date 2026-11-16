/**
 * `--settings` 的作用范围：只到 settings 视野，不到 `loadConfig()` 构造的 Config 对象。
 *
 * 为什么要专门锁这个范围：修前有三处注释把 `--settings` 说成对 Config 生效 ——
 * `config.ts` 的字段注释「优先级高于常规 user/project/local 三源，作为最后一层覆盖」、
 * `cli.ts` 的启动注释「使后续 loadConfigFile → getSettings 合并时即生效」、
 * `permission/checker.ts` 的「（给 loadConfig 用：模型、开关等）」。
 * 实际一处也不生效：`loadConfigFile()` 只读磁盘 `~/.sid-code/settings.json` +
 * project/local 行为白名单，全程不取 `flagSettings` 内存源。
 * 2026-11-16 的核查正是被它们误导，把「`--settings` 对 goal 不生效」误判成
 * 「`settings.goal` 未接线」，多花了一轮返工。
 *
 * ⚠️ 这两条断言锁的是**当前作用范围本身**，不是「期望行为」。
 * 将来若实现方案 A（让 `loadConfigFile()` 也消费 flagSettings），
 * `config 不吃 flagSettings` 的断言会变红 —— 那时**改断言**，不要删测试：
 * 它同时是「`--settings` 到底影响什么」的唯一机械真相，删了就没人知道这段边界曾经存在。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@sid-code/core/config/config.ts";
import { getSettingsForSource, setFlagSettings } from "@sid-code/core/config/settings/settings.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/index.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;

/** 磁盘 settings.json 的内容，同时充当「负向对照」的基线：这些值必须原样进 Config */
const DISK_SETTINGS = {
  goal: { defaultMaxTurns: 7 },
  theme: "disk-theme",
  maxTurns: 3,
};

/** `--settings` 想覆盖的值，与磁盘值刻意全部不同，一眼能看出谁赢了 */
const FLAG_SETTINGS = {
  goal: { defaultMaxTurns: 6 },
  theme: "flag-theme",
  maxTurns: 11,
};

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-flag-scope-"));
  writeFileSync(join(tmpHome, "settings.json"), JSON.stringify(DISK_SETTINGS));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
  resetSettingsCache();
});

afterEach(() => {
  setFlagSettings(null);
  resetSettingsCache();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("--settings 的作用范围：settings 视野有、Config 对象没有", () => {
  test("负向对照：不注入 flagSettings 时，Config 全部由磁盘 settings.json 决定", async () => {
    const cfg = await loadConfig({} as any);
    expect(cfg.goal?.defaultMaxTurns).toBe(7);
    expect(cfg.theme).toBe("disk-theme");
    expect(cfg.maxTurns).toBe(3);
  });

  test("只传 extraSettings 入参：Config 完全不受影响（没人消费这个入参）", async () => {
    // extraSettings 在 config.ts 里只有字段声明、零消费点；真实生效路径是
    // cli.ts 先 setFlagSettings(json) 再 loadConfig(cliArgs)。这条锁住「入参本身不生效」，
    // 防止有人为了让它「看起来生效」而在 loadConfig 里自己解析 extraSettings
    // （那会与 cli.ts 的解析重复，且引入第二种实现）。
    const cfg = await loadConfig({
      extraSettings: JSON.stringify(FLAG_SETTINGS),
    } as any);
    expect(cfg.goal?.defaultMaxTurns).toBe(7);
    expect(cfg.theme).toBe("disk-theme");
    expect(cfg.maxTurns).toBe(3);
  });

  test("真实 CLI 路径（先 setFlagSettings 再 loadConfig）：Config 仍不受影响", async () => {
    setFlagSettings(FLAG_SETTINGS as any);
    const cfg = await loadConfig({} as any);

    // 核心断言：磁盘值原样保留，flagSettings 一点没盖上来。
    expect(cfg.goal?.defaultMaxTurns).toBe(7);
    expect(cfg.theme).toBe("disk-theme");
    expect(cfg.maxTurns).toBe(3);
  });

  test("同一个 flagSettings 在 getSettings 视野里是生效的（两条链结论相反）", () => {
    setFlagSettings(FLAG_SETTINGS as any);
    const flag = getSettingsForSource("flagSettings").settings;
    expect(flag).toMatchObject(FLAG_SETTINGS);
  });
});
