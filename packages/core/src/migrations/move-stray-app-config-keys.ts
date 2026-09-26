/**
 * 迁移 v4：把 app.json 里不属于 AppConfig 的存量键搬回 settings.json。
 *
 * 背景：app.json 的定位是运行时状态（启动计数、hint 衰减、checkpoint、遥测）。
 * 但磁盘上的存量文件里混进了一批行为配置键（alternateBuffer、audit、ide、
 * sanitizeEnv、jitContext……）——它们不在 AppConfig 类型里，是某次把整份运行时
 * Config 回写进 app.json 留下的。loadConfig 按「settings.json 先、app.json 后」
 * 合并这两个文件，于是同一字段有了两个互相矛盾的真相源：用户在 settings.json 里
 * 显式设的值，会被 app.json 里一份来源不明的残留盖掉。
 *
 * 本迁移做两件事：
 * 1. app.json 的越界键搬回 settings.json。settings 没有的键补进去（不丢只写在
 *    app.json 里的显式设置，例如 ide.autoInstallExtension）；两边都有的保留
 *    settings 的值（那是 /tui、/model 等命令的持久化端），只从 app.json 删除。
 * 2. settings.json 里「整份默认配置被灌进文件」留下的键，值仍等于 defaultConfig()
 *    的就删除（见 DUMPED_DEFAULT_KEYS）。值与默认不同的不删，那是用户改过的。
 *
 * 写盘走原始 JSON 文本，不经 Zod round-trip：settings.json 里的 ${API_KEY} 占位符
 * 与 schema 未声明的嵌套字段必须原样存活。
 *
 * 幂等：搬完 app.json 不再含越界键、settings.json 不再含值等于默认的灌入键，
 * 再跑是空操作。
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { getSidHome } from "../config/paths.ts";
import { APP_CONFIG_OWNED_KEYS } from "../config/app-config.ts";
import { defaultConfig } from "../config/config.ts";
import { join } from "path";

/**
 * 这些键出现在 ~/.sid-code/settings.json 里、又与 defaultConfig() 的值完全相同，
 * 就不是用户的选择：运行时 Config 的默认值整份被灌进了 settings.json
 * （同批的还有 sessionId:""、print:false、verbose:false 这种没人会手写的字段）。
 * 它们留在文件里有害——文件层优先级高于默认值，默认值一旦在后续版本改掉，
 * 这份快照还按旧默认压着，用户怎么改代码都看不到效果。
 *
 * alternateBuffer 不在此列：它的代码默认已经从 true 改回 false，文件里留下的
 * true 分不清是「灌进来的旧默认」还是「用户 /tui on 开过」，删了会把后者静默
 * 打回主屏。宁可不删。
 *
 * 只收「与默认值相同」的键。和默认不同的一律是用户改过的，不动。
 */
const DUMPED_DEFAULT_KEYS = [
  "permissionMode",
  "allowedTools",
  "disallowedTools",
  "hooks",
  "allowedDirectories",
  "blockedDirectories",
  "skipPermissions",
  "yesMode",
  "systemPrompt",
  "appendSystemPrompt",
  "systemPromptFile",
  "sessionId",
  "continue",
  "resume",
  "outputFormat",
  "maxTurns",
  "verbose",
  "print",
] as const;

export function migrate(): void {
  const home = getSidHome();
  const appPath = join(home, "app.json");
  const settingsPath = join(home, "settings.json");

  // app.json 的越界键。文件不存在或没有越界键时为空——清理 settings.json 里灌入的
  // 默认值不依赖这一步，两种残留可以分别出现。
  let appRaw: Record<string, unknown> | null = null;
  const stray: Record<string, unknown> = {};
  if (existsSync(appPath)) {
    const parsed = JSON.parse(readFileSync(appPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      appRaw = parsed as Record<string, unknown>;
      for (const [key, value] of Object.entries(appRaw)) {
        if (!APP_CONFIG_OWNED_KEYS.has(key)) stray[key] = value;
      }
    }
  }
  const strayKeys = Object.keys(stray);

  let settings: Record<string, unknown> = {};
  if (strayKeys.length === 0 && !existsSync(settingsPath)) return;
  if (existsSync(settingsPath)) {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings.json 不是对象，已放弃搬迁以免覆盖");
    }
    settings = parsed as Record<string, unknown>;
  }

  // settings 已有的键是用户最后一次表态，残留值不许覆盖它。
  // 残留值本身就等于默认的也不补：搬过去只是换个文件继续把默认值压死，
  // 白让 settings.json 多一个没人设过的键。
  const defaults = defaultConfig() as unknown as Record<string, unknown>;
  let settingsChanged = false;
  for (const [key, value] of Object.entries(stray)) {
    if (key in settings) continue;
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) continue;
    settings[key] = value;
    settingsChanged = true;
  }

  // 清掉「整份默认配置灌进 settings.json」留下的、且值仍等于默认的键。
  // 值与默认不同的不删：那是用户改过的。用序列化比较，对象/数组也能判定。
  for (const key of DUMPED_DEFAULT_KEYS) {
    if (!(key in settings)) continue;
    if (JSON.stringify(settings[key]) === JSON.stringify(defaults[key])) {
      delete settings[key];
      settingsChanged = true;
    }
  }

  if (settingsChanged) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  if (appRaw && strayKeys.length > 0) {
    for (const key of strayKeys) delete appRaw[key];
    writeFileSync(appPath, JSON.stringify(appRaw, null, 2), { mode: 0o600 });
  }
}
