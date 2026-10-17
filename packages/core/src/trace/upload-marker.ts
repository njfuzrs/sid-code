/**
 * `.uploaded` 标记的读写口径（S11 单一事实源）。
 *
 * ## 为什么需要 final 字段
 *
 * `/debug` 会在会话**中途**做一次快照上传（`collector.uploadSnapshot`）。修复前它与
 * SessionEnd 正常上传写的是同一个 `.uploaded`，而补传扫描（`backfill.ts`）只判
 * 「标记存在」——于是中途快照一写，后续增量**永远不会再被补传**：
 * 云端停在 /debug 那一刻，本地却以为已经同步。
 *
 * 现在标记内容带 `final`：
 * - SessionEnd / 补传 / 手动补传写 `final: true`；
 * - 中途快照写 `final: false` + `snapshot_at`。
 * 「已上传」判据只认 final。
 *
 * ## 历史标记兼容
 *
 * 修复前写的标记是 `{confirmed_at, session_id[, kept_local]}`，**没有 final 字段**；
 * 测试夹具里还有 `"{}"` 空对象。它们全部来自 SessionEnd/补传路径（中途快照的旧标记
 * 与它们形态相同、无法区分），按 final 处理——否则升级后全部历史会话会被重新补传一遍。
 * 只有显式 `final === false` 才视为未完成。读不出 JSON（空文件/损坏）同样按 final 处理：
 * 标记文件存在本身就是旧口径下的「已上传」，宁可少传一次也不批量重传。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const UPLOAD_MARKER_FILE = ".uploaded";

/** `.uploaded` 标记内容（新写入的形态；历史标记可能缺 final / snapshot_at） */
export interface UploadMarker {
  confirmed_at: string;
  session_id: string;
  /** true = 会话终态已上传；false = 仅中途快照，后续仍需补传 */
  final: boolean;
  /** final=false 时写：快照上传时刻（ISO） */
  snapshot_at?: string;
  kept_local?: boolean;
}

/**
 * 该会话目录是否已有**终态**上传标记。
 * 无标记 → false；显式 `final:false` → false；其余（含历史无 final 字段 / 读不出）→ true。
 */
export function hasFinalUploadMarker(sessionDir: string): boolean {
  const p = join(sessionDir, UPLOAD_MARKER_FILE);
  if (!existsSync(p)) return false;
  try {
    const raw = readFileSync(p, "utf-8").trim();
    if (!raw) return true;
    const obj = JSON.parse(raw) as { final?: unknown };
    return obj?.final !== false;
  } catch {
    return true;
  }
}
