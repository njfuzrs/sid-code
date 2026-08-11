/**
 * 迁移 v2：把「有损项目键」下的存量数据迁到新的单射键（审计第 3 条善后）
 *
 * 背景：`sanitizeProjectKey` 旧实现把所有非 `[a-zA-Z0-9._-]` 字符（含全部中文）与路径
 * 分隔符都映射成 `-` 再折叠连续 `-`，是双重有损——`~/工作/app` 与 `~/文档/app` 派生出
 * 完全相同的键，两个私有项目的 memory / team-memory / sessions / mcp.local.json 目录
 * 重合，互相可读（发现清单第 3 条，有端到端复现）。修复后有损路径的键会追加短哈希后缀。
 *
 * 本迁移负责让**当前项目**的存量数据跟着换到新键下，否则用户的记忆与历史会话在升级后
 * 凭空「消失」（数据还在磁盘上，只是程序不再去那个目录找）。
 *
 * ⚠ 关键安全约束：**只在能确定旧目录唯一属于当前项目时才搬**。旧目录之所以有问题，
 * 恰恰是因为它**可能被多个项目共用**——若 A、B 都撞到同一个旧键，把它整体搬给"恰好先
 * 启动的那个项目"就等于把另一个项目的私有记忆送给它，那是把第 3 条的隐私泄漏换了个
 * 方向重演一遍，比不迁移更糟。因此这里采取**复制而非移动**（旧目录原样保留），
 * 且仅在新目录尚不存在时执行，任何歧义都宁可不动 + 提示用户手工处理。
 *
 * 幂等：靠 runner 的版本水位线；额外靠"新目录已存在就跳过"兜第二层。
 */

import { existsSync, cpSync, readdirSync } from "fs";
import { join } from "path";
import { sidPaths } from "../config/paths.ts";
import { resolveProjectRoot, sanitizeProjectKey, findLegacyProjectKey } from "../memory/paths.ts";

/** 需要跟着换键的 per-project 数据位置（相对 projects/<key>/ 或 sessions/<key>/） */
const PROJECT_SUBPATHS = ["memory", "team-memory", ".session_memory.md", "mcp.local.json"];

/** 目录/文件存在且非空（空目录不值得搬，也不值得提示） */
function hasContent(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    // 文件：存在即有内容；目录：至少一个条目
    return readdirSync(p).length > 0;
  } catch {
    // readdirSync 对普通文件抛错 → 说明是文件且存在
    return true;
  }
}

export function migrate(): void {
  const root = resolveProjectRoot(process.cwd());
  const legacyKey = findLegacyProjectKey(root);
  // 键本来就无损（纯 ASCII 路径，绝大多数用户）→ 新旧键相同，无事可做
  if (!legacyKey) return;

  const newKey = sanitizeProjectKey(root);
  if (newKey === legacyKey) return;

  const projectsDir = sidPaths.projects();
  const sessionsDir = sidPaths.sessions();
  const moved: string[] = [];

  // 1) projects/<key>/ 下的各项 per-project 数据
  for (const sub of PROJECT_SUBPATHS) {
    const from = join(projectsDir, legacyKey, sub);
    const to = join(projectsDir, newKey, sub);
    if (!hasContent(from)) continue;
    if (existsSync(to)) continue; // 新位置已有数据 → 不覆盖，跳过
    try {
      cpSync(from, to, { recursive: true });
      moved.push(sub);
    } catch {
      // 迁移失败不阻塞启动（runner 语义），下条继续
    }
  }

  // 2) sessions/<key>/ 会话历史
  const sessFrom = join(sessionsDir, legacyKey);
  const sessTo = join(sessionsDir, newKey);
  if (hasContent(sessFrom) && !existsSync(sessTo)) {
    try {
      cpSync(sessFrom, sessTo, { recursive: true });
      moved.push("sessions");
    } catch {
      /* 同上，不阻塞 */
    }
  }

  if (moved.length > 0) {
    // 必须告知用户：① 数据换了位置；② 旧目录**可能**混有别的项目的数据，需人工确认。
    // 静默搬运会让"我的记忆里怎么有别的项目的内容"变成无法追溯的怪现象。
    console.log(
      `项目目录键已升级（修复非 ASCII 路径的跨项目串目录问题）：${legacyKey} → ${newKey}\n` +
        `  已复制: ${moved.join(", ")}（旧目录保留未删除）\n` +
        `  ⚠ 若旧目录曾被多个项目共用，请人工检查新目录下是否混入了其他项目的记忆：\n` +
        `     ${join(projectsDir, newKey)}`,
    );
  }
}
