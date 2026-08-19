import type { LocalCommandModule } from "../../types.ts";

const mod: LocalCommandModule = {
  async call(_args, ctx) {
    const lines: string[] = ["并发冲突状态:"];
    try {
      const { queryAllFileIntents } = await import("@sid-code/core/session/file-intent.ts");
      const intents = queryAllFileIntents();
      const sessionIds = Object.keys(intents);
      if (sessionIds.length === 0) {
        lines.push(
          "",
          "  当前没有活跃的文件意图。",
          "  （没有其他会话在访问文件，或本会话尚未读取/编辑文件）",
        );
        return { type: "text", value: lines.join("\n") };
      }
      const totalFiles = Object.values(intents).reduce(
        (sum, session) => sum + Object.keys(session.files).length,
        0,
      );
      lines.push("", `  活跃会话: ${sessionIds.length}`, `  涉及文件: ${totalFiles}`, "");
      for (const [sessionId, sessionIntent] of Object.entries(intents)) {
        const fileEntries = Object.entries(sessionIntent.files);
        if (fileEntries.length === 0) continue;
        lines.push(`  会话 ${sessionId.slice(-8)} (PID ${sessionIntent.pid}):`);
        fileEntries.sort(([a], [b]) => a.localeCompare(b));
        for (const [filePath, intent] of fileEntries) {
          const secondsAgo = Math.floor((Date.now() - intent.lastAccessAt) / 1000);
          const timeAgo =
            secondsAgo < 60 ? `${secondsAgo} 秒前` : `${Math.floor(secondsAgo / 60)} 分钟前`;
          const opLabel =
            intent.operation === "read" ? "读" : intent.operation === "edit" ? "编辑" : "写";
          lines.push(`    · ${filePath} — ${opLabel} (${timeAgo})`);
        }
      }
      const fileToSessions = new Map<string, string[]>();
      for (const [sessionId, sessionIntent] of Object.entries(intents)) {
        for (const filePath of Object.keys(sessionIntent.files)) {
          const sessions = fileToSessions.get(filePath) ?? [];
          sessions.push(sessionId);
          fileToSessions.set(filePath, sessions);
        }
      }
      const conflicts = Array.from(fileToSessions.entries()).filter(
        ([, sessions]) => sessions.length > 1,
      );
      if (conflicts.length > 0) {
        lines.push("", "  ⚠ 潜在冲突:");
        for (const [filePath, sessions] of conflicts) {
          lines.push(
            `    · ${filePath} — ${sessions.length} 个会话 (${sessions.map((s) => s.slice(-8)).join(", ")})`,
          );
        }
        lines.push("", "  建议：关闭其他会话或避开正在被编辑的文件");
      } else {
        lines.push("", "  ✔ 无冲突");
      }
    } catch (err) {
      lines.push("", `  查询失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { type: "text", value: lines.join("\n") };
  },
};

export default mod;
