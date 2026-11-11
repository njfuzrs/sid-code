/**
 * 文件读取追踪器
 * 记录哪些文件被 Read 过以及当时的 mtime，
 * Edit/Write 时校验必须先读后改，并检测外部修改
 */

import { statSync, readFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "node:crypto";
import type { ConflictAction, ConflictReport } from "../session/conflict-detector.ts";

/**
 * 内容指纹（sha256 前 16 位十六进制）。
 *
 * 为什么要它：完整读取时 tracker 存全文可比对，但**部分读取**（offset/limit 分段、
 * 超行数截断）没有完整内容可存，于是 `noteBashExecution` 只能按 mtime 判定——只要
 * mtime 变了就报「本命令改了它」。`touch`、formatter 重写、云同步、IDE 保存都会动
 * mtime 而不改内容，这层误报会白烧模型的轮次（附件 A §13.4 的现场样本：md5 没变
 * 却被告知改了）。
 *
 * 只存指纹不存全文：部分读取的文件可能是超大文件，常驻全文在内存里不划算。
 * 算法与口径必须与 `noteBashExecution` 的比对一致——两边都用**磁盘原始内容**
 * （`readFileSync(path, "utf-8")`，含 BOM）算，否则带 BOM 的文件会永远判"变了"。
 */
export function contentFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

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
  /**
   * 归因（CG-4）：这条改动到底是谁干的。
   *   - `command`  —— 命令执行前还是读取时的 mtime，执行后变了的：算本命令改动
   *   - `external` —— 命令**开始执行前**就已经变了：是读取之后被外部改的，与本命令无关
   *
   * 为什么必须分开：此前没有执行前快照，执行前就已经发生的改动会被一并算到命令头上，
   * 模型看到「本命令修改了 X」而它明明只是 `cat`/`grep`，于是质疑「我没改它」。
   */
  attribution: "command" | "external";
}

/**
 * bash 执行前拍下的快照（CG-4）。
 * `mtimes` 是「命令开始执行那一刻」每个已读文件的 mtime；执行后只有 mtime 与这里不同
 * 的文件才可能算本命令改动。
 */
export interface BashMtimeSnapshot {
  mtimes: Map<string, number>;
  /** 拍快照时就已经变了（读取后、命令前被外部改）的文件，直接归 external */
  alreadyChanged: BashChangedFile[];
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
   * 读取时刻的内容指纹（sha256 前 16 位，见 `contentFingerprint`）。
   *
   * 为什么完整读取也要存：`noteBashExecution` 的归因判据此前对完整读取用
   * `content === 磁盘内容`、对部分读取只能退回 mtime——两条口径并存，部分读取那条
   * 只要 mtime 变了就报（CG-4 的根因）。现在统一成「先比指纹」，mtime 只当快速路径。
   *
   * ⚠️ 指纹必须基于**磁盘原始内容**（含 BOM）算，与回扫时的 `readFileSync` 同一口径；
   * 拿 read 工具剥离 BOM 后的文本算会让带 BOM 的文件永远判"变了"。
   */
  contentHash: string | null;
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
   * PR-2（B3）：子代理 tracker 专属——sessionId 是子代理自己的 agentId 时，
   * 这里记父会话 ID，随 declareFileIntent 写进意图文件供归属展示。主会话不设。
   */
  parentSessionId?: string;

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
   * @param opts.contentHash 读取时刻**磁盘原始内容**的指纹（见 contentFingerprint）。
   *   调用方手里有原始内容时传它可省一次全文读取；不传时本方法会自己读磁盘补齐
   *   （部分读取必须补，否则 CG-4 那个「mtime 变了就报」的漏洞又回来了）。
   */
  markAsRead(
    filePath: string,
    mtime: number,
    opts?: { isPartialView?: boolean; content?: string | null; contentHash?: string | null },
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
      contentHash: this.resolveContentHash(resolved, opts),
      changedByBash: false,
    });
  }

  /**
   * 取读取时刻的内容指纹。
   *
   * 优先级：调用方给的指纹 > 调用方给的全文 > 自己读磁盘。
   * 自己读这一档是**兜底而非主路径**：它保证「部分读取没传指纹」时也不会退回 mtime 判定，
   * 代价是多一次全文 IO——所以 read / read-many 会主动传，别让这条路成为常态。
   */
  private resolveContentHash(
    resolved: string,
    opts?: { content?: string | null; contentHash?: string | null },
  ): string | null {
    if (opts?.contentHash) return opts.contentHash;
    if (opts?.content) return contentFingerprint(opts.content);
    try {
      // 与 noteBashExecution 的比对同口径：磁盘原始内容（含 BOM）
      return contentFingerprint(readFileSync(resolved, "utf-8"));
    } catch {
      // 读不到（权限 / 已删除 / 超大）：退回 mtime 判定，与改造前行为一致
      return null;
    }
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

  /** 该文件在本 tracker 里没有读取记录 */
  isUnread(filePath: string): boolean {
    return !this.hasBeenRead(filePath);
  }

  /**
   * 「从没读过」拒绝的单一出口（文案 + 埋点），供 validateFresh 与 edit 的延后判定共用。
   *
   * @param matchStrategy edit 延后判定时实际命中的策略（none / flexible / regex / fuzzy），
   *   用于区分「old_string 没精确命中所以拒」与「压根没走到匹配」两类分母。
   */
  rejectUnread(filePath: string, tool: "edit" | "write", matchStrategy?: string): string {
    const action = tool === "edit" ? "编辑" : "覆盖写入";
    emitFreshness({
      tool,
      outcome: "rejected_unread",
      ...(matchStrategy ? { match_strategy: matchStrategy } : {}),
    });
    if (matchStrategy) {
      return (
        `文件必须先用 read 工具读取后才能${action}: ${filePath}\n` +
        `（未读文件只在 old_string 于磁盘内容中精确命中时放行；本次${
          matchStrategy === "none" ? "未命中" : "只能近似命中"
        }，近似匹配在没看过文件时可能改错位置。）`
      );
    }
    return `文件必须先用 read 工具读取后才能${action}: ${filePath}`;
  }

  /** edit 对未读文件精确命中放行时的埋点（与 rejected_unread 构成同一分母） */
  noteUnreadExactEdit(): void {
    emitFreshness({ tool: "edit", outcome: "allowed_unread_exact" });
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
      return this.rejectUnread(filePath, tool);
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
   * CG-4：bash 命令**开始执行前**拍一份 mtime 快照，把「归因基准」从「读取那一刻」
   * 推进到「命令开始那一刻」。
   *
   * 为什么需要它：改造前 `noteBashExecution` 拿「读取时 mtime」当唯一基准，于是
   * **读取之后、命令之前**发生的任何外部改动（IDE 保存、另一个进程格式化、云同步）
   * 都会被算到这条命令头上。模型跑一条 `cat`/`grep` 却被告知「你刚改了这些文件」，
   * 于是质疑「我没改它」——这是 H5 的第二半根因（第一半是部分读取没有内容指纹）。
   *
   * 拍快照时就已经变了的文件直接吸收并归 `external`：一次性把「读取后外部改动」从
   * 本命令的账上摘出去，同时避免同一处改动被重复告知。
   *
   * 跳过条件与 `withTrackedFileChanges` 完全一致（只读 / 后台命令不拍），否则
   * 只读命令会把「读取后外部改动」提前报出来，凭空多一层噪音。
   */
  beginBashExecution(): BashMtimeSnapshot {
    const mtimes = new Map<string, number>();
    const alreadyChanged: BashChangedFile[] = [];

    for (const [resolved, record] of this.readFiles) {
      let currentMtime: number;
      try {
        currentMtime = statSync(resolved).mtimeMs;
      } catch {
        // 读取后（命令前）就被外部删了：不是本命令干的，移除记录并告知
        this.readFiles.delete(resolved);
        alreadyChanged.push({ path: resolved, deleted: true, attribution: "external" });
        continue;
      }

      if (currentMtime === record.mtime) {
        mtimes.set(resolved, currentMtime);
        continue;
      }

      // mtime 变了：比内容指纹，区分「真的改了」与「只 touch 了一下」
      const currentContent = this.readFileContent(resolved);
      record.mtime = currentMtime;
      if (!this.contentDiffers(record, currentContent)) {
        mtimes.set(resolved, currentMtime);
        continue;
      }

      this.absorbChange(record, currentContent);
      alreadyChanged.push({ path: resolved, deleted: false, attribution: "external" });
    }

    return { mtimes, alreadyChanged };
  }

  /**
   * F1 + CG-4：bash 命令结束后回扫已追踪文件，吸收「本会话 bash 改了已读文件」这类改动。
   *
   * 根因（2026-10-10 轨迹核验）：tracker 只认 read/edit/write，bash 写盘（oxfmt、`perl -pi`、
   * `sed -i`…）对它不可见，于是 agent 自己刚格式化完的文件，下一次 edit 被判「外部修改」拒绝；
   * 3/3 例重读后提交的 old/new_string 与被拒那次逐字相同——纯误拦，白烧 read+edit 两轮。
   *
   * 处理：mtime 变了且内容确实不同的文件，快照刷新为磁盘当前内容并打 changedByBash 标记；
   * 返回变更清单，由 bash 工具追加到结果末尾告知模型（让它知道自己的视图过期了）。
   *
   * 归因（CG-4）：
   *   - 传 `snapshot`（BashTool 的正常路径）→ 只有「执行前还是读取时的 mtime、执行后变了」
   *     才算本命令改动；快照里已经变了的按 `external` 原样带出（已在 `beginBashExecution`
   *     吸收过，这里只负责告知）。
   *   - 不传 `snapshot` → 退回改造前口径（一切变化都算本命令），供未接快照的调用方使用。
   *
   * ⚠️ 仍然存在的归因窗口：命令**执行期间**有并行进程恰好改了同一文件，会被算成本命令
   * 改动。这个窗口没法靠快照消除（要么每写一次文件就 fs-watch，成本远超收益），
   * 只能由文案兜底说明——所以「本命令改动」不是绝对归因，只是「本命令执行窗口内发生」。
   *
   * 后台命令（run_in_background）不回扫：它结束时不经过这里，其改动仍按外部修改拦截。
   */
  noteBashExecution(snapshot?: BashMtimeSnapshot): BashChangedFile[] {
    const changed: BashChangedFile[] = snapshot ? [...snapshot.alreadyChanged] : [];
    const targets = snapshot
      ? Array.from(snapshot.mtimes.keys())
      : Array.from(this.readFiles.keys());

    for (const resolved of targets) {
      const record = this.readFiles.get(resolved);
      if (!record) continue; // 快照后被重新 read（旧记录已被替换）

      let currentMtime: number;
      try {
        currentMtime = statSync(resolved).mtimeMs;
      } catch {
        // 被 bash 删掉了：移除记录，后续 edit/write 会按"没读过 / 新建"处理
        this.readFiles.delete(resolved);
        changed.push({ path: resolved, deleted: true, attribution: "command" });
        continue;
      }

      // 基准取「命令开始执行前」的 mtime；无快照时退回「读取时」的 mtime（改造前行为）
      const beforeMtime = snapshot ? snapshot.mtimes.get(resolved)! : record.mtime;
      if (currentMtime === beforeMtime) continue;

      const currentContent = this.readFileContent(resolved);
      record.mtime = currentMtime;
      if (!this.contentDiffers(record, currentContent)) {
        continue; // 仅 mtime 变（touch 之类），内容没变，不算变更、不打扰模型
      }

      this.absorbChange(record, currentContent);
      changed.push({ path: resolved, deleted: false, attribution: "command" });
    }

    if (changed.length > 0) {
      const byCommand = changed.filter((c) => c.attribution === "command");
      emitFreshness({
        tool: "bash",
        outcome: "bash_changed_tracked_files",
        files_changed: byCommand.filter((c) => !c.deleted).length,
        files_deleted: byCommand.filter((c) => c.deleted).length,
        // CG-4：执行前就已变了（不是本命令）的文件单独计数——这条指标回答
        // 「误归因还剩多少」，改造前它被混进 files_changed，看不出来。
        files_external: changed.filter((c) => c.attribution === "external").length,
      });
    }
    return changed;
  }

  /** 读磁盘原始内容（与 contentFingerprint 的口径一致）；读不到返回 null，由调用方保守处理 */
  private readFileContent(resolved: string): string | null {
    try {
      return readFileSync(resolved, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 磁盘内容与读取时记录相比是否真的变了。
   *
   * 判据优先级：内容指纹 → 全文（老记录兜底）→ 视为已变（保守）。
   * 指纹优先是为了让**部分读取**也有可比基准——改造前部分读取 record.content 恒为 null，
   * 只要 mtime 变了就报，`touch` 也算，这是 CG-4 的主误报来源。
   */
  private contentDiffers(record: ReadRecord, currentContent: string | null): boolean {
    if (currentContent === null) return true; // 读不到内容：保守按已变更
    if (record.contentHash !== null) {
      return contentFingerprint(currentContent) !== record.contentHash;
    }
    if (record.content !== null) return currentContent !== record.content;
    return true;
  }

  /** 确认内容真变了之后统一刷新快照（内容 + 指纹 + 标记），完整/部分读取共用 */
  private absorbChange(record: ReadRecord, currentContent: string | null): void {
    // 部分读取仍不存全文（避免超大文件常驻内存），只把指纹推进到磁盘当前内容
    record.content = record.isPartialView ? null : currentContent;
    record.contentHash = currentContent === null ? null : contentFingerprint(currentContent);
    record.changedByBash = true;
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
   * PR-2（B3）：子代理传自己的 agentId 作 sessionId + parentSessionId 作归属，
   * 主会话不传 parentSessionId。
   *
   * @param context 会话上下文（sessionId/pid/cwd，可选 parentSessionId）
   */
  applySessionContext(context: {
    sessionId: string;
    pid: number;
    cwd: string;
    parentSessionId?: string;
  }): void {
    this.sessionId = context.sessionId;
    this.pid = context.pid;
    this.cwd = context.cwd;
    this.parentSessionId = context.parentSessionId;
  }

  /** 清空所有记录 */
  clear(): void {
    this.readFiles.clear();
  }
}
