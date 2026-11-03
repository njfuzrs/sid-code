import type { LocalCommandModule } from "../../types.ts";
import type { SessionFileIntents } from "@sid-code/core/session/file-intent.ts";

/**
 * 冲突口径：只有 edit / write 才会互相覆盖。
 *
 * 与 `checkConflict` 的默认 `blockingOperations: ["edit", "write"]` 同口径——
 * 两个会话都只是 read 同一文件时报「冲突」是纯误报（读不会改坏任何东西）。
 */
const WRITING_OPERATIONS: ReadonlySet<string> = new Set(["edit", "write"]);

/** 单个会话对某个逻辑文件的声明（物理路径已回退为可用值） */
export interface IntentEntry {
  sessionId: string;
  physicalPath: string;
  operation: string;
}

/** 同一份物理文件被 ≥2 会话写 —— 真冲突，会互相覆盖 */
export interface SameFileConflict {
  logicalPath: string;
  physicalPath: string;
  sessionIds: string[];
}

/** 同一逻辑文件的多份物理副本 —— 分支分叉，合并回主仓时才撞车 */
export interface BranchDivergence {
  logicalPath: string;
  copies: Array<{ sessionId: string; physicalPath: string }>;
}

export interface IntentConflictGroups {
  /** 同盘同文件被多个会话写 */
  sameFile: SameFileConflict[];
  /** 同逻辑文件、物理路径互不相同（各方在各自的 worktree 里改） */
  diverged: BranchDivergence[];
}

/**
 * 把各会话的文件意图按**物理路径**分组，区分两种语义完全不同的「冲突」。
 *
 * 为什么不能只按逻辑键聚合（旧实现的缺陷）：
 * 逻辑键是跨 worktree 折叠后的主仓路径（`file-intent.ts` 的 `resolveIntentKey`），
 * 两个 worktree 里的同名文件会折到同一个键上。旧实现据此直接报「⚠ 潜在冲突」并建议
 * 「关闭其他会话」——但两方改的是**各自的磁盘副本**，既不会互相覆盖，关会话也解决不了
 * 分叉。判据必须落到物理路径：同一份物理文件被并发写才是真冲突。
 *
 * @param intents `queryAllFileIntents()` 的返回值
 */
export function groupIntentConflicts(
  intents: Record<string, SessionFileIntents>,
): IntentConflictGroups {
  // 先按逻辑键聚合（跨 worktree 的同名文件落在同一个键上）
  const byLogical = new Map<string, IntentEntry[]>();
  for (const [sessionId, session] of Object.entries(intents)) {
    for (const [logicalPath, intent] of Object.entries(session.files)) {
      if (!WRITING_OPERATIONS.has(intent.operation)) continue;
      const list = byLogical.get(logicalPath) ?? [];
      list.push({
        sessionId,
        // 旧意图记录（PR-1 之前写入）没有 physicalPath，回退逻辑键 —— 与
        // conflict-detector.ts 的 `intent.physicalPath ?? intent.path` 同一口径
        physicalPath: intent.physicalPath ?? intent.path,
        operation: intent.operation,
      });
      byLogical.set(logicalPath, list);
    }
  }

  const sameFile: SameFileConflict[] = [];
  const diverged: BranchDivergence[] = [];
  for (const [logicalPath, entries] of byLogical) {
    if (entries.length < 2) continue;

    const byPhysical = new Map<string, string[]>();
    for (const entry of entries) {
      const ids = byPhysical.get(entry.physicalPath) ?? [];
      ids.push(entry.sessionId);
      byPhysical.set(entry.physicalPath, ids);
    }

    // 真冲突：同一份物理文件被 ≥2 会话写
    for (const [physicalPath, sessionIds] of byPhysical) {
      if (sessionIds.length > 1) {
        sameFile.push({ logicalPath, physicalPath, sessionIds });
      }
    }

    // 分支分叉：存在多份物理副本（说明至少一方在别的 worktree 里改）。
    // 只列「独自一份」的会话——已被真冲突收走的物理文件不再重复出现在分叉组，
    // 否则同一份文件会在两个语义相反的组里同时出现。
    if (byPhysical.size > 1) {
      const copies: Array<{ sessionId: string; physicalPath: string }> = [];
      for (const [physicalPath, ids] of byPhysical) {
        const only = ids.length === 1 ? ids[0] : undefined;
        if (only) copies.push({ sessionId: only, physicalPath });
      }
      if (copies.length > 0) diverged.push({ logicalPath, copies });
    }
  }

  return { sameFile, diverged };
}

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
        // PR-2（B3）：子代理以自己的 agentId 登记，标注归属父会话，
        // 否则用户看到一串 <parent>-sub-<taskId> 对不上是哪个窗口的活儿
        const attribution = sessionIntent.parentSessionId
          ? `，子代理 → 归属父会话 ${sessionIntent.parentSessionId.slice(-8)}`
          : "";
        lines.push(`  会话 ${sessionId.slice(-8)} (PID ${sessionIntent.pid}${attribution}):`);
        fileEntries.sort(([a], [b]) => a.localeCompare(b));
        for (const [filePath, intent] of fileEntries) {
          const secondsAgo = Math.floor((Date.now() - intent.lastAccessAt) / 1000);
          const timeAgo =
            secondsAgo < 60 ? `${secondsAgo} 秒前` : `${Math.floor(secondsAgo / 60)} 分钟前`;
          const opLabel =
            intent.operation === "read" ? "读" : intent.operation === "edit" ? "编辑" : "写";
          lines.push(`    · ${filePath} — ${opLabel} (${timeAgo})`);
          // 逻辑键是折叠后的主仓路径，看不出这份意图实际落在哪个 worktree。
          // 两者不同时补一行物理路径，用户才能对上自己的窗口。
          const physicalPath = intent.physicalPath ?? intent.path;
          if (physicalPath !== filePath) {
            lines.push(`      └ 实际路径: ${physicalPath}`);
          }
        }
      }

      const { sameFile, diverged } = groupIntentConflicts(intents);
      if (sameFile.length > 0) {
        lines.push("", "  ⚠ 同文件并发（可能互相覆盖）:");
        for (const conflict of sameFile) {
          const ids = conflict.sessionIds.map((s) => s.slice(-8)).join(", ");
          lines.push(
            `    · ${conflict.physicalPath} — ${conflict.sessionIds.length} 个会话 (${ids})`,
          );
        }
      }
      if (diverged.length > 0) {
        lines.push("", "  ⓘ 分支分叉（各改各的 worktree 副本，合并回主仓时才可能冲突）:");
        for (const divergence of diverged) {
          lines.push(`    · ${divergence.logicalPath}`);
          for (const copy of divergence.copies) {
            lines.push(`      · 会话 ${copy.sessionId.slice(-8)} → ${copy.physicalPath}`);
          }
        }
      }

      if (sameFile.length > 0) {
        lines.push("", "  建议：关闭其他会话，或避开正在被编辑的文件");
      }
      if (diverged.length > 0) {
        // 分叉不靠关会话解决：两个副本会一直分叉到合并为止。给对补救动作才有用。
        lines.push("  提示：分支分叉在合并回主仓时处理即可，无需关闭会话");
      }
      if (sameFile.length === 0 && diverged.length === 0) {
        lines.push("", "  ✔ 无冲突");
      }
    } catch (err) {
      lines.push("", `  查询失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { type: "text", value: lines.join("\n") };
  },
};

export default mod;
