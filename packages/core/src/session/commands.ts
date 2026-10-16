/**
 * 会话管理命令（独立模块，供 bootstrap 快速路径使用）
 * 只包含不需要完整 CLI 初始化的轻量命令
 */

import { sidPaths } from "../config/paths.ts";
import type { Config } from "../config/config.ts";

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
export async function handleDeleteSession(
  sessionId: string,
  config: Config = {} as Config,
): Promise<void> {
  const { SessionSelector } = await import("./utils.ts");

  const sessionDir = sidPaths.sessions();
  const selector = new SessionSelector(sessionDir);

  try {
    const session = await selector.findSession(sessionId);
    // D7/D8：`--delete-session` 是删除会话的**第二个入口**。此前它只 unlink jsonl 本体 +
    // deleteSessionSiblingStores（checkpoints + progress），漏了 summaries / sidechain /
    // trajectory 三类。现在走与自动清理同一个 deleteSessionArtifacts()，六个资源类型
    // 单一实现点，新增同类存储只改那里一处。
    const { deleteSessionArtifacts } = await import("./cleanup.ts");
    await deleteSessionArtifacts(
      session.id,
      session.fileName,
      config,
      session.dirPath || sessionDir,
    );
    console.log(`已删除会话: ${session.id} (${session.displayName})`);
  } catch (error: any) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}
