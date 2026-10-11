/**
 * 迁移 v7：app.json 里的行为配置键收回 settings.json，两个文件从此键集合不相交。
 *
 * 背景：v4 定下「app.json 不存行为配置」，但当时的白名单 `APP_CONFIG_OWNED_KEYS`
 * 漏放了 9 个行为键（theme / showLineNumbers / debug / debugLevel / debugLogFile /
 * checkpoint / sessionRetention / trace / telemetry）。loadConfig 又按「settings 先、app 后」
 * 合并，于是 app.json 里的值**盖过** settings.json 与代码默认值。
 *
 * 实测一例（2026-10-11 维护者本机）：app.json 存着 `sessionRetention: {maxAge:"30d", maxCount:50}`
 * —— 正是 53047e30 之前的旧代码默认值。代码默认已改为 365d / 不限数量 / 10GB，
 * 但这份快照让会话照旧 30 天被删；同时轨迹清理只读 settings.json，按 365d 保留。
 * 一个「保留期」两套生效值，而启动提示让用户去改 settings.json —— 改了也盖不过 app.json。
 *
 * ## 判据：搬「用户改过的」，删「旧默认值快照」
 *
 * 这些键大多不是用户写的：老版本 `createDefaultAppConfig()` 带着 debug:false /
 * debugLevel:"INFO" / debugLogFile 字面量，`saveAppConfig` 每次启动计数都把它们连带写盘；
 * 其余几段是某次整份运行时配置回写留下的。搬进 settings.json 只会把旧默认换个文件继续压着
 * 新默认，所以：
 *   · 值等于**当前**代码默认，或等于下面登记的**历史**代码默认 → 视为快照，只从 app.json 删；
 *   · 其余值视为用户显式设置 → settings.json 没有该键才补进去（settings 是用户最后一次表态，
 *     两边都有时保留 settings）；
 *   · 嵌套对象只按整体比较，不做字段级合并：部分匹配说明有人改过，宁可整段搬也不猜。
 *
 * 写 settings.json 走 `patchSettingsFile`（原始 JSON、只改目标键、不过 Zod round-trip），
 * 理由同 v3/v6：round-trip 会 strip 未声明字段、把 `${ENV}` 占位符展开成明文落盘。
 *
 * 幂等：搬完 app.json 不再含这些键，再跑是空操作。
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getSidHome } from "../config/paths.ts";
import { defaultConfig } from "../config/config.ts";
import { patchSettingsFile } from "../config/settings/settings.ts";

/** 本迁移负责搬出的键。v4 白名单误收、而它们其实是 Config 行为字段 */
export const BEHAVIOR_KEYS_FORMERLY_IN_APP_JSON = [
  "theme",
  "showLineNumbers",
  "debug",
  "debugLevel",
  "debugLogFile",
  "checkpoint",
  "sessionRetention",
  "trace",
  "telemetry",
] as const;

/**
 * 历史代码默认值（已不再是当前默认，但会以快照形式躺在老用户的 app.json 里）。
 * 每条都能指到出处，不是猜的：
 */
const HISTORICAL_DEFAULTS: Record<string, unknown[]> = {
  // 老 createDefaultAppConfig()（dd489975 起，至本迁移前）
  debug: [false],
  debugLevel: ["INFO"],
  // edacbfea 之前 createDefaultAppConfig 的字面量；之后是 sidPaths.debugLog() 绝对路径（=当前默认）
  debugLogFile: ["~/.sid-code/debug.log"],
  // 53047e30 之前 session/cleanup.ts getRetentionSettings 的回退值
  sessionRetention: [{ enabled: true, maxAge: "30d", maxCount: 50, minRetention: "1d" }],
  // CheckpointManager 构造器的默认值整份展开（checkpoint/manager.ts），与当前默认相同
  checkpoint: [
    {
      enabled: true,
      maxCheckpointsPerFile: 50,
      maxTotalSizeMb: 200,
      maxAgeDays: 30,
      compressThresholdKb: 1,
      largeFileThresholdLines: 1000,
      hugeFileThresholdLines: 10000,
    },
  ],
};

/** 键顺序无关的结构比较（快照里的对象键顺序与默认值字面量不一定相同） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 值是否只是某一版代码默认值的快照（当前默认或已登记的历史默认） */
export function isDefaultSnapshot(key: string, value: unknown): boolean {
  const current = (defaultConfig() as unknown as Record<string, unknown>)[key];
  const candidates = [current, ...(HISTORICAL_DEFAULTS[key] ?? [])];
  const c = canonical(value);
  return candidates.some((d) => d !== undefined && canonical(d) === c);
}

export function migrate(): void {
  const home = getSidHome();
  const appPath = join(home, "app.json");
  if (!existsSync(appPath)) return;

  // 解析失败直接抛：runner 会记一条启动告警、水位线不前进，修好后重跑。绝不覆盖坏文件。
  const parsed = JSON.parse(readFileSync(appPath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const app = parsed as Record<string, unknown>;

  const present = BEHAVIOR_KEYS_FORMERLY_IN_APP_JSON.filter((k) => k in app);
  if (present.length === 0) return;

  const settingsPath = join(home, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new Error("settings.json 不是对象，已放弃搬迁以免覆盖");
    }
    settings = s as Record<string, unknown>;
  }

  for (const key of present) {
    const value = app[key];
    if (key in settings || value === null || value === undefined) continue;
    if (isDefaultSnapshot(key, value)) continue;
    // 先写 settings、后删 app：中途失败时最坏是两边都有（settings 优先，行为正确），
    // 而不是两边都没有（用户的显式设置丢失）。
    patchSettingsFile("userSettings", key, value);
  }

  for (const key of present) delete app[key];
  writeFileSync(appPath, JSON.stringify(app, null, 2), { mode: 0o600 });
}
