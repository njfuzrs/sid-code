/**
 * `--settings` 的作用范围：**统一视野** —— settings / Config / hooks 三条链都吃它。
 *
 * 历史（为什么这条测试改了两次而不是删掉）：
 * - 2026-11-16 之前：`--settings` 只进 `getSettings()` 视野，`loadConfig()` 构造的 Config
 *   与 hooks 都静默无视它。同一根因被报过三次（hooks 只读用户级 → HC1 补齐磁盘三源 →
 *   2026-11-17 补齐 Config/hooks）。
 * - 2026-11-16 的 PR #897 把这段边界写成「锁定旧行为」的测试（config 不吃 flagSettings），
 *   并在注释里写明：将来实现方案 A 时**改断言、不要删测试**。
 * - 2026-11-17 本次实现方案 A，断言按新契约改写，用例结构保留 —— 它仍然是
 *   「`--settings` 到底影响什么」的唯一机械真相。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@sid-code/core/config/config.ts";
import { getSettingsForSource, setFlagSettings } from "@sid-code/core/config/settings/settings.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/index.ts";
import { collectHookLayers } from "../../src/config/hook-layers.ts";
import { resolveStartPermissionMode } from "../../src/config/permission-mode-source.ts";

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

describe("--settings 的作用范围：settings 视野 + Config + hooks 统一", () => {
  test("负向对照：不注入 flagSettings 时，Config 全部由磁盘 settings.json 决定", async () => {
    const cfg = await loadConfig({} as any);
    expect(cfg.goal?.defaultMaxTurns).toBe(7);
    expect(cfg.theme).toBe("disk-theme");
    expect(cfg.maxTurns).toBe(3);
  });

  test("只传 extraSettings 入参：Config 不受影响（真正的生效路径是 cli.ts 先 setFlagSettings）", async () => {
    // extraSettings 在 config.ts 里只是「传参载体」；真实生效路径是 cli.ts 先
    // setFlagSettings(json) 再 loadConfig(cliArgs)。这条锁住「入参本身不生效」，
    // 防止有人为了让它「看起来生效」而在 loadConfig 里自己解析 extraSettings
    // （那会与 cli.ts 的解析重复，且引入第二种实现）。
    const cfg = await loadConfig({
      extraSettings: JSON.stringify(FLAG_SETTINGS),
    } as any);
    expect(cfg.goal?.defaultMaxTurns).toBe(7);
    expect(cfg.theme).toBe("disk-theme");
    expect(cfg.maxTurns).toBe(3);
  });

  test("真实 CLI 路径（先 setFlagSettings 再 loadConfig）：Config 被 flagSettings 覆盖", async () => {
    setFlagSettings(FLAG_SETTINGS as any);
    const cfg = await loadConfig({} as any);

    // 新契约：flagSettings 在磁盘源之上（SETTING_SOURCES: ... local → flag → policy）
    expect(cfg.goal?.defaultMaxTurns).toBe(6);
    expect(cfg.theme).toBe("flag-theme");
    expect(cfg.maxTurns).toBe(11);
  });

  test("只覆盖 flag 里出现的字段，未出现的保留磁盘值", async () => {
    setFlagSettings({ theme: "flag-theme" } as any);
    const cfg = await loadConfig({} as any);
    expect(cfg.theme).toBe("flag-theme");
    // 磁盘值必须原样保留：覆盖是「按字段」而不是「整份替换」
    expect(cfg.goal?.defaultMaxTurns).toBe(7);
    expect(cfg.maxTurns).toBe(3);
  });

  test("flag 的 hooks 不进 config.hooks（走 _hookLayers，避免 app.ts 重复注册）", async () => {
    setFlagSettings({
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    } as any);
    const cfg = await loadConfig({} as any);
    // config.hooks 的语义仍是「用户级 settings.json 的 hooks」；flag 层由 collectHookLayers 提供。
    // 若这里非空，app.ts 的 `!hasUserLayer && config.hooks` 兜底会在没有 user 层时再注册一遍。
    expect(Object.keys((cfg.hooks ?? {}) as Record<string, unknown>)).toHaveLength(0);
  });

  test("同一个 flagSettings 在 getSettings 视野里同样生效（三条链结论一致）", () => {
    setFlagSettings(FLAG_SETTINGS as any);
    const flag = getSettingsForSource("flagSettings").settings;
    expect(flag).toMatchObject(FLAG_SETTINGS);
  });
});

describe("hooks：flagSettings 作为独立一层参与注册", () => {
  test("--settings 的 hooks 成为 flag 层，且命令里的 ${VAR} 不被提前展开", () => {
    setFlagSettings({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "echo ${CLAUDE_PROJECT_DIR} >> hook.log" }],
          },
        ],
      },
    } as any);

    const layers = collectHookLayers(tmpHome);
    const flagLayer = layers.find((l) => l.source === "flag");
    expect(flagLayer).toBeDefined();
    expect(flagLayer!.file).toBe("<--settings>");
    expect(flagLayer!.untrusted).toBe(false);
    // 关键：与磁盘各层同口径读原始 JSON —— 变量必须留给 hook 子进程展开。
    // 提前展开的后果是路径变成空或外层项目的目录，且错得无声（见 hook-layers.ts 头注释）。
    expect(JSON.stringify(flagLayer!.hooks)).toContain("${CLAUDE_PROJECT_DIR}");
  });

  test("极旧的数组写法也归一成事件分组（与 normalizeConfigKeys 同口径）", () => {
    setFlagSettings({ hooks: [{ event: "PostToolUse", command: "echo hi" }] } as any);
    const layers = collectHookLayers(tmpHome);
    const flagLayer = layers.find((l) => l.source === "flag");
    expect(flagLayer).toBeDefined();
    expect(flagLayer!.hooks.PostToolUse).toHaveLength(1);
  });

  test("没有 flagSettings、或 flagSettings 里没有 hooks 时，不产生 flag 层", () => {
    setFlagSettings(null);
    expect(collectHookLayers(tmpHome).some((l) => l.source === "flag")).toBe(false);

    setFlagSettings({ theme: "flag-theme" } as any);
    expect(collectHookLayers(tmpHome).some((l) => l.source === "flag")).toBe(false);
  });
});

describe("起始权限模式：flag 在 policy 之下、磁盘源之上", () => {
  test("flag 的 permissionMode 生效（trust=full，与用户级同级）", () => {
    const r = resolveStartPermissionMode([
      {
        origin: "flag",
        label: "--settings 显式指定",
        settings: { permissionMode: "acceptEdits" },
        trust: "full",
      },
    ]);
    expect(r.mode).toBe("acceptEdits");
    expect(r.origin).toBe("flag");
  });

  test("企业 policy 压制 flag：同一档位上 policy 先胜出", () => {
    const r = resolveStartPermissionMode([
      {
        origin: "policy",
        label: "企业 managed settings",
        settings: { permissionMode: "plan" },
        trust: "full",
      },
      {
        origin: "flag",
        label: "--settings 显式指定",
        settings: { permissionMode: "acceptEdits" },
        trust: "full",
      },
    ]);
    expect(r.mode).toBe("plan");
    expect(r.origin).toBe("policy");
  });
});
