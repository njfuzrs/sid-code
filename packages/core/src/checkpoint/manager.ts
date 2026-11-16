/**
 * Checkpoint 文件快照管理器
 * 在 write/edit 工具执行前自动保存文件快照，支持 /undo 回滚
 *
 * 存储策略：
 * - 第一次保存完整内容（>1KB 时 gzip 压缩 + base64）
 * - 二进制文件（含 NUL / 非法 UTF-8）按原始字节 base64 存 full，不做 diff（N13）
 * - 后续保存增量 diff（LCS 算法）
 * - 每文件最多 50 个 checkpoint，总共最多 200MB，30 天自动清理
 * - 超过 maxFileSizeMb（默认 5MB）的单文件不进快照（P3）
 * - 存储路径：~/.sid-code/checkpoints/<session-id>/
 *
 * P3：**索引分片落盘**。`index.json` 只存头（version / sessionId / createdAt / nextId），
 * 每个快照单独写 `snapshots/<id>.json`，一次快照只写 1 个新分片 + 几百字节头。
 *
 * 修之前是所有快照内联在 index.json 里、每次快照整份 stringify 两次再整份写盘：
 * 一次 `ls -la` 把 79MB 的编译产物收进索引后，24 个快照就把 index.json 撑到 42MB，
 * 单个快照 38–88ms 主线程阻塞、864MB 累计写盘（写放大 O(N²)）。
 * 现在写放大是 O(N)：新内容只写进自己的分片，老分片不被重写。
 */

import { join } from "path";
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, rmSync, unlinkSync } from "fs";
import { computeDiff, type DiffResult } from "./diff.ts";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import type { CheckpointConfig } from "../config/config.ts";

/** 快照组：一次工具调用产生的所有文件变更 */
export interface Snapshot {
  /** 快照 ID（自增短 ID，如 "s1", "s2"） */
  id: string;
  /** 创建时间 */
  timestamp: number;
  /** 触发快照的工具名称 */
  toolName: string;
  /** 触发快照的工具参数摘要（如文件路径） */
  toolSummary: string;
  /** 关联的消息 ID（可选，用于定位对话上下文） */
  messageId?: string;
  /** 包含的文件变更列表 */
  files: SnapshotFile[];
  /**
   * P3：因超过 `maxFileSizeMb` 而未进快照的文件。
   *
   * 这些文件**没有**被保护：`/undo` / `/restore` 回退不到它们。
   * 落盘保留这份清单是为了让命令层能如实告知用户「哪些文件没被快照」，
   * 而不是让用户以为所有改动都能回退（静默的不完整保护比没有更危险）。
   *
   * P4：`reason` 区分两类跳过原因——缺省（即字段不存在）表示 `too-large`（超过单文件上限），
   * `non-regular` 表示目录 / 设备 / FIFO / socket / 软链（本来就不该进快照）。
   * 展示层据此选文案：把设备文件说成「超过单文件上限」是另一种撒谎。
   * 缺省即 too-large 而不是写显式值，是为了让**已落盘的老分片**（那时只有这一种原因）
   * 不需要任何迁移就仍然语义正确。
   * 非普通文件的 `bytes` 恒为 0——「字节数」对它们没有意义。
   */
  skippedFiles?: Array<{ filePath: string; bytes: number; reason?: "non-regular" }>;
}

/** 快照中的单个文件 */
export interface SnapshotFile {
  /** 文件路径 */
  filePath: string;
  /** 文件在快照前是否存在（false 表示新创建的文件） */
  existedBefore: boolean;
  /** 存储类型 */
  type: "full" | "diff";
  /** 完整内容（type=full 时） */
  content?: string;
  /** 是否压缩 */
  compressed?: boolean;
  /** 增量差异（type=diff 时） */
  diff?: DiffResult;
  /**
   * N13：content 是原始字节的 base64（compressed 时是 gzip 后字节的 base64），不是 UTF-8 文本。
   * 二进制文件一律存 full（diff 对字节无意义）；缺省 = 文本（老索引无此字段，按文本读）。
   */
  binary?: boolean;
}

/**
 * N13：快照内容的内存形态。文本走 string（可做 diff），二进制走 Uint8Array（原样字节）。
 *
 * 为什么不统一成字节：diff 链、压缩阈值、淘汰重锚定全部建立在 string 上，改成字节
 * 要重写整条链路，而二进制本来就不做 diff。只在「读入 / 存储 / 写回」三个边界区分两种形态。
 */
type FileContent = string | Uint8Array;

/**
 * N13：按**字节**判定是否二进制——含 NUL，或不是合法 UTF-8。
 *
 * 修之前整条链路用 `Bun.file().text()` 读，非法字节被有损替换成 U+FFFD（不抛错、不可逆），
 * PNG 头 13 字节回滚成 23 字节垃圾。判据不能靠扩展名猜：`rm ./data.bin` 与无扩展名的
 * 编译产物都会经 bash 入口进快照。
 * 返回 null = 二进制；否则返回解码后的文本（ignoreBOM 保留 BOM，保证文本也字节级往返）。
 */
function decodeTextOrNull(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * P4：路径在「快照」视角下的类型。
 *
 * - `absent`：路径不存在（保持原有语义：当作新建文件，回退时删除）
 * - `regular`：普通文件（可以读内容、回滚时写回）
 * - `non-regular`：目录 / 字符设备 / 块设备 / FIFO / socket / 符号链接
 *
 * 为什么必须用 lstat 而不是 `Bun.file(p).exists()`：后者的语义是「**是不是一个可读的
 * 普通文件**」，不是「路径是否存在」（本机 bun 1.4.2 实测：目录、`/dev/null` 一律 false）。
 * 拿它当 `existedBefore` 的判据，会把目录/设备记成「新建文件 + 空内容」——回退时
 * `unlinkSync` 必然失败（设备 EPERM、非空目录 EPERM/EISDIR），`/undo` 于是被永久卡住。
 *
 * 为什么用 lstat 而不是 stat：`stat` 会跟随软链，于是「软链指向真文件」会被当成普通文件
 * 快照，回退时写回那个路径会**写穿链接、改坏 target**。lstat 让软链落进 non-regular。
 *
 * 判据刻意不依赖 errno（EPERM / EISDIR / ENOTEMPTY）：三个平台的错误码不一致，
 * 靠 `catch` 分支会漏，必须在动手删除之前用类型判断。
 */
function classifyPathForSnapshot(filePath: string): "absent" | "regular" | "non-regular" {
  const st = lstatSync(filePath, { throwIfNoEntry: false });
  if (!st) return "absent";
  return st.isFile() ? "regular" : "non-regular";
}

/** N13：两份快照内容是否相同（形态不同即视为不同，触发写 full）。 */
function sameContent(a: FileContent, b: FileContent): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return Buffer.from(a).equals(Buffer.from(b));
}

/** N13：从 full 条目解出内容（文本 / 二进制 × 压缩 / 不压缩）。 */
function decodeFullEntry(f: SnapshotFile): FileContent {
  if (f.binary) {
    const raw = Buffer.from(f.content ?? "", "base64");
    return new Uint8Array(f.compressed ? Bun.gunzipSync(raw) : raw);
  }
  if (f.compressed && f.content) {
    return Buffer.from(Bun.gunzipSync(Buffer.from(f.content, "base64"))).toString("utf-8");
  }
  return f.content ?? "";
}

/** N13：把内容编码进 full 条目（原地改写 content/compressed/binary）。 */
function encodeFullEntry(
  f: SnapshotFile,
  content: FileContent,
  compressThresholdBytes: number,
): void {
  if (typeof content === "string") {
    f.binary = undefined;
    if (content.length > compressThresholdBytes) {
      f.content = Buffer.from(Bun.gzipSync(Buffer.from(content, "utf-8"))).toString("base64");
      f.compressed = true;
    } else {
      f.content = content;
      f.compressed = false;
    }
    return;
  }
  f.binary = true;
  if (content.length > compressThresholdBytes) {
    // gzipSync 的签名只收 ArrayBuffer 背书的 Uint8Array（排除 SharedArrayBuffer）。
    // 这里的字节来自 Bun.file().bytes() / 调用方传入的普通缓冲区，不会是共享内存，
    // 所以收窄类型即可；用 new Uint8Array(content) 拷一份也能过类型，但对大文件是白付一次复制。
    f.content = Buffer.from(Bun.gzipSync(content as Uint8Array<ArrayBuffer>)).toString("base64");
    f.compressed = true;
  } else {
    f.content = Buffer.from(content).toString("base64");
    f.compressed = false;
  }
}

/** 索引文件格式（新版） */
export interface CheckpointIndex {
  sessionId: string;
  createdAt: number;
  /** 快照序列号计数器 */
  nextId: number;
  /** 按时间顺序排列的快照列表 */
  snapshots: Snapshot[];
  // N8：曾有 `latestFullMap`（文件 → 全局最新 full 快照 id），4 处维护 / 0 处消费，
  // 且口径就用不上 —— 重建内容要的是「≤ targetIndex 的最近 full」，不是全局最新，
  // 所以 rebuildContentAtSnapshot 一直走线性倒扫。已删除；旧 index.json 里的该字段
  // 在 init / 继承时剥离（stripLegacyFields），不再落盘。
}

/** 剥离旧版 index.json 里已废弃的字段（N8：latestFullMap），避免原样回写落盘。 */
function stripLegacyFields(index: CheckpointIndex): CheckpointIndex {
  delete (index as { latestFullMap?: unknown }).latestFullMap;
  return index;
}

/**
 * P3：分片索引格式版本。2 = `index.json` 只存头，快照逐个落在 `snapshots/<id>.json`。
 * 缺省（无 version 字段）= 旧格式，所有快照内联在 index.json 里，init 时迁移。
 */
const INDEX_VERSION = 2;

/** 快照分片所在子目录（相对会话 checkpoint 目录） */
const SNAPSHOTS_SUBDIR = "snapshots";

/** P3：分片格式的 index.json（只存头，不存快照内容） */
interface ShardedIndexHead {
  version: number;
  sessionId: string;
  createdAt: number;
  /** 快照 id 计数器；init 时会自愈为 max(此值, 最大分片序号 + 1) */
  nextId: number;
}

/** 旧版索引格式（兼容） */
interface LegacyCheckpointEntry {
  filePath: string;
  timestamp: number;
  type: "full" | "diff";
  content?: string;
  compressed?: boolean;
  diff?: DiffResult;
}

interface LegacyFileCheckpoints {
  filePath: string;
  entries: LegacyCheckpointEntry[];
}

interface LegacyCheckpointIndex {
  sessionId: string;
  createdAt: number;
  files: Record<string, LegacyFileCheckpoints>;
}

/** Undo 结果 */
export interface UndoResult {
  /** 回滚的快照 ID */
  snapshotId: string;
  /** 回滚的文件列表 */
  files: Array<{
    filePath: string;
    /** restored=恢复了内容, deleted=删除了新创建的文件 */
    action: "restored" | "deleted";
  }>;
}

/** Restore 结果 */
export interface RestoreResult {
  /** 恢复到的目标快照 ID */
  targetSnapshotId: string;
  /** 回滚了多少个快照 */
  snapshotsRolledBack: number;
  /** 受影响的文件列表 */
  files: Array<{
    filePath: string;
    action: "restored" | "deleted";
  }>;
  /**
   * N4：**未能回滚**的文件路径（磁盘仍停在回滚前的状态）。
   *
   * 修复前这类文件既不回滚、也不进 `files`，调用方只能看到
   * `snapshotsRolledBack: 2` 这种"看着像全回滚了"的数字 ⇒ 静默失败。
   * 命令层（/rewind、/restore）应当在非空时明确告知用户哪些文件没回滚成功。
   */
  failedFiles: string[];
}

/** 快照摘要 */
export interface SnapshotSummary {
  id: string;
  timestamp: number;
  toolName: string;
  toolSummary: string;
  fileCount: number;
}

export class CheckpointManager {
  private sessionId: string;
  private baseDir: string;
  private index: CheckpointIndex;
  private dirty: boolean = false;
  private config: Required<CheckpointConfig>;

  // ── P3：分片落盘的增量状态 ──
  /** 本次变更里需要重写分片的快照 id（只重写这些，不重写历史分片） */
  private dirtySnapshotIds = new Set<string>();
  /** 本次变更里已从内存移除、需要 unlink 分片的快照 id */
  private removedSnapshotIds = new Set<string>();
  /** 已确认落在盘上的快照 id；落盘前用它做双向兜底，漏标脏不会让快照静默丢失 */
  private persistedIds = new Set<string>();
  /** 每个快照分片的序列化字节数（写盘时算一次，供 evictBySize 增量求和） */
  private snapshotBytes = new Map<string, number>();
  /** 全部分片的字节数之和（O(1) 维护，替代每次 stringify 整份索引） */
  private totalSnapshotBytes = 0;
  /** index.json 头本身的字节数（几百字节，每次落盘顺手算） */
  private headBytes = 0;
  /** 本次变更里已算好 JSON 的快照（stringify 只做一次，写盘直接复用） */
  private pendingJson = new Map<string, string>();

  constructor(sessionId: string, config?: CheckpointConfig) {
    this.sessionId = sessionId;
    this.baseDir = sidPaths.checkpoints(sessionId);
    this.index = {
      sessionId,
      createdAt: Date.now(),
      nextId: 1,
      snapshots: [],
    };

    // 合并默认配置
    this.config = {
      enabled: config?.enabled ?? true,
      maxCheckpointsPerFile: config?.maxCheckpointsPerFile ?? 50,
      maxTotalSizeMb: config?.maxTotalSizeMb ?? 200,
      maxAgeDays: config?.maxAgeDays ?? 30,
      compressThresholdKb: config?.compressThresholdKb ?? 1,
      largeFileThresholdLines: config?.largeFileThresholdLines ?? 1000,
      hugeFileThresholdLines: config?.hugeFileThresholdLines ?? 10000,
      // P3：5MB。挡的是编译产物 / 大资产（实测 79MB 的 sid-code 二进制），
      // 同时保留绝大多数源码与中小资源——PNG 图标这类小二进制仍能字节级回退（N13）。
      maxFileSizeMb: config?.maxFileSizeMb ?? 5,
    };
  }

  /** 初始化：创建目录 + 加载索引 */
  async init(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }

    const indexPath = join(this.baseDir, "index.json");
    if (existsSync(indexPath)) {
      try {
        const data = await Bun.file(indexPath).text();
        const parsed = JSON.parse(data);

        if (parsed.version === INDEX_VERSION) {
          // P3 分片格式：index.json 只有头，快照逐个读分片目录。
          // loadSnapshotShards 顺手把每个分片的字节数与「已落盘 id」填进增量状态。
          const loaded = await this.loadSnapshotShards();
          this.index = {
            sessionId: parsed.sessionId ?? this.sessionId,
            createdAt: parsed.createdAt ?? Date.now(),
            // nextId 自愈：上一轮若在「写完分片、还没写头」之间中断，头里的 nextId 会落后于
            // 实际最大分片序号；不回填的话新快照会复用 id、把旧分片覆盖掉。
            nextId: Math.max(parsed.nextId ?? 1, this.maxShardSeq + 1),
            snapshots: loaded,
          };
          this.headBytes = Buffer.byteLength(data, "utf-8");
        } else if (parsed.files && !parsed.snapshots) {
          // 旧格式（files 字段）：先迁移成 snapshots 结构，再按分片格式落盘。
          this.index = this.migrateLegacyIndex(parsed as LegacyCheckpointIndex);
          this.markAllSnapshotsDirty();
          await this.saveIndex();
        } else {
          // 旧格式（所有快照内联在 index.json 里）：剥离废弃字段后改写成分片。
          this.index = stripLegacyFields(parsed as CheckpointIndex);
          this.markAllSnapshotsDirty();
          await this.saveIndex();
        }
      } catch (err: any) {
        // 索引损坏，重新创建
        getLogger().warn("CHECKPOINT", `索引读取失败，重建空索引: ${err?.message ?? String(err)}`);
        this.index = {
          sessionId: this.sessionId,
          createdAt: Date.now(),
          nextId: 1,
          snapshots: [],
        };
      }
    }

    // 清理过期的其他会话
    this.cleanupOldSessions();
  }

  /** 分片目录：`<session>/snapshots` */
  private shardDir(): string {
    return join(this.baseDir, SNAPSHOTS_SUBDIR);
  }

  /** 某个快照分片的路径 */
  private shardPath(id: string): string {
    return join(this.shardDir(), `${id}.json`);
  }

  /**
   * 从 `s<N>` 解出序号；解不出返回 0（排序时排最前，不影响正确性）。
   * 用数值而不是字典序：`s10` 在字典序里小于 `s2`，按字典序加载会把时间序打乱，
   * `rebuildContentAtSnapshot` 的 diff 链就会从中间断掉。
   */
  private static shardSeq(id: string): number {
    const n = Number.parseInt(id.replace(/^s/, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** 本次加载到的最大分片序号（供 nextId 自愈） */
  private maxShardSeq = 0;

  /**
   * 读一个会话目录下的全部快照分片（按时间序）。
   *
   * 单个分片损坏只跳过那一个并告警——旧格式是单文件，一处损坏就得整份丢弃；
   * 分片后损坏是局部事件，没有理由让它带走整个会话的回退历史。
   */
  private async readSnapshotShardsFrom(dir: string): Promise<Snapshot[]> {
    const shardDir = join(dir, SNAPSHOTS_SUBDIR);
    if (!existsSync(shardDir)) return [];

    const log = getLogger();
    const loaded: Array<{ seq: number; snap: Snapshot }> = [];
    for (const name of readdirSync(shardDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await Bun.file(join(shardDir, name)).text();
        const snap = JSON.parse(raw) as Snapshot;
        if (!snap?.id || !Array.isArray(snap.files)) throw new Error("缺少 id / files");
        loaded.push({ seq: CheckpointManager.shardSeq(snap.id), snap });
      } catch (err: any) {
        log.warn("CHECKPOINT", `快照分片损坏，已跳过 ${name}: ${err?.message ?? String(err)}`);
      }
    }
    loaded.sort((a, b) => a.seq - b.seq);
    return loaded.map((x) => x.snap);
  }

  /** 加载当前会话的分片，并把字节数 / 已落盘 id 填进增量状态（不重复读盘）。 */
  private async loadSnapshotShards(): Promise<Snapshot[]> {
    const shards = await this.readSnapshotShardsFrom(this.baseDir);
    const shardDir = this.shardDir();
    for (const snap of shards) {
      try {
        const bytes = statSync(join(shardDir, `${snap.id}.json`)).size;
        this.snapshotBytes.set(snap.id, bytes);
        this.totalSnapshotBytes += bytes;
      } catch {
        // stat 失败不影响功能：大小统计退化为 0，evictBySize 少算这一份。
      }
      this.persistedIds.add(snap.id);
      this.maxShardSeq = Math.max(this.maxShardSeq, CheckpointManager.shardSeq(snap.id));
    }
    return shards;
  }

  /**
   * 把快照标成脏并立即量出它的序列化字节数。
   *
   * 为什么在这里 stringify：`evictIfNeeded` 在落盘前就要用总量判断淘汰，而总量必须含
   * 这次新增/改写的快照。这次 stringify 结果会存进 pendingJson，落盘直接复用——
   * 一次快照只 stringify **它自己**，不再 stringify 整份索引。
   */
  private markSnapshotDirty(snapshot: Snapshot): void {
    this.dirty = true;
    this.dirtySnapshotIds.add(snapshot.id);
    this.removedSnapshotIds.delete(snapshot.id);
    const json = JSON.stringify(snapshot);
    this.pendingJson.set(snapshot.id, json);
    const bytes = Buffer.byteLength(json, "utf-8");
    const prev = this.snapshotBytes.get(snapshot.id) ?? 0;
    this.snapshotBytes.set(snapshot.id, bytes);
    this.totalSnapshotBytes += bytes - prev;
    this.maxShardSeq = Math.max(this.maxShardSeq, CheckpointManager.shardSeq(snapshot.id));
  }

  /** 把快照标成已移除（落盘时 unlink 分片）。 */
  private markSnapshotRemoved(id: string): void {
    this.dirty = true;
    this.dirtySnapshotIds.delete(id);
    this.pendingJson.delete(id);
    this.removedSnapshotIds.add(id);
  }

  /** 全量标脏（迁移 / fork 继承）：所有内存中的快照都需要重写分片。 */
  private markAllSnapshotsDirty(): void {
    for (const snap of this.index.snapshots) this.markSnapshotDirty(snap);
    // 旧的单文件 index.json 里可能还内联着已被内存遗弃的内容，交给 saveIndex 的兜底清理。
    for (const id of this.persistedIds) {
      if (!this.index.snapshots.some((s) => s.id === id)) this.markSnapshotRemoved(id);
    }
  }

  /** 迁移旧格式索引到新格式 */
  private migrateLegacyIndex(legacy: LegacyCheckpointIndex): CheckpointIndex {
    const log = getLogger();
    log.info("CHECKPOINT", "检测到旧格式索引，正在迁移...");

    const snapshots: Snapshot[] = [];
    let nextId = 1;

    // 将每个文件的每个 entry 转换为独立的快照
    for (const [filePath, fileCheckpoints] of Object.entries(legacy.files)) {
      for (const entry of fileCheckpoints.entries) {
        const snapshotId = `s${nextId++}`;
        snapshots.push({
          id: snapshotId,
          timestamp: entry.timestamp,
          toolName: "write", // 旧格式无法区分工具，默认 write
          toolSummary: filePath,
          files: [
            {
              filePath: entry.filePath,
              existedBefore: entry.type === "diff" || entry.content !== "", // diff 或非空内容表示已存在
              type: entry.type,
              content: entry.content,
              compressed: entry.compressed,
              diff: entry.diff,
            },
          ],
        });
      }
    }

    // 按时间排序
    snapshots.sort((a, b) => a.timestamp - b.timestamp);

    log.info("CHECKPOINT", `迁移完成：${snapshots.length} 个快照`);

    return {
      sessionId: legacy.sessionId,
      createdAt: legacy.createdAt,
      nextId,
      snapshots,
    };
  }

  /**
   * 创建快照组：在工具执行前调用
   * 一次调用可以保存多个文件的状态
   */
  async createSnapshot(
    filePaths: string[],
    toolName: string,
    toolSummary: string,
    messageId?: string,
  ): Promise<string> {
    if (!this.config.enabled) {
      return "";
    }

    const log = getLogger();
    const snapshotId = `s${this.index.nextId++}`;
    const files: SnapshotFile[] = [];
    const skippedFiles: NonNullable<Snapshot["skippedFiles"]> = [];
    const maxFileBytes = this.config.maxFileSizeMb * 1024 * 1024;

    try {
      for (const filePath of filePaths) {
        const pathKind = classifyPathForSnapshot(filePath);

        if (pathKind === "absent") {
          // 新文件，记录为空内容
          files.push({
            filePath,
            existedBefore: false,
            type: "full",
            content: "",
            compressed: false,
          });
          continue;
        }

        // P4：非普通文件（目录 / 设备 / FIFO / socket / 软链）**不进快照**。
        //
        // 修之前它们被当作「新建文件 + 空内容」收进来：回退时 `unlinkSync` 必然失败
        // （设备 EPERM、非空目录 EPERM/EISDIR），而当时的 N5 判据只看「results 为空」
        // 就把这种失败当成了「没回滚成功」，于是快照被保留、`/undo` 永久卡在同一个快照上。
        // 目录/设备本来就不该是「可回滚目标」——跳过比假装保护诚实。
        if (pathKind === "non-regular") {
          skippedFiles.push({ filePath, bytes: 0, reason: "non-regular" });
          continue;
        }

        const file = Bun.file(filePath);

        // P3：超大文件不进快照。
        //
        // 判据用 statSync 的**原始字节**而不是压缩后大小：用户看到「上限 5MB」时理解的
        // 就是磁盘上的文件大小，而 gzip 压缩率随内容浮动（文本能到 1/5，二进制常常只到 1/2），
        // 拿压缩后字节当门槛就无法向用户解释「为什么这个 4MB 文件被跳过了」。
        if (maxFileBytes > 0) {
          let sizeBytes = 0;
          try {
            sizeBytes = statSync(filePath).size;
          } catch {
            sizeBytes = 0; // stat 失败不阻断：当作 0，走后续正常读取（读失败会被外层 catch 兜住）
          }
          if (sizeBytes > maxFileBytes) {
            // 不写 reason：缺省即 too-large（见 Snapshot.skippedFiles 的注释）
            skippedFiles.push({ filePath, bytes: sizeBytes });
            continue;
          }
        }

        // N13：读字节再判定，不再 `file.text()`（那一步对二进制是有损且不可逆的）。
        const bytes = new Uint8Array(await file.arrayBuffer());
        const currentContent: FileContent = decodeTextOrNull(bytes) ?? bytes;
        const lastContent = await this.getLatestContentForFile(filePath);

        // 第一次 / 任一侧是二进制（文本↔二进制切换也在此）：保存完整内容。
        // diff 只在「上一版与这一版都是文本」时才做。
        if (
          lastContent === null ||
          ((typeof lastContent !== "string" || typeof currentContent !== "string") &&
            !sameContent(lastContent, currentContent))
        ) {
          const snapshotFile: SnapshotFile = {
            filePath,
            existedBefore: true,
            type: "full",
          };
          encodeFullEntry(snapshotFile, currentContent, this.config.compressThresholdKb * 1024);
          files.push(snapshotFile);
        } else if (
          typeof lastContent === "string" &&
          typeof currentContent === "string" &&
          lastContent !== currentContent
        ) {
          // 后续：保存增量 diff
          const diff = computeDiff(lastContent, currentContent);
          files.push({
            filePath,
            existedBefore: true,
            type: "diff",
            diff,
          });
        }
        // 内容没变，跳过
      }

      // P3/P4：跳过的目标必须在日志里点明——否则用户以为 `/undo` 能救，实际救不回来。
      // 两类原因分开说：把目录/设备说成「超过单文件上限」是另一种撒谎。
      if (skippedFiles.length > 0) {
        const tooLarge = skippedFiles.filter((s) => s.reason !== "non-regular");
        const nonRegular = skippedFiles.filter((s) => s.reason === "non-regular");
        if (tooLarge.length > 0) {
          const preview = tooLarge
            .slice(0, 3)
            .map((s) => `${s.filePath}(${(s.bytes / 1024 / 1024).toFixed(1)}MB)`)
            .join(", ");
          log.info(
            "CHECKPOINT",
            `跳过 ${tooLarge.length} 个超过 ${this.config.maxFileSizeMb}MB 的文件，未进快照（无法 /undo 回退）: ${preview}${tooLarge.length > 3 ? " …" : ""}`,
          );
        }
        if (nonRegular.length > 0) {
          const preview = nonRegular
            .slice(0, 3)
            .map((s) => s.filePath)
            .join(", ");
          log.info(
            "CHECKPOINT",
            `跳过 ${nonRegular.length} 个非普通文件（目录/设备/软链等），未进快照（无法 /undo 回退）: ${preview}${nonRegular.length > 3 ? " …" : ""}`,
          );
        }
      }

      if (files.length > 0) {
        const snapshot: Snapshot = {
          id: snapshotId,
          timestamp: Date.now(),
          toolName,
          toolSummary,
          messageId,
          files,
          skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
        };
        this.index.snapshots.push(snapshot);
        // P3：标脏 + 量出本快照自己的字节数（只 stringify 它自己，不再 stringify 整份索引）。
        this.markSnapshotDirty(snapshot);

        // P1-2：写时双层 eviction（per-file 版本上限 + 总量上限），淘汰时保护 diff 链完整性。
        // 放在 push 之后、saveIndex 之前——确定性强、无需定时器（同 CC 写时淘汰思路）。
        await this.evictIfNeeded();
        await this.saveIndex();
        log.debug("CHECKPOINT", `已创建快照 ${snapshotId}: ${files.length} 个文件`);
        return snapshotId;
      }

      if (skippedFiles.length > 0) {
        // 全部被跳过：不建空快照（`/undo` 拿到空快照会打印「已撤销」却没动任何文件，属于谎报成功）。
        // P4：这里也是「纯噪音快照」的根治点之一——`ls 2>/dev/null` 这类命令过去会产出一个
        // 只含 /dev/null 的空快照，现在直接在源头不建。
        log.info(
          "CHECKPOINT",
          `本次变更全部未进快照（超限/非普通文件），未创建快照: ${toolSummary}`,
        );
      }

      // P4：没建成快照就返回空串，而不是那个已自增但**未入列**的 id。
      // 返回幽灵 id 的后果是调用方 `if (snapshotId)` 成立，把 s<N> 当成回退锚点记进
      // file_changes / onSnapshotCreated —— 那个 id 在索引里根本不存在，之后拿它回退必然失败。
      return "";
    } catch (err: any) {
      log.warn("CHECKPOINT", `创建快照失败: ${err.message}`);
      return "";
    }
  }

  /**
   * 兼容旧 API：单文件快照
   * @deprecated 使用 createSnapshot 替代
   */
  async createCheckpoint(filePath: string): Promise<void> {
    await this.createSnapshot([filePath], "write", filePath);
  }

  /**
   * 撤销最近一次快照（回滚整组文件变更）
   * 如果快照中某文件是新创建的（existedBefore=false），则删除该文件
   */
  async undo(): Promise<UndoResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    const log = getLogger();

    // P4：外层循环——「没有任何可回滚目标」的快照是纯噪音，消耗掉继续撤上一个。
    //
    // 为什么要循环、而不是消耗一次就返回 null：盘上已有 2,009 条历史坏条目
    // （`ls 2>/dev/null` 这类命令的副作用），同一会话尾部连续不可回退快照最深 10 个。
    // 只消耗一个的话用户要连敲 10 次 `/undo` 才能退出陷阱；循环让一次 `/undo`
    // 就落到最近一个真正有可回滚目标的快照上。
    //
    // 终止性：每次迭代要么 return，要么 removeLastSnapshot（快照数严格递减），
    // 所以最多迭代「快照总数」次，不会死循环。
    while (true) {
      const lastSnapshot = this.getLastSnapshot();
      if (!lastSnapshot) {
        return null;
      }

      const results: UndoResult["files"] = [];
      /** P4：尝试回滚但失败的文件。与「没有可回滚目标」是两件事，必须分开计。 */
      const failedFiles: string[] = [];

      for (const file of lastSnapshot.files) {
        if (!file.existedBefore) {
          // 新创建的文件：删除它。
          //
          // P4：先判类型再动手。历史快照里可能有目录 / 设备（`/dev/null`）——
          // `unlinkSync` 对它们必然失败（设备 EPERM、非空目录 EPERM/EISDIR），
          // 过去那个失败被 N5 的「results 为空」判据吃掉，导致 `/undo` 永久卡住。
          // 这类目标本来就不是「可回滚目标」，跳过它既不算成功也不算失败。
          const pathKind = classifyPathForSnapshot(file.filePath);
          if (pathKind === "non-regular") {
            log.debug(
              "CHECKPOINT",
              `跳过非普通文件（历史快照里的坏条目，不是可回滚目标）: ${file.filePath}`,
            );
            continue;
          }
          if (pathKind === "absent") {
            // 已经不在了 = 目标状态已达成，不算失败（保持原语义）
            continue;
          }
          try {
            unlinkSync(file.filePath);
            results.push({ filePath: file.filePath, action: "deleted" });
            log.info("CHECKPOINT", `已删除新文件: ${file.filePath}`);
          } catch (err: any) {
            log.warn("CHECKPOINT", `删除文件失败: ${file.filePath} - ${err.message}`);
            failedFiles.push(file.filePath);
          }
        } else {
          // 已有文件：恢复到快照前的内容
          const content = await this.rebuildContentBeforeSnapshot(file.filePath, lastSnapshot.id);
          if (content === null) {
            // P4：重建不出内容是真失败（diff 链被淘汰切断等），不能当「没有可回滚目标」静默消耗。
            // 与下面 catch 分支同一口径：留快照、报失败、可重试。
            log.warn("CHECKPOINT", `无法重建快照前内容: ${file.filePath}`);
            failedFiles.push(file.filePath);
            continue;
          }
          try {
            await Bun.write(file.filePath, content);
            results.push({ filePath: file.filePath, action: "restored" });
            log.info("CHECKPOINT", `已恢复文件: ${file.filePath}`);
          } catch (err: any) {
            log.warn("CHECKPOINT", `恢复文件失败: ${file.filePath} - ${err.message}`);
            failedFiles.push(file.filePath);
          }
        }
      }

      // ─────────────────────────────────────────────────────────────
      // N5：一个文件都没回滚成功时**不能删快照、不能报成功**。
      //
      // 修之前是「无条件 removeLastSnapshot + 返回真值对象」，而命令层只判 `if (result)`
      // ⇒ 打印「已撤销快照 sN:」后跟一个空列表。更糟的是快照已经被删掉，
      // **连重试的机会都没有**：再敲一次 /undo 会去撤上一个快照。
      // 一次"空转的成功"永久消耗掉一个快照。
      //
      // P4：判据从「results 为空」收紧成「results 为空 **且** 有失败」。
      // 「没有可回滚目标」（全是目录/设备这类历史坏条目，或目标状态本就已达成）不是失败，
      // 混进失败判据里正是 `/undo` 永久卡死的直接原因。
      // ─────────────────────────────────────────────────────────────
      if (results.length === 0 && failedFiles.length > 0) {
        log.warn(
          "CHECKPOINT",
          `撤销失败：快照 ${lastSnapshot.id} 的 ${failedFiles.length} 个文件未能回滚，保留快照供重试`,
        );
        return null;
      }

      // 移除该快照
      this.removeLastSnapshot();
      await this.saveIndex();

      if (results.length > 0) {
        return { snapshotId: lastSnapshot.id, files: results };
      }

      // results 与 failedFiles 都为空 ⇒ 这个快照没有任何可回滚目标（纯噪音），
      // 已经消耗掉了，继续撤上一个。
      log.info("CHECKPOINT", `快照 ${lastSnapshot.id} 没有可回滚的目标，已消耗并继续撤销上一个`);
    }
  }

  /**
   * 撤销指定文件的最近一次变更
   */
  async undoFile(filePath: string): Promise<UndoResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    const log = getLogger();

    // 找到最近修改该文件的快照
    for (let i = this.index.snapshots.length - 1; i >= 0; i--) {
      const snapshot = this.index.snapshots[i];
      const fileInSnapshot = snapshot.files.find((f) => f.filePath === filePath);

      if (fileInSnapshot) {
        if (!fileInSnapshot.existedBefore) {
          // 新创建的文件：删除它。
          //
          // P4：与 undo 同一口径——历史快照里的目录/设备（`/dev/null`）删不掉，
          // 直接判定为「不是可回滚目标」并把它从快照里摘掉，否则 `/undo <该路径>`
          // 每次都失败、该条目永久残留在快照里。
          const pathKind = classifyPathForSnapshot(filePath);
          if (pathKind === "non-regular") {
            log.warn(
              "CHECKPOINT",
              `跳过非普通文件（历史快照里的坏条目，不是可回滚目标）: ${filePath}`,
            );
            snapshot.files = snapshot.files.filter((f) => f.filePath !== filePath);
            if (snapshot.files.length === 0) {
              this.index.snapshots.splice(i, 1);
              this.markSnapshotRemoved(snapshot.id);
            } else {
              this.markSnapshotDirty(snapshot);
            }
            await this.saveIndex();
            return null;
          }
          if (pathKind === "regular") {
            try {
              unlinkSync(filePath);
              log.info("CHECKPOINT", `已删除新文件: ${filePath}`);
            } catch (err: any) {
              log.warn("CHECKPOINT", `删除文件失败: ${filePath} - ${err.message}`);
              return null;
            }
          }
          // pathKind === "absent"：目标状态已达成，无需动文件
        } else {
          // 已有文件：恢复到快照前的内容
          const content = await this.rebuildContentBeforeSnapshot(filePath, snapshot.id);
          if (content !== null) {
            try {
              await Bun.write(filePath, content);
              log.info("CHECKPOINT", `已恢复文件: ${filePath}`);
            } catch (err: any) {
              log.warn("CHECKPOINT", `恢复文件失败: ${filePath} - ${err.message}`);
              return null;
            }
          } else {
            return null;
          }
        }

        // 从快照中移除该文件
        snapshot.files = snapshot.files.filter((f) => f.filePath !== filePath);

        // 如果快照为空，移除整个快照
        if (snapshot.files.length === 0) {
          this.index.snapshots.splice(i, 1);
          // P3：分片落盘——整组移除要 unlink 它的分片，否则下次 init 会把它读回来。
          this.markSnapshotRemoved(snapshot.id);
        } else {
          this.markSnapshotDirty(snapshot);
        }

        await this.saveIndex();

        return {
          snapshotId: snapshot.id,
          files: [
            {
              filePath,
              action: fileInSnapshot.existedBefore ? "restored" : "deleted",
            },
          ],
        };
      }
    }

    return null;
  }

  /**
   * 恢复到指定快照点（回滚该快照之后的所有变更）
   */
  async restoreToSnapshot(snapshotId: string): Promise<RestoreResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    const log = getLogger();
    const targetIndex = this.index.snapshots.findIndex((s) => s.id === snapshotId);

    if (targetIndex === -1) {
      log.warn("CHECKPOINT", `快照不存在: ${snapshotId}`);
      return null;
    }

    // 收集所有需要回滚的快照（从最新到目标快照之后）
    const snapshotsToRollback = this.index.snapshots.slice(targetIndex + 1).reverse();
    const affectedFiles = new Map<string, { action: "restored" | "deleted" }>();
    /** N4：回滚失败的文件（含「重建不出内容」与「写盘抛错」两类），用于让静默失败可见。 */
    const failedFiles: string[] = [];

    for (const snapshot of snapshotsToRollback) {
      for (const file of snapshot.files) {
        // 只处理每个文件的第一次遇到（最新状态）
        if (affectedFiles.has(file.filePath)) {
          continue;
        }

        if (!file.existedBefore) {
          // 新创建的文件：删除它。
          //
          // P4：先判类型。历史快照里的非普通文件（目录 / 设备 / 软链）删不掉，
          // 过去那个 unlink 失败会被记成「回滚失败」，让整次 /restore 都显示失败——
          // 而它从来就不是可回滚目标，不该污染失败清单。跳过它，不记成功也不记失败。
          const pathKind = classifyPathForSnapshot(file.filePath);
          if (pathKind === "non-regular") {
            log.debug(
              "CHECKPOINT",
              `跳过非普通文件（历史快照里的坏条目，不是可回滚目标）: ${file.filePath}`,
            );
            continue;
          }
          if (pathKind === "regular") {
            try {
              unlinkSync(file.filePath);
              affectedFiles.set(file.filePath, { action: "deleted" });
              log.info("CHECKPOINT", `已删除新文件: ${file.filePath}`);
            } catch (err: any) {
              log.warn("CHECKPOINT", `删除文件失败: ${file.filePath} - ${err.message}`);
              failedFiles.push(file.filePath);
            }
          }
          // pathKind === "absent"：目标状态已达成
        } else {
          // ─────────────────────────────────────────────────────────────
          // 已有文件：恢复到目标快照时的内容。
          //
          // N4：`rebuildContentAtSnapshot(file, 目标快照)` 从 targetIndex 往**前**找该文件的
          // full 基点，于是漏掉一整类文件——**在 targetIndex 之后才被第一次改动的文件**。
          // 它的首个 SnapshotFile 条目（type:"full"，存着改前的原始内容）落在 targetIndex+k 上，
          // 所以往前找必然 `baseSnapshotIndex === -1` ⇒ 返回 null ⇒
          // 旧代码 `if (content !== null)` 不成立 ⇒ **静默跳过：文件不回滚、也不进返回的 files 列表**。
          //
          // 后果是用户以为「回到那个时刻了」，实际只回了一部分文件，且 UI 上没有任何提示
          // （`snapshotsRolledBack: 2` 看着像全回滚了）。叠加 /rewind「先文件后对话」的顺序，
          // 得到的是两层不一致：对话回到 10 轮前，一部分文件还停在最新。
          //
          // 关键是**信息并没有丢**：该文件在目标快照时刻的内容就存在它自己那条首个 full 里
          // （`existedBefore: true, content: "原始内容"`）——targetIndex 到那条 full 之间没人改过它，
          // 所以那条 full 记录的「改前内容」**就等于**目标快照时刻的内容。
          // 所以不是「做不到」，是取数方向走错了：往前找不到时，应改为往后找该文件的首个 full。
          // ─────────────────────────────────────────────────────────────
          let content = await this.rebuildContentAtSnapshot(file.filePath, snapshotId);
          if (content === null) {
            content = this.readFirstFullContentAfter(file.filePath, targetIndex);
          }
          if (content !== null) {
            try {
              await Bun.write(file.filePath, content);
              affectedFiles.set(file.filePath, { action: "restored" });
              log.info("CHECKPOINT", `已恢复文件: ${file.filePath}`);
            } catch (err: any) {
              log.warn("CHECKPOINT", `恢复文件失败: ${file.filePath} - ${err.message}`);
              failedFiles.push(file.filePath);
            }
          } else {
            // 两个方向都取不到内容（diff 链被淘汰切断等）——绝不能再静默跳过。
            log.warn(
              "CHECKPOINT",
              `无法重建文件在快照 ${snapshotId} 时的内容，该文件未回滚: ${file.filePath}`,
            );
            failedFiles.push(file.filePath);
          }
        }
      }
    }

    // 移除目标快照之后的所有快照
    const droppedByRestore = this.index.snapshots.slice(targetIndex + 1);
    this.index.snapshots = this.index.snapshots.slice(0, targetIndex + 1);
    // P3：分片落盘——被截断的快照必须 unlink 分片，否则下次 init 会把它们从盘上读回来
    // （表现就是「刚 restore 完，重启后那些快照又复活了」）。
    for (const s of droppedByRestore) this.markSnapshotRemoved(s.id);
    await this.saveIndex();

    if (failedFiles.length > 0) {
      log.warn(
        "CHECKPOINT",
        `恢复到 ${snapshotId} 时有 ${failedFiles.length} 个文件未能回滚（磁盘仍是回滚前的状态）: ${failedFiles.join(", ")}`,
      );
    }

    return {
      targetSnapshotId: snapshotId,
      snapshotsRolledBack: snapshotsToRollback.length,
      files: Array.from(affectedFiles.entries()).map(([filePath, { action }]) => ({
        filePath,
        action,
      })),
      // N4：调用方（/rewind、/restore 命令层）据此告知用户「哪些文件没回滚成功」，
      // 而不是像修复前那样只看 snapshotsRolledBack 以为全成了。
      failedFiles,
    };
  }

  /**
   * 把磁盘恢复到**产生 sN 那次工具调用之前**的状态，即回滚 `[sN, 最新]` 全区间（**含 sN 自己**）。
   *
   * 与 `restoreToSnapshot` 的唯一差别就是回滚范围，两个调用方的锚点口径不同且各自都对：
   *   - `/restore <sN>`：用户明确点的是这个快照，sN 本身要保留 ⇒ 用 `restoreToSnapshot`（sN 之后）。
   *   - 会话回退（Esc+Esc / `/rewind`）：回退点的文件锚点是「本轮首个快照」，而按单一真相源
   *     「sN 存的是产生 sN 那次调用**之前**的内容」（见 rebuildContentBeforeSnapshot 注释），
   *     回到「本轮之前」必须连 sN 一起撤 ⇒ 用本方法。
   *
   * 修之前 rewind 借用了 `restoreToSnapshot`，于是 `slice(targetIndex + 1)` 与锚点差了一格：
   * 本轮只改过一次文件时切出空数组，返回 `files: []`（用户看到「已回退（仅代码）· 回滚了 0 个文件」
   * 而磁盘没动）；本轮改过多次时则少撤第一次，结果比用户选的位置晚一步，UI 照样显示「已回退」。
   *
   * 注意这不是「把 restoreToSnapshot 的范围改一下就完事」：那个语义被 `/restore` 与
   * p0-undo-restore-semantics 的用例锁着，改它是把 rewind 的需求硬塞给 /restore
   * （`/restore s3` 会连 s3 自己一起撤，又回到 N5 修过的「多退一步」）。
   */
  async restoreBeforeSnapshot(snapshotId: string): Promise<RestoreResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    const log = getLogger();
    const targetIndex = this.index.snapshots.findIndex((s) => s.id === snapshotId);

    if (targetIndex === -1) {
      log.warn("CHECKPOINT", `快照不存在: ${snapshotId}`);
      return null;
    }

    // 含 sN 自己——这是与 restoreToSnapshot 唯一的范围差别。
    const snapshotsToRollback = this.index.snapshots.slice(targetIndex);
    const affectedFiles = new Map<string, { action: "restored" | "deleted" }>();
    const failedFiles: string[] = [];

    // 按「区间内**最早**条目」判断每个文件在目标时刻的样子。
    //
    // 为什么不能照抄 restoreToSnapshot 的「最新条目优先」（它从最新往前、每个文件只看第一次遇到的那条）：
    // 判断存在性必须用最早那条。设想 b 在 s2 新建（existedBefore=false）、s3 又被 edit
    // （existedBefore=true, type=diff）：按最新条目会走「写回内容」分支，而 rebuildContentAtSnapshot(b, 目标)
    // 在目标之前找不到 b 的 full 基点，readFirstFullContentAfter 又会拿到 s2 那条 `content: ""`
    // ⇒ **写出一个空文件而不是删掉它**，结果里还报 restored、failedFiles 为空（已实测复现，方案文档 P4）。
    // restoreToSnapshot 的这个缺陷单独修，本方法从设计上避开它。
    // ⚠️ 区间只在这里定义一次（`snapshotsToRollback`），下面按它遍历。
    // 先前的写法是从 `targetIndex` 再写一遍 `for (...; i < snapshots.length; ...)`——
    // 同一个「回滚区间」在两处表达，改一处忘另一处就是下一次「回滚 0 个文件」（变异自证实测抓到的）。
    const earliestEntry = new Map<string, { file: SnapshotFile; snapshotIndex: number }>();
    for (let offset = 0; offset < snapshotsToRollback.length; offset++) {
      for (const file of snapshotsToRollback[offset]!.files) {
        if (earliestEntry.has(file.filePath)) continue;
        earliestEntry.set(file.filePath, { file, snapshotIndex: targetIndex + offset });
      }
    }

    for (const [filePath, { file, snapshotIndex }] of earliestEntry) {
      if (!file.existedBefore) {
        // 目标时刻该文件还不存在（是回滚区间内才新建的）⇒ 删掉它。
        //
        // P4：与 undo / restoreToSnapshot 同一口径——先判类型，非普通文件跳过。
        // 历史快照里的目录/设备删不掉，把它记成「回滚失败」会让整次 /rewind 都显示失败，
        // 而它从来就不是可回滚目标。
        const pathKind = classifyPathForSnapshot(filePath);
        if (pathKind === "non-regular") {
          log.debug(
            "CHECKPOINT",
            `跳过非普通文件（历史快照里的坏条目，不是可回滚目标）: ${filePath}`,
          );
          continue;
        }
        if (pathKind === "regular") {
          try {
            unlinkSync(filePath);
            affectedFiles.set(filePath, { action: "deleted" });
            log.info("CHECKPOINT", `已删除新文件: ${filePath}`);
          } catch (err: any) {
            log.warn("CHECKPOINT", `删除文件失败: ${filePath} - ${err.message}`);
            failedFiles.push(filePath);
          }
        }
        // 文件本来就不在 ⇒ 目标状态就是「不存在」，算达成（与 restoreToSnapshot 同口径：不计入 files）。
        continue;
      }

      // existedBefore=true：目标时刻该文件存在，且最早条目存的就是「产生它那次调用之前」的内容。
      // full 直接解码；diff 则重建——重建目标是**最早条目所在的那个快照**，不是「区间前一格」：
      // rebuildContentAtSnapshot(f, sK) 得到的正是「产生 sK 那次调用之前」的内容，而
      // sN..sK-1 之间该文件没有任何条目 ⇒ 这就是目标时刻的内容。
      let content: FileContent | null = null;
      if (file.type === "full") {
        try {
          content = decodeFullEntry(file);
        } catch {
          content = null; // 索引损坏（base64/解压失败）⇒ 计入失败，不静默跳过
        }
      } else {
        content = await this.rebuildContentAtSnapshot(
          filePath,
          this.index.snapshots[snapshotIndex].id,
        );
      }

      if (content === null) {
        log.warn(
          "CHECKPOINT",
          `无法重建文件在快照 ${snapshotId} 之前的内容，该文件未回滚: ${filePath}`,
        );
        failedFiles.push(filePath);
        continue;
      }

      try {
        await Bun.write(filePath, content);
        affectedFiles.set(filePath, { action: "restored" });
        log.info("CHECKPOINT", `已恢复文件: ${filePath}`);
      } catch (err: any) {
        log.warn("CHECKPOINT", `恢复文件失败: ${filePath} - ${err.message}`);
        failedFiles.push(filePath);
      }
    }

    // 截断 index：sN 及其之后的快照都不再存在（磁盘已回到产生 sN 之前的状态）。
    // `nextId` 不回退——旧快照 id 仍可能挂在别处（如 file_changes 的 lastSnapshotId），
    // id 复用会让那些旧锚点误命中新快照。
    const droppedByRestore = this.index.snapshots.slice(targetIndex);
    this.index.snapshots = this.index.snapshots.slice(0, targetIndex);
    // P3：分片落盘——被截断的快照必须 unlink 分片，否则下次 init 会把它们读回来。
    for (const s of droppedByRestore) this.markSnapshotRemoved(s.id);
    await this.saveIndex();

    if (failedFiles.length > 0) {
      log.warn(
        "CHECKPOINT",
        `回退到 ${snapshotId} 之前时有 ${failedFiles.length} 个文件未能回滚（磁盘仍是回滚前的状态）: ${failedFiles.join(", ")}`,
      );
    }

    return {
      targetSnapshotId: snapshotId,
      snapshotsRolledBack: snapshotsToRollback.length,
      files: Array.from(affectedFiles.entries()).map(([filePath, { action }]) => ({
        filePath,
        action,
      })),
      // 与 N4 同口径：调用方据此如实告知「哪些文件没回滚成功」，而不是把部分失败显示成成功。
      failedFiles,
    };
  }

  /**
   * N4：取某文件在 `afterIndex` **之后**的首个 `full` 条目的内容。
   *
   * 用于「该文件在目标快照之后才第一次被改动」这一类：它的 full 基点在目标快照之后，
   * 而 full 存的是**改动前**的内容，且目标快照到该 full 之间没有任何针对该文件的条目
   * （否则那条才是首个），所以这份内容正是它在目标快照时刻的状态。
   *
   * 找不到（该文件在之后只有 diff、没有 full）返回 null，由调用方计入回滚失败。
   */
  private readFirstFullContentAfter(filePath: string, afterIndex: number): FileContent | null {
    for (let i = afterIndex + 1; i < this.index.snapshots.length; i++) {
      const f = this.index.snapshots[i].files.find((x) => x.filePath === filePath);
      if (!f) continue;
      if (f.type !== "full") return null; // 首个条目是 diff ⇒ 基点不在此处，交给调用方判失败
      try {
        return decodeFullEntry(f);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * 列出所有快照（用于 /checkpoints 命令）
   */
  listSnapshots(): SnapshotSummary[] {
    return this.index.snapshots.map((s) => ({
      id: s.id,
      timestamp: s.timestamp,
      toolName: s.toolName,
      toolSummary: s.toolSummary,
      fileCount: s.files.length,
    }));
  }

  /**
   * 查看指定快照的详情
   */
  getSnapshotDetail(snapshotId: string): Snapshot | null {
    return this.index.snapshots.find((s) => s.id === snapshotId) || null;
  }

  /**
   * 获取指定文件在最新快照时的内容
   */
  private async getLatestContentForFile(filePath: string): Promise<FileContent | null> {
    // 从最新快照往前找，找到第一个包含该文件的快照
    for (let i = this.index.snapshots.length - 1; i >= 0; i--) {
      const snapshot = this.index.snapshots[i];
      const fileInSnapshot = snapshot.files.find((f) => f.filePath === filePath);
      if (fileInSnapshot) {
        return this.rebuildContentAtSnapshot(filePath, snapshot.id);
      }
    }
    return null;
  }

  /**
   * 重建指定文件在指定快照时的内容
   */
  private async rebuildContentAtSnapshot(
    filePath: string,
    snapshotId: string,
  ): Promise<FileContent | null> {
    const targetIndex = this.index.snapshots.findIndex((s) => s.id === snapshotId);
    if (targetIndex === -1) return null;

    // 找到最近的 full 快照
    let baseContent: FileContent = "";
    let baseSnapshotIndex = -1;

    for (let i = targetIndex; i >= 0; i--) {
      const snapshot = this.index.snapshots[i];
      const fileInSnapshot = snapshot.files.find((f) => f.filePath === filePath);

      if (fileInSnapshot && fileInSnapshot.type === "full") {
        baseContent = decodeFullEntry(fileInSnapshot);
        baseSnapshotIndex = i;
        break;
      }
    }

    if (baseSnapshotIndex === -1) {
      return null;
    }

    // N13：二进制基点原样返回。createSnapshot 保证二进制之后不会接 diff
    // （任一侧是二进制都写 full），所以这里不存在「对字节 apply 文本 diff」的情形。
    if (typeof baseContent !== "string") return baseContent;

    // 逐步 apply diff
    let content = baseContent;
    const { applyDiff } = await import("./diff.ts");

    for (let i = baseSnapshotIndex + 1; i <= targetIndex; i++) {
      const snapshot = this.index.snapshots[i];
      const fileInSnapshot = snapshot.files.find((f) => f.filePath === filePath);

      if (fileInSnapshot && fileInSnapshot.type === "diff" && fileInSnapshot.diff) {
        content = applyDiff(content, fileInSnapshot.diff);
      }
    }

    return content;
  }

  /**
   * 重建指定文件在指定快照之前的内容（用于 undo）。
   *
   * ⚠️ N5：**快照 sN 记录的就已经是「改动前」的内容**，所以这里不能再退一格。
   *
   * 「快照 sN 代表哪个时刻」这个换算此前在三个入口各推了一遍，两个推反了，
   * 现在统一收敛到这条口径（单一真相源）：
   *
   *   生产时序恒为 `createSnapshot(files)` → 工具执行改文件（tool-executor 执行前建快照）。
   *   ⇒ **sN 存的是「产生 sN 那次工具调用之前」的文件内容。**
   *   ⇒ 「撤销最近一次修改」= 重建到最后一个快照 **自己** 记录的内容
   *      = `rebuildContentAtSnapshot(filePath, sN)`，**不是** `sN-1`。
   *
   * 修之前取 `snapshots[targetIndex - 1]`，把 sN 当成了「sN 之后的状态」，于是产生三种错：
   *   - 只有一个快照时 `targetIndex === 0` ⇒ 返回 null ⇒ 文件没动，UI 却打印「已撤销快照 s1」
   *     （空转 + 谎报成功，最危险的一种）；
   *   - 两次以上编辑时一次 `/undo` **退两步**，把用户上一步的正确修改一起丢掉；
   *   - `/undo <路径>` 对只改过一次的文件直接打印「没有可撤销的修改」。
   *
   * 为什么现有测试没拦住：`manager.test.ts` 的 undo 用例**额外建了一个快照**
   * （createSnapshot("initial") → 改文件 → createSnapshot("modify")），构造出一个
   * 「快照数比编辑数多一个」的世界，在那个世界里 `targetIndex - 1` 恰好是对的。
   * 生产里没有这个额外快照——`createSnapshot` 只在工具**即将**改文件时被调，
   * 不会先来一发「记录初始状态」。判据必须按生产调用顺序复现，不是按方便断言的顺序构造。
   */
  private async rebuildContentBeforeSnapshot(
    filePath: string,
    snapshotId: string,
  ): Promise<FileContent | null> {
    return this.rebuildContentAtSnapshot(filePath, snapshotId);
  }

  // ─────────────────────────────────────────────────────────────
  // P1-2：checkpoint eviction（写时淘汰 + diff 链重锚定）
  //
  // 结构约束（决定不能照搬 CC 的 per-file slice(-MAX)）：
  //   - per-session 单 index.json，所有快照内联其中，按 timestamp 时间序排列。
  //   - 同一文件跨快照是 diff 链：首存 full，后续存相对上一版本的 diff。
  //     重建靠 rebuildContentAtSnapshot：从目标往前找最近 full 作基点再逐步 applyDiff。
  //   - 盲删最旧快照/条目会切断 diff 链 → undo/restore 该文件 rebuild 返回 null。
  //
  // 因此淘汰粒度是「删快照内某文件的 SnapshotFile 条目」，且删某文件最旧条目前，
  // 若它是 full 且后面还有该文件的 diff 依赖它，先把「紧邻的下一个该文件 diff」
  // 用 rebuildContentAtSnapshot 重建成内容、原地改写成新 full（重锚定基点），再删旧条目。
  // ─────────────────────────────────────────────────────────────

  /** 写时双层淘汰：先 per-file 版本上限（A），再总量上限（B）。 */
  private async evictIfNeeded(): Promise<void> {
    try {
      await this.evictPerFile();
      await this.evictBySize();
    } catch (err: any) {
      // 淘汰失败绝不能影响快照本身已成功写入——仅告警。
      getLogger().warn("CHECKPOINT", `checkpoint 淘汰失败（不阻断）: ${err?.message}`);
    }
  }

  /** 收集某文件在所有快照中的出现位置（按时间序，返回 {snapshotIndex, file}）。 */
  private collectFileEntries(
    filePath: string,
  ): Array<{ snapshotIndex: number; file: SnapshotFile }> {
    const entries: Array<{ snapshotIndex: number; file: SnapshotFile }> = [];
    for (let i = 0; i < this.index.snapshots.length; i++) {
      const f = this.index.snapshots[i].files.find((x) => x.filePath === filePath);
      if (f) entries.push({ snapshotIndex: i, file: f });
    }
    return entries;
  }

  /** 全仓所有出现过的文件路径（去重）。 */
  private allTrackedFilePaths(): string[] {
    const set = new Set<string>();
    for (const s of this.index.snapshots) {
      for (const f of s.files) set.add(f.filePath);
    }
    return Array.from(set);
  }

  /**
   * 确保删除某文件在 fromSnapshotIndex 处的 full 条目不会切断后续 diff 链：
   * 若「紧邻的下一个该文件条目」是 diff（依赖被删 full），先把它 rebuild 成内容、原地改写成新 full。
   *
   * 返回 true 表示「删除该 full 是安全的」：
   *   - 后续紧邻条目是 full（已有独立基点）→ 直接安全；
   *   - 后续紧邻条目是 diff → 已成功重锚定为 full → 安全；
   *   - 后续无该文件任何条目 → 无人依赖该 full → 安全（size 淘汰按 LRU 丢弃老文件的孤版本，
   *     近期窗口由 evictBySize 的 MIN_KEEP 保护；per-file 淘汰因 count>max 恒有更新版本，走不到这里）。
   * 返回 false 仅在 diff 重建异常（无法安全重锚定）时——调用方应放弃删除以免切链。
   */
  private async reanchorFullForFile(filePath: string, fromSnapshotIndex: number): Promise<boolean> {
    // 找 fromSnapshotIndex 之后（不含）该文件的下一个条目。
    for (let i = fromSnapshotIndex + 1; i < this.index.snapshots.length; i++) {
      const f = this.index.snapshots[i].files.find((x) => x.filePath === filePath);
      if (!f) continue;
      if (f.type === "full") {
        // 后面已有独立 full 基点，旧 full 可直接删，无需重锚定。
        return true;
      }
      // f 是 diff：把它重建成内容，原地改写成 full（新基点）。
      const rebuilt = await this.rebuildContentAtSnapshot(filePath, this.index.snapshots[i].id);
      if (rebuilt === null) {
        // 无法重建（异常）→ 保守失败，调用方应放弃删除旧 full 以免切链。
        return false;
      }
      // 原地改写为 full（复用压缩阈值逻辑；N13：与 createSnapshot 同一编码函数）。
      f.type = "full";
      f.diff = undefined;
      encodeFullEntry(f, rebuilt, this.config.compressThresholdKb * 1024);
      // P3：分片落盘——被重锚定的那个快照要重写自己的分片（其余分片不动）。
      this.markSnapshotDirty(this.index.snapshots[i]);
      return true;
    }
    // 该文件在 fromSnapshotIndex 之后无其他条目 → 无 diff 依赖该 full → 删除安全（LRU 丢弃老孤版本）。
    return true;
  }

  /**
   * 删除某文件的一个 SnapshotFile 条目（按 snapshotIndex 定位）。
   * 若删空该快照的 files，则整组移除（复用 restore 的 splice 模式）。
   * 返回删除后是否发生了快照整组移除（用于调用方修正遍历下标）。
   */
  private removeFileEntry(filePath: string, snapshotIndex: number): boolean {
    const snapshot = this.index.snapshots[snapshotIndex];
    if (!snapshot) return false;
    snapshot.files = snapshot.files.filter((f) => f.filePath !== filePath);
    if (snapshot.files.length === 0) {
      this.index.snapshots.splice(snapshotIndex, 1);
      // P3：整组移除要 unlink 分片，否则下次 init 从盘上把它读回来。
      this.markSnapshotRemoved(snapshot.id);
      return true;
    }
    // P3：只重写被改动的那一个分片。
    this.markSnapshotDirty(snapshot);
    return false;
  }

  /**
   * A. per-file 版本上限：当某文件历史条目数 > maxCheckpointsPerFile 时从最旧端删。
   * 删最旧条目前若它是 full 且后面还有依赖它的 diff，先重锚定下一个 diff 为 full。
   */
  private async evictPerFile(): Promise<void> {
    const max = this.config.maxCheckpointsPerFile;
    if (!max || max <= 0) return;

    for (const filePath of this.allTrackedFilePaths()) {
      // 循环删最旧，直到条目数 ≤ max（保留铁律 #1/#5：至少留最近若干个，且 ≥ /checkpoints 可见窗口由 max 保证）。
      let entries = this.collectFileEntries(filePath);
      while (entries.length > max) {
        const oldest = entries[0];
        if (oldest.file.type === "full") {
          // 先重锚定后续 diff；无法重锚定（它已是最新/唯一版本，或重建失败）则停止淘汰该文件。
          const ok = await this.reanchorFullForFile(filePath, oldest.snapshotIndex);
          if (!ok) break;
        }
        // 删最旧条目（重锚定已保证后续 diff 有 full 基点）。
        this.removeFileEntry(filePath, oldest.snapshotIndex);
        // 快照结构可能因整组移除而变化，重新收集。
        entries = this.collectFileEntries(filePath);
      }
    }
  }

  /**
   * B. 总量上限：当前 session index.json 序列化字节数超 maxTotalSizeMb 时，
   * 从最旧快照整组删（LRU=时间序），删到阈值下。删最旧段时对跨边界文件先重锚定。
   * 保留铁律 #5：保留窗口不小于 /checkpoints 可见的最近 10 条 + /undo 最近 1 条。
   */
  private async evictBySize(): Promise<void> {
    const maxBytes = this.config.maxTotalSizeMb * 1024 * 1024;
    if (!maxBytes || maxBytes <= 0) return;

    // 保留窗口下限：至少保留最近 MIN_KEEP 个快照，避免把用户可见/可 restore 的近期快照删掉。
    const MIN_KEEP = 11; // /checkpoints 显示最近 10 条 + /undo 最近 1 条

    let guard = 0;
    while (this.serializedSize() > maxBytes && this.index.snapshots.length > MIN_KEEP) {
      if (guard++ > 100000) break; // 防御性死循环阀
      // 待删的最旧快照（下标 0）。删前：对其中每个文件，若它是该文件当前 full 基点且后续有 diff 依赖，
      // 先重锚定后续 diff 为 full。
      const oldest = this.index.snapshots[0];
      if (!oldest) break;

      let blocked = false;
      for (const f of oldest.files) {
        if (f.type === "full") {
          const ok = await this.reanchorFullForFile(f.filePath, 0);
          if (!ok) {
            // 该文件的 full 无法重锚定（是最新/唯一版本）→ 不能删这个最旧快照，否则切链。
            blocked = true;
            break;
          }
        }
      }
      if (blocked) break; // 最旧快照不可删 → 停止总量淘汰（已尽力）。

      // 整组移除最旧快照。
      this.index.snapshots.shift();
      // P3：分片落盘——被淘汰的快照必须 unlink 分片，否则下次 init 会把它们读回来，
      // 淘汰就等于没做（而且索引会重新膨胀）。
      this.markSnapshotRemoved(oldest.id);
    }
  }

  /**
   * 当前 checkpoint 落盘后的字节数（与分片格式一致）。
   *
   * P3：改成**增量求和**。修之前是 `JSON.stringify(this.index, null, 2)` —— 42MB 索引
   * 一次 8–18ms，而 evictBySize 在 while 循环里每轮都调它一次；一次快照要 stringify
   * 两遍全文（这里 + saveIndex）。现在只累加各分片的字节数（写盘时算一次后缓存），O(1)。
   */
  private serializedSize(): number {
    return this.totalSnapshotBytes + this.headBytes;
  }

  /** 获取最后一个快照 */
  private getLastSnapshot(): Snapshot | null {
    if (this.index.snapshots.length === 0) return null;
    return this.index.snapshots[this.index.snapshots.length - 1];
  }

  /** 移除最后一个快照 */
  private removeLastSnapshot(): void {
    if (this.index.snapshots.length > 0) {
      const removed = this.index.snapshots.pop()!;
      // P3：分片落盘——移除的快照要 unlink 分片，否则下次 init 会把它读回来（undo 等于没做）。
      this.markSnapshotRemoved(removed.id);
    }
  }

  /**
   * P1-G2b：从源会话继承 checkpoint 历史（`--fork-session` 用）。
   *
   * 背景（本次修复的真缺口）：分叉会话的 logical session id 是全新的，checkpoint 目录因此
   * 是空目录——新会话 `/undo` / `/restore` 够不到分叉前的任何编辑，方案 §3 的验收标准
   * 「新会话 /undo 能回退到分叉前的编辑」此前不成立。
   *
   * 实现选择：**深拷贝索引**而非软链/转读。快照的完整内容与 diff 都内联在 index.json 里
   * （见 Snapshot.content / .diff），没有旁挂的物理文件，所以一次索引拷贝就是完整继承；
   * 而拷贝（相对转读）让两个会话此后各自独立演进——新会话继续 snapshot / undo 不会
   * 反向污染源会话的回退历史，这是分叉语义的要求。
   *
   * 约束与边界：
   * - 仅在当前会话**尚无任何快照**时执行（刚 init 的分叉会话），否则视为误调用直接跳过，
   *   避免把源历史插进已有快照序列造成 id 冲突 / 时序错乱。
   * - `sessionId` 改写为当前会话，`nextId` 沿用源值（快照 id 不重排，保持 `/restore <ID>`
   *   在分叉前后指向同一个逻辑快照，用户的肌肉记忆和历史记录里的 id 仍然有效）。
   * - 源不存在 / 索引损坏 → 只告警，新会话退化为空 checkpoint（不阻断启动）。
   *
   * @param srcSessionId 源会话 id
   * @returns 继承到的快照条数（0 表示未继承）
   */
  async inheritFrom(srcSessionId: string): Promise<number> {
    const log = getLogger();
    if (!this.config.enabled) return 0;
    if (!srcSessionId || srcSessionId === this.sessionId) return 0;
    // 已有快照 → 不做插入式继承（防 id 冲突 / 时序错乱）
    if (this.index.snapshots.length > 0) {
      log.warn(
        "CHECKPOINT",
        `继承跳过：当前会话已有 ${this.index.snapshots.length} 个快照，不做插入式继承`,
      );
      return 0;
    }

    try {
      const srcDir = sidPaths.checkpoints(srcSessionId);
      const srcIndexPath = join(srcDir, "index.json");
      if (!existsSync(srcIndexPath)) {
        log.info("CHECKPOINT", `源会话无 checkpoint 可继承: ${srcSessionId}`);
        return 0;
      }
      const parsed = JSON.parse(await Bun.file(srcIndexPath).text());
      // 源可能是三种格式：P3 分片（version=2）/ 旧内联 snapshots / 更旧的 files 结构。
      let snapshots: Snapshot[];
      let srcCreatedAt: number | undefined;
      let srcNextId: number | undefined;
      if (parsed.version === INDEX_VERSION) {
        snapshots = await this.readSnapshotShardsFrom(srcDir);
        srcCreatedAt = parsed.createdAt;
        srcNextId = parsed.nextId;
      } else {
        // 旧格式（files 而非 snapshots）复用既有迁移逻辑，继承后即为新格式。
        const srcIndex: CheckpointIndex =
          parsed.files && !parsed.snapshots
            ? this.migrateLegacyIndex(parsed as LegacyCheckpointIndex)
            : stripLegacyFields(parsed as CheckpointIndex);
        snapshots = Array.isArray(srcIndex.snapshots) ? srcIndex.snapshots : [];
        srcCreatedAt = srcIndex.createdAt;
        srcNextId = srcIndex.nextId;
      }

      if (snapshots.length === 0) {
        log.info("CHECKPOINT", `源会话 checkpoint 为空，无需继承: ${srcSessionId}`);
        return 0;
      }

      // 深拷贝：两会话此后独立演进，改一边不影响另一边（structuredClone 覆盖 diff 嵌套结构）。
      this.index = {
        sessionId: this.sessionId,
        createdAt: srcCreatedAt ?? Date.now(),
        nextId: typeof srcNextId === "number" ? srcNextId : snapshots.length + 1,
        snapshots: structuredClone(snapshots),
      };
      // P3：继承来的快照在当前会话目录里还没有分片，全部标脏由 saveIndex 逐个写出去。
      this.markAllSnapshotsDirty();
      await this.saveIndex();
      log.info(
        "CHECKPOINT",
        `已从源会话继承 checkpoint: ${srcSessionId} → ${this.sessionId}（${snapshots.length} 个快照，两会话此后独立演进）`,
      );
      return snapshots.length;
    } catch (e) {
      log.warn(
        "CHECKPOINT",
        `checkpoint 继承失败（新会话退化为空回退历史，不阻断）: ${(e as Error)?.message}`,
      );
      return 0;
    }
  }

  /**
   * 把变更落盘（P3：分片格式）。
   *
   * 一次快照只写 1 个新分片 + 几百字节的 index.json 头，历史分片不动 ⇒ 写放大 O(N)。
   * 修之前是整份索引 stringify + 整份写盘：42MB 索引一次 9–15ms，24 个快照累计写盘 864MB。
   *
   * 落盘顺序刻意是「先写分片、后写头」：中途崩溃时 index.json 还是上一轮的完整状态，
   * 下次 init 重读不会丢历史；反过来先写头再写分片，崩溃就只剩一个指向不存在分片的头。
   */
  private async saveIndex(): Promise<void> {
    if (!this.dirty) return;

    const log = getLogger();
    const indexPath = join(this.baseDir, "index.json");

    try {
      const shardDir = this.shardDir();
      if (!existsSync(shardDir)) mkdirSync(shardDir, { recursive: true });

      // 兜底：内存里有、从未落盘过的 → 补写；已落盘、已从内存移除的 → 补删。
      // 为什么需要这层：分片后「盘上有什么」不再由单一 index.json 决定，任何一条变更路径
      // 忘了调 markSnapshotDirty 都会让那个快照静默消失（用户 /undo 到一半发现历史缺口）。
      // 双向比对是 O(snapshots)，比漏数据的代价小得多。
      const liveIds = new Set(this.index.snapshots.map((s) => s.id));
      for (const id of liveIds) {
        if (!this.persistedIds.has(id)) this.dirtySnapshotIds.add(id);
      }
      for (const id of this.persistedIds) {
        if (!liveIds.has(id)) this.removedSnapshotIds.add(id);
      }

      // 1) 删除已移除的快照分片
      for (const id of this.removedSnapshotIds) {
        try {
          unlinkSync(this.shardPath(id));
        } catch {
          // 文件本来就不在（首次迁移 / 重复删除）——无需处理
        }
        this.persistedIds.delete(id);
        const bytes = this.snapshotBytes.get(id);
        if (bytes !== undefined) {
          this.totalSnapshotBytes -= bytes;
          this.snapshotBytes.delete(id);
        }
      }
      this.removedSnapshotIds.clear();

      // 2) 写脏分片（JSON 在 markSnapshotDirty 时已算好，这里复用，不重复 stringify）
      for (const id of this.dirtySnapshotIds) {
        const snap = this.index.snapshots.find((s) => s.id === id);
        if (!snap) continue;
        const json = this.pendingJson.get(id) ?? JSON.stringify(snap);
        await Bun.write(this.shardPath(id), json);
        const bytes = Buffer.byteLength(json, "utf-8");
        const prev = this.snapshotBytes.get(id) ?? 0;
        this.snapshotBytes.set(id, bytes);
        this.totalSnapshotBytes += bytes - prev;
        this.persistedIds.add(id);
      }
      this.dirtySnapshotIds.clear();
      this.pendingJson.clear();

      // 3) 写头（几百字节，不是整份索引）
      const head: ShardedIndexHead = {
        version: INDEX_VERSION,
        sessionId: this.index.sessionId,
        createdAt: this.index.createdAt,
        nextId: this.index.nextId,
      };
      const headJson = JSON.stringify(head, null, 2);
      await Bun.write(indexPath, headJson);
      this.headBytes = Buffer.byteLength(headJson, "utf-8");

      this.dirty = false;
    } catch (err: any) {
      // 落盘失败：保留 dirty 让下次重试，内存索引不受影响（本次工具调用照常继续）。
      // 不向上抛，是因为 init 的迁移路径也在调 saveIndex —— 抛出去会被 init 的 catch
      // 当成「索引损坏」而重建空索引，等于把整份历史丢掉。
      log.warn(
        "CHECKPOINT",
        `索引落盘失败（保留脏标记，下次重试）: ${err?.message ?? String(err)}`,
      );
    }
  }

  /** 清理过期的其他会话目录 */
  private cleanupOldSessions(): void {
    const log = getLogger();
    const parentDir = sidPaths.checkpointsRoot();

    try {
      if (!existsSync(parentDir)) return;

      const sessions = readdirSync(parentDir);
      const now = Date.now();
      const maxAgeMs = this.config.maxAgeDays * 24 * 60 * 60 * 1000;
      const maxTotalBytes = this.config.maxTotalSizeMb * 1024 * 1024;

      // 存活会话（未过期、非当前）的 {目录, mtime, 大小}，用于后续按 LRU 真删。
      const survivors: Array<{ dir: string; name: string; mtimeMs: number; size: number }> = [];
      let totalSize = 0;

      for (const session of sessions) {
        if (session === this.sessionId) continue;

        const sessionDir = join(parentDir, session);
        try {
          const stat = statSync(sessionDir);
          if (!stat.isDirectory()) continue;

          // 检查是否过期
          if (now - stat.mtimeMs > maxAgeMs) {
            rmSync(sessionDir, { recursive: true, force: true });
            log.debug("CHECKPOINT", `清理过期会话: ${session}`);
            continue;
          }

          // 累计大小
          const size = this.getDirSize(sessionDir);
          totalSize += size;
          survivors.push({ dir: sessionDir, name: session, mtimeMs: stat.mtimeMs, size });
        } catch {
          // 忽略无法访问的目录
        }
      }

      // P1-2：总大小超限时真删（此前只 warn）。按 mtime LRU 删最旧的其他 session 目录，
      // 删到阈值下。当前 session（this.sessionId）永不在候选内（上面已 skip），由写时 evictBySize 自清。
      if (totalSize > maxTotalBytes) {
        survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧在前
        for (const s of survivors) {
          if (totalSize <= maxTotalBytes) break;
          try {
            rmSync(s.dir, { recursive: true, force: true });
            totalSize -= s.size;
            log.debug(
              "CHECKPOINT",
              `总量超限清理最旧会话: ${s.name} (释放 ${(s.size / 1024 / 1024).toFixed(1)}MB)`,
            );
          } catch {
            // 单个删除失败不影响其余
          }
        }
      }
    } catch {
      // 忽略清理错误
    }
  }

  /**
   * 计算目录大小。
   *
   * P3：必须**递归**——快照本体现在在 `snapshots/` 子目录里，只统计一层的话
   * cleanupOldSessions 看到的会是一个几百字节的 index.json，跨会话总量清理等于失效。
   */
  private getDirSize(dir: string): number {
    let size = 0;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        const filePath = join(dir, file);
        const stat = statSync(filePath);
        if (stat.isFile()) {
          size += stat.size;
        } else if (stat.isDirectory()) {
          size += this.getDirSize(filePath);
        }
      }
    } catch {
      // 忽略
    }
    return size;
  }

  /** 获取当前会话的 checkpoint 统计 */
  getStats(): { fileCount: number; totalCheckpoints: number } {
    const uniqueFiles = new Set<string>();
    for (const snapshot of this.index.snapshots) {
      for (const file of snapshot.files) {
        uniqueFiles.add(file.filePath);
      }
    }
    return {
      fileCount: uniqueFiles.size,
      totalCheckpoints: this.index.snapshots.length,
    };
  }
}

/** 全局 CheckpointManager 实例（延迟初始化） */
let globalCheckpointManager: CheckpointManager | null = null;

/** 获取或创建全局 CheckpointManager */
export async function getCheckpointManager(
  sessionId: string,
  config?: CheckpointConfig,
): Promise<CheckpointManager> {
  if (!globalCheckpointManager || (globalCheckpointManager as any).sessionId !== sessionId) {
    globalCheckpointManager = new CheckpointManager(sessionId, config);
    await globalCheckpointManager.init();
  }
  return globalCheckpointManager;
}
