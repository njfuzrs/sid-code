/**
 * 迁移 v6：移除旧团队默认模板灌进来的轨迹上传配置（B37）
 *
 * 背景：`scripts/team-defaults.template.json` 曾带着一段 `trace.upload`
 * （`url` 指向 sid-code.cc、`auto_upload: true`、共享 token）。这份模板有两条分发链路：
 *   · install.sh 首装时整份拷进 settings.json；
 *   · 迁移 v1（backfill-team-defaults）给缺 `trace` 顶层键的老用户补进去。
 * 结果是**照官网装的任何人**，会话轨迹默认自动上传到维护者的后端 —— 与「数据主权」
 * 和 `team/observability.md`「上传默认不发生」正面冲突，且不会报任何错。
 *
 * 模板已删掉这段，但改模板只影响新装用户；已经写进用户磁盘的那段只能靠迁移收回。
 *
 * ## 判据：url 与 token 两项精确等于旧模板值才删，宁可漏删不可错删
 *
 * 用户自己配的上传（自建平台、或拿到真实 token 的组内成员）绝不能被删 ——
 * 删了是「轨迹静默不再上传」，和本迁移要修的问题同型。所以：
 *   · 只认旧模板里那一对 (url, token)，两项**都**精确相等才动；
 *   · 只删 `trace.upload` 这一个子键，`trace` 下其它字段（enabled 等）原样保留；
 *   · 只动 userSettings（项目级 settings 可能已入 git，静默改写会污染工作区 diff）。
 *
 * 写盘走 `patchSettingsFile`（读原始 JSON、只改目标顶层键、不过 Zod round-trip），
 * 理由同迁移 v3：round-trip 会 strip 未声明字段并把 `${ENV}` 占位符展开成明文落盘。
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { patchSettingsFile } from "../config/settings/settings.ts";
import { getSidHome } from "../config/paths.ts";

/** 旧模板里的那一对值。只有这一对 —— 见文件头。 */
const LEGACY_UPLOAD_URL = "https://www.sid-code.cc/traj";
const LEGACY_UPLOAD_TOKEN = "traj-upload-secret-token";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 读原始 JSON 文本而不是 getSettingsForSource()：后者展开了 `${ENV}`，
 * 据此写回会把明文密钥落盘。解析失败当作无事可做，绝不覆盖损坏的文件。
 */
function readRawUserSettings(): Record<string, unknown> | null {
  try {
    const path = join(getSidHome(), "settings.json");
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function migrate(): void {
  const current = readRawUserSettings();
  if (!current || !isPlainObject(current.trace)) return;

  const trace = current.trace;
  const upload = trace.upload;
  if (!isPlainObject(upload)) return;
  if (upload.url !== LEGACY_UPLOAD_URL || upload.token !== LEGACY_UPLOAD_TOKEN) return;

  // 浅拷贝后删子键，避免改到缓存里的同一个引用
  const patchedTrace = { ...trace };
  delete patchedTrace.upload;
  patchSettingsFile("userSettings", "trace", patchedTrace);

  // 必须告知：此前轨迹在用户不知情时被自动上传过，用户有权知道。
  console.log(
    `已移除团队默认模板带入的轨迹自动上传配置（trace.upload → ${LEGACY_UPLOAD_URL}）。\n` +
      `  原因：旧版团队模板默认开启了轨迹上传，这不该是默认行为；轨迹现在只保存在本地。\n` +
      `  若你确实需要集中收集轨迹，请在 ~/.sid-code/settings.json 的 trace.upload 里填你自己的地址与 token。`,
  );
}
