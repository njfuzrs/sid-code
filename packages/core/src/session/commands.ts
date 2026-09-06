/**
 * 会话管理命令（独立模块，供 bootstrap 快速路径使用）
 * 只包含不需要完整 CLI 初始化的轻量命令
 */

import { join } from "path";
import { unlinkSync, existsSync } from "fs";
import { sidPaths } from "../config/paths.ts";

/** 处理列出会话命令 */
export async function handleListSessions(): Promise<void> {
  const { SessionSelector, formatRelativeTime } = await import("./utils.ts");

  const sessionDir = sidPaths.sessions();
  const selector = new SessionSelector(sessionDir);

  try {
    const sessions = await selector.listSessions();

    if (sessions.length === 0) {
      console.log("未找到任何会话");
      return;
    }

    console.log(`共 ${sessions.length} 个会话:\n`);
    console.log("索引 | 消息数 | 时间 | 名称");
    console.log("-----|--------|------|------");

    for (const session of sessions) {
      const time = formatRelativeTime(session.lastUpdated, "short");
      const name = session.displayName.slice(0, 50);
      console.log(
        `#${session.index.toString().padStart(3)} | ${session.messageCount.toString().padStart(6)} | ${time.padEnd(4)} | ${name}`,
      );
    }
  } catch (error: any) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

/** 处理删除会话命令 */
export async function handleDeleteSession(sessionId: string): Promise<void> {
  const { SessionSelector } = await import("./utils.ts");

  const sessionDir = sidPaths.sessions();
  const selector = new SessionSelector(sessionDir);

  try {
    const session = await selector.findSession(sessionId);
    // P0-1：会话按项目分目录后，用条目自带的 dirPath 定位；回退根目录兼容未迁移的平铺文件。
    const sessionPath = join(session.dirPath || sessionDir, session.fileName);

    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
      // D7/D8：`--delete-session` 是删除会话的**第二个入口**，此前它只 unlink jsonl 本体，
      // 兄弟存储（checkpoints/<id>/、progress/<id>.md）原地留成孤儿。走与自动清理同一个
      // helper，而不是在这里再抄一遍要删什么——抄一遍就意味着下次新增同类存储会再漏一次。
      const { deleteSessionSiblingStores } = await import("./cleanup.ts");
      await deleteSessionSiblingStores(session.id);
      console.log(`已删除会话: ${session.id} (${session.displayName})`);
    } else {
      console.error(`错误: 会话文件不存在: ${session.fileName}`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}
