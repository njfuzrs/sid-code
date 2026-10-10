/**
 * 文件读取追踪器
 * 记录哪些文件被 Read 过以及当时的 mtime，
 * Edit/Write 时校验必须先读后改，并检测外部修改
 */

import { statSync, readFileSync } from "fs";
import { resolve } from "path";
import type { ConflictAction, ConflictReport } from "../session/conflict-detector.ts";

/**
 * 新鲜度埋点（F4）：先读后改护栏的拒绝与「bash 改了已读文件」都打一条事件。
 *
 * 为什么要它：此前 stale 拒绝只能靠 grep 报错文案统计，分不清真阳性（IDE 并发改）
 * 与误拦（agent 自己的 bash 改的）——2026-10-10 轨迹核验 3/3 都是后者，但样本只有 3。
 * 是否进一步把 edit 对「真外部修改」也降级（F2），要靠这条事件攒出分母再决定。
 *
 * 与 jit-telemetry 同款模块级 sink：tracker 有 6+ 处创建点（主代理/子代理/fork/btw/mcp-serve），
 * 逐个穿线不现实。App 在 collector 就绪后注入；未注入或写入抛错一律静默。
 */
export const FILE_FRESHNESS_EVENT_NAME = "file_freshness";
export type FileFreshnessSink = (data: Record<string, unknown>) => void;
let freshnessSink: FileFreshnessSink | null = null;

/** 注入/清除新鲜度埋点通道（null = 关闭，测试收尾复位用） */
export function setFileFreshnessTraceSink(s: FileFreshnessSink | null): void {
  freshnessSink = s;
}

function emitFreshness(data: Record<string, unknown>): void {
  try {
    freshnessSink?.(data);
  } catch {
    /* 埋点失败静默 */
  }
}

/** bash 回扫结果里单个文件的记录 */
export interface BashChangedFile {
  path: string;
  /** 文件被删除（record 已移除，后续 edit 会按"没读过"处理） */
  deleted: boolean;
}

/** 文件读取记录 */
interface ReadRecord {
  path: string;
  readTime: number; // 读取时的时间戳
  mtime: number; // 读取时文件的 mtime
  lastAccessTime: number; // 最近一次访问（读/写/编辑）的时间戳（§2.1 post-compact 文件恢复用）
  /**
   * 是否只读取了文件的部分内容（offset/limit 分段读、或超默认行数被截断）。
   * 仅用于决定是否记录 content 快照（部分视图无完整内容，记 null）。
   *
   * ⚠️ 不再作为 edit/write 的拒绝依据（对齐 claude-code）：CC 的普通 read 从不因
   * offset/limit 置此标志，编辑安全性由 edit 自身「从磁盘重读全文 + old_string 精确
   * 串匹配（匹配不到即报错）」保证——模型改到未读区域本就不可能发生。曾据此拒绝会
   * 误杀「读全文 → 编辑 → 定向读定位 → 再编辑」这一改大文件的自然工作流。
   */
  isPartialView: boolean;
  /**
   * 读取时的文件内容（仅完整读取时记录，用于外部修改的内容比对兜底）。
   * mtime 变化不等于内容变化（touch / formatter 重写 / 云同步都会动 mtime），
   * 完整读取时用内容比对避免假"外部修改"误报。部分读取不记（无完整内容可比）。
   */
  content: string | null;
  /**
   * 读后被**本会话自己的 bash 命令**改过（F1）。
   *
   * 由 `noteBashExecution` 在 bash 结束时回扫写入：此时快照已刷新为磁盘当前内容，
   * 所以 edit 的 mtime 校验会自然放行——edit 本身「从磁盘重读全文 + old_string 精确匹配」，
   * 模型拿旧视图拼的 old_string 若已失效会被匹配失败拦下，不会改错。
   *
   * 但**模型上下文里的视图仍是旧的**。write 是整文件覆盖，基于旧视图写会静默冲掉
   * bash（如 formatter）的改动——所以 write 看到此标记仍要求先重新 read。
   * 重新 read（markAsRead 新建 record）即清除。
   */
  changedByBash: boolean;
}

export class FileReadTracker {
  private readFiles = new Map<string, ReadRecord>();

  /**
   * 会话上下文（用于并发冲突检测）。
   * 可选，由 cli.ts 在创建 tracker 后设置。
   */
  sessionId?: string;
  pid?: number;
  cwd?: string;

  /**
   * 并发冲突检测配置（Phase 2.4）。
   * 由 cli.ts 设置，控制是否启用冲突检测及严重程度。
   */
  conflictDetection?: boolean;
  conflictSeverity?: "warn" | "block" | "off";

  /**
   * 并发冲突处理回调（Phase 2.1）。
   * 由 app.ts 设置，工具检测到冲突时调用，弹框等待用户选择。
   * 返回用户选择的 action（stop/skip/continue/worktree）。
   */
  conflictHandler?: (report: ConflictReport) => Promise<ConflictAction>;

  /**
   * 标记文件已被读取。
   *
   * @param mtime 读取时刻的文件 mtime
   * @param opts.isPartialView 是否只读了部分内容（offset/limit/截断）——默认 false（完整读取）
   * @param opts.content 完整读取时的文件内容（用于外部修改的内容比对兜底）——部分读取传 null/省略
   */
  markAsRead(
    filePath: string,
    mtime: number,
    opts?: { isPartialView?: boolean; content?: string | null },
  ): void {
    const resolved = resolve(filePath).normalize("NFC");
    const now = Date.now();
    const isPartialView = opts?.isPartialView ?? false;
    this.readFiles.set(resolved, {
      path: resolved,
      readTime: now,
      mtime,
      lastAccessTime: now,
      isPartialView,
      // 只在完整读取时保留内容（部分视图无完整内容可比，且避免为超大文件常驻内存）
      content: !isPartialView ? (opts?.content ?? null) : null,
      changedByBash: false,
    });
  }

  /** 检查文件是否已被读取过 */
  hasBeenRead(filePath: string): boolean {
    return this.readFiles.has(resolve(filePath).normalize("NFC"));
  }

  /**
   * §2.1：按 lastAccessTime 降序返回最近访问的文件路径（最多 limit 个）。
   * 用于压缩后主动恢复模型最近在操作的文件内容，避免压缩后"断片"重读。
   */
  getRecentFiles(limit: number = 5): string[] {
    return Array.from(this.readFiles.values())
      .sort((a, b) => b.lastAccessTime - a.lastAccessTime)
      .slice(0, limit)
      .map((r) => r.path);
  }

  /**
   * §2.1：返回记录的 mtime（读取时刻的文件 mtime），用于 post-compact 恢复时比对磁盘是否已变更。
   * 未追踪过返回 null。
   */
  getRecordedMtime(filePath: string): number | null {
    const record = this.readFiles.get(resolve(filePath).normalize("NFC"));
    return record ? record.mtime : null;
  }

  /**
   * 验证文件是否可以安全编辑
   * 返回 null 表示可以编辑，返回字符串表示错误原因
   */
  validateForEdit(filePath: string): string | null {
    return this.validateFresh(filePath, "edit");
  }

  /**
   * 验证文件是否可以安全覆盖写入（write 工具用）。
   * 与 edit 共用 validateFresh，唯一差异：读后被本会话 bash 改过的文件（changedByBash），
   * edit 放行、write 仍要求重新 read——理由见 ReadRecord.changedByBash。
   *
   * ⚠️ 调用方只应在「文件已存在」时调用；新建文件（写入即创建）无需先读，不要调用此方法。
   */
  validateForWrite(filePath: string): string | null {
    return this.validateFresh(filePath, "write");
  }

  /**
   * 「先读后改」新鲜度校验的单一事实源，供 edit/write 共用，杜绝两条护栏逻辑漂移。
   *   1. 从没读过 → 拒绝
   *   2. 读后被外部修改（mtime 变且内容确实不同）→ 拒绝
   *   3. 读后被本会话 bash 改过 → edit 放行 / write 拒绝
   *
   * ⚠️ 不再校验 partial-view（对齐 claude-code）：曾据 isPartialView 拒绝部分读取后的
   * 编辑，会误杀「读全文 → 编辑 → 定向读定位 → 再编辑」的自然工作流。编辑安全性由 edit
   * 自身「从磁盘重读全文 + old_string 精确串匹配」保证，无需此门禁。
   */
  private validateFresh(filePath: string, tool: "edit" | "write"): string | null {
    const action = tool === "edit" ? "编辑" : "覆盖写入";
    const resolved = resolve(filePath).normalize("NFC");
    const record = this.readFiles.get(resolved);

    if (!record) {
      emitFreshness({ tool, outcome: "rejected_unread" });
      return `文件必须先用 read 工具读取后才能${action}: ${filePath}`;
    }

    // 检查文件是否在读取后被外部修改
    try {
      const currentMtime = statSync(resolved).mtimeMs;
      if (currentMtime !== record.mtime) {
        // mtime 变了不代表内容变了（touch / formatter 重写 / 云同步都会动 mtime）。
        // 完整读取且记录了内容时，做一次内容比对兜底，避免假"外部修改"误报。
        if (record.content !== null) {
          try {
            const currentContent = readFileSync(resolved, "utf-8");
            if (currentContent === record.content) {
              return null; // 内容一致，仅 mtime 变化，安全放行
            }
          } catch {
            // 读取失败则退回按 mtime 判定（保守报"已修改"）
          }
        }
        emitFreshness({
          tool,
          outcome: "rejected_modified",
          ms_since_read: Date.now() - record.readTime,
        });
        // F3：说清可能来源 + 下一步。bash 前台命令的改动已由 noteBashExecution 吸收，
        // 走到这里的是 bash 之外的改动（IDE / 外部格式化 / 后台命令 / 其他进程）。
        return (
          `文件自上次读取后已被外部修改，请重新读取后再${action}: ${filePath}\n` +
          `（改动来自本会话前台 bash 之外：如 IDE 编辑、保存时格式化、后台命令或其他进程。` +
          `重新 read 后基于最新内容再改，避免覆盖他人的改动。）`
        );
      }
    } catch {
      // 文件可能已被删除，让后续操作处理
    }

    if (tool === "write" && record.changedByBash) {
      emitFreshness({ tool, outcome: "rejected_changed_by_bash" });
      return (
        `文件读取后已被你执行的 bash 命令修改，你看到的内容已过期，请重新读取后再${action}: ${filePath}\n` +
        `（write 会整文件覆盖，基于旧内容写会冲掉 bash 命令的改动；局部修改可直接用 edit。）`
      );
    }

    return null;
  }

  /**
   * F1：bash 命令结束后回扫已追踪文件，吸收「本会话 bash 改了已读文件」这类改动。
   *
   * 根因（2026-10-10 轨迹核验）：tracker 只认 read/edit/write，bash 写盘（oxfmt、`perl -pi`、
   * `sed -i`…）对它不可见，于是 agent 自己刚格式化完的文件，下一次 edit 被判「外部修改」拒绝；
   * 3/3 例重读后提交的 old/new_string 与被拒那次逐字相同——纯误拦，白烧 read+edit 两轮。
   *
   * 处理：mtime 变了且内容确实不同的文件，快照刷新为磁盘当前内容并打 changedByBash 标记；
   * 返回变更清单，由 bash 工具追加到结果末尾告知模型（让它知道自己的视图过期了）。
   *
   * ⚠️ 归因边界：bash 运行期间如果恰好有别的进程（IDE）也改了同一文件，会被一并记到 bash 名下。
   * 这对 edit 无害（edit 以磁盘最新内容做 old_string 精确匹配，不会覆盖他人改动），
   * 对 write 也无害（changedByBash 仍要求重读）——损失的只是报错文案里的归因精度。
   * 后台命令（run_in_background）不回扫：它结束时不经过这里，其改动仍按外部修改拦截。
   */
  noteBashExecution(): BashChangedFile[] {
    const changed: BashChangedFile[] = [];
    for (const [resolved, record] of this.readFiles) {
      let currentMtime: number;
      try {
        currentMtime = statSync(resolved).mtimeMs;
      } catch {
        // 被 bash 删掉了：移除记录，后续 edit/write 会按"没读过 / 新建"处理
        this.readFiles.delete(resolved);
        changed.push({ path: resolved, deleted: true });
        continue;
      }
      if (currentMtime === record.mtime) continue;

      let currentContent: string | null = null;
      try {
        currentContent = readFileSync(resolved, "utf-8");
      } catch {
        // 读不了内容：保守按"已变更"处理（快照置空，只靠 mtime）
      }
      record.mtime = currentMtime;
      if (currentContent !== null && currentContent === record.content) {
        continue; // 仅 mtime 变（touch 之类），内容没变，不算变更、不打扰模型
      }
      // 部分读取的记录没有完整快照可比，mtime 变了就按变更处理
      record.content = record.isPartialView ? null : currentContent;
      record.changedByBash = true;
      changed.push({ path: resolved, deleted: false });
    }
    if (changed.length > 0) {
      emitFreshness({
        tool: "bash",
        outcome: "bash_changed_tracked_files",
        files_changed: changed.length,
        files_deleted: changed.filter((c) => c.deleted).length,
      });
    }
    return changed;
  }

  /**
   * 更新文件的 mtime 与内容快照（写入/编辑后调用）。
   *
   * ⚠️ 刻意不清 changedByBash：edit 只交了片段，bash 改动的其余部分模型仍没看过；
   * 而带标记时 write 必被拒（见 validateFresh），只有重新 read 能清——不存在需要在这里清的路径。
   */
  updateMtime(filePath: string, newContent?: string): void {
    const resolved = resolve(filePath).normalize("NFC");
    const record = this.readFiles.get(resolved);
    if (record) {
      try {
        record.mtime = statSync(resolved).mtimeMs;
        record.readTime = Date.now();
        record.lastAccessTime = Date.now(); // §2.1：写/编辑也算一次访问
        // 编辑后内容已知 → 同步刷新内容快照，否则下次 validateForEdit 的内容比对
        // 会拿旧内容比对，把"自己刚写的新内容"误判为外部修改。
        // 编辑必产出完整新内容，故写入后一定是完整视图。
        if (newContent !== undefined) {
          record.content = newContent;
          record.isPartialView = false;
        }
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 统一注入会话上下文（用于并发冲突检测）。
   * 主会话和子代理都通过此方法设置 sessionId/pid/cwd，避免字段散落。
   *
   * @param context 会话上下文（sessionId/pid/cwd）
   */
  applySessionContext(context: { sessionId: string; pid: number; cwd: string }): void {
    this.sessionId = context.sessionId;
    this.pid = context.pid;
    this.cwd = context.cwd;
  }

  /** 清空所有记录 */
  clear(): void {
    this.readFiles.clear();
  }
}
