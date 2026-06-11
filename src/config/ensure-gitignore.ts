/**
 * 配置目录自身的 .gitignore 生成（对标 claude-code ~/.claude/.gitignore）
 *
 * 背景：~/.sid-code/ 里混有「可提交的配置」（settings.json / CLAUDE.md）与
 * 「绝不该提交的运行时数据」（日志、会话、轨迹、明文凭证、检查点）。少数用户会把
 * 整个 ~/.sid-code/ 纳入 dotfiles 仓库管理；若无 .gitignore，运行时数据与密钥会被
 * 误提交。本模块在启动时幂等生成一份 .gitignore，按职责把运行时数据排除在外。
 *
 * 设计：
 * - 幂等：文件已存在则不覆盖（尊重用户自定义）
 * - fire-and-forget：失败仅记日志，不阻塞启动
 * - 只写配置目录自身的 .gitignore，与 gitignore.ts（写全局 git ignore）职责不同
 */

import { existsSync, writeFileSync, mkdirSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { getSidHome, sidPaths } from "./paths.ts";

/**
 * 配置目录 .gitignore 内容。
 *
 * 分类对标 claude-code：保留 settings.json / CLAUDE.md / 插件清单等「配置」可提交，
 * 排除日志 / 状态 / 会话 / 轨迹 / 检查点 / 记忆 / 临时数据等「运行时数据」。
 * 同时显式排除 .DS_Store 与已迁移备份、明文凭证残留。
 */
const GITIGNORE_CONTENT = `# sid-code 配置目录 .gitignore（启动时自动生成）
# 目的：把"运行时数据"挡在 git 之外，只让"配置"可被提交。
# 本文件可自由编辑；删除后下次启动会重新生成。

# ── 运行时数据目录（绝不提交）──
logs/
state/
sessions/
active-sessions/
checkpoints/
trajectories/
projects/
memory/
plans/
progress/
tasks/
telemetry/
tmp/
ide/

# ── 杂物 / 系统文件 ──
.DS_Store
*.log
.last-cleanup
.upload_queue.jsonl

# ── 迁移备份 / 旧格式残留 ──
config.yaml.migrated

# ── 本地私有凭证（不应进入任何仓库）──
*.local.json
managed-settings.json

# ── 允许提交的配置（显式取消忽略，便于 dotfiles 管理）──
!settings.json
!CLAUDE.md
!.gitignore
`;

/**
 * 确保配置目录存在 .gitignore。幂等：已存在则跳过。
 * 失败不抛出（fire-and-forget），仅记日志。
 */
export function ensureConfigGitignore(): void {
  const log = getLogger();
  try {
    const path = sidPaths.gitignore();
    if (existsSync(path)) {
      return; // 尊重用户已有的 .gitignore，不覆盖
    }
    // 确保配置根目录存在再写入
    const home = getSidHome();
    if (!existsSync(home)) {
      mkdirSync(home, { recursive: true });
    }
    writeFileSync(path, GITIGNORE_CONTENT, { mode: 0o644 });
    log.info("CONFIG", `已生成配置目录 .gitignore: ${path}`);
  } catch (err) {
    log.debug("CONFIG", `生成配置目录 .gitignore 跳过: ${err}`);
  }
}
