/**
 * 市场插件包（tar.gz）的安全解包（P5）。
 *
 * 为什么自己解析 tar 而不是调 `tar -xzf` / 第三方库：
 * - 包来自网络，解包是**授予信任**的一步（解出来的 hooks 会在本机执行命令），必须 fail-closed；
 * - 要拒的东西（符号链接、硬链接、设备文件、`..`、绝对路径）取决于条目的 typeflag 与原始名字，
 *   外部 tar 默认会照单全收（GNU tar 只对 `..` 有部分保护，对符号链接 + 后续条目写穿链接无保护），
 *   而「先解到磁盘再检查」等于事故已经发生（zip slip 正是在解的那一刻写到目录外）；
 * - ustar 格式只有 512 字节头 + 数据块，读法固定，全量实现不到两百行，审计成本低于引一个库。
 *
 * 与服务端 `marketplace/service/package.py` 同一套规则：服务端上传时已拒过一遍，
 * 这里**再拒一遍**——制品在存储 / 传输链路上被换掉时，客户端是最后一道防线
 * （sha256 校验挡的是「被换」，这里挡的是「服务端规则有漏洞 / 被绕过」）。
 *
 * 只接受：普通文件（'0' / '\0'）、目录（'5'）；pax 扩展头（'x' / 'g'）与 GNU 长名（'L'）
 * 只用来取名字，不产生条目。其余一律拒绝整包。
 */

import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";

/** 与服务端 package.py 同口径的上限 */
export const ARCHIVE_LIMITS = {
  /** 压缩后（下载体积） */
  maxCompressedBytes: 20 * 1024 * 1024,
  /** 解压后（防 gzip 炸弹：gunzip 超出即抛，不会先把 1GB 读进内存） */
  maxUncompressedBytes: 100 * 1024 * 1024,
  /** 条目数（含目录） */
  maxEntries: 2000,
} as const;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface ArchiveEntry {
  /** 规范化后的包内相对路径（无 `./` 前缀、无尾斜杠，`/` 分隔） */
  path: string;
  type: "file" | "dir";
  data?: Buffer;
}

const BLOCK = 512;

function readString(buf: Buffer, start: number, len: number): string {
  const raw = buf.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return (nul >= 0 ? raw.subarray(0, nul) : raw).toString("utf-8");
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const s = readString(buf, start, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new ArchiveError(`tar 头的数字字段不合法: ${JSON.stringify(s)}`);
  return parseInt(s, 8);
}

/** 解析 pax 扩展头里的 `path=`（其余键忽略）。格式：`<len> <key>=<value>\n` 重复。 */
function paxPath(data: Buffer): string | undefined {
  let off = 0;
  let path: string | undefined;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const len = parseInt(data.subarray(off, space).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0 || off + len > data.length) {
      throw new ArchiveError("pax 扩展头格式不合法");
    }
    const record = data.subarray(space + 1, off + len - 1).toString("utf-8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    off += len;
  }
  return path;
}

/**
 * 校验并规范化条目名。返回 null 表示「包根本身」（`./`），调用方跳过。
 * 拒绝：空名、NUL、反斜杠、绝对路径、盘符、`..` 段。
 */
export function normalizeEntryPath(raw: string): string | null {
  if (raw.includes("\0")) throw new ArchiveError(`条目名含 NUL: ${JSON.stringify(raw)}`);
  if (raw.includes("\\")) throw new ArchiveError(`条目名含反斜杠: ${raw}`);
  if (raw.startsWith("/") || isAbsolute(raw)) throw new ArchiveError(`条目是绝对路径: ${raw}`);
  if (/^[A-Za-z]:/.test(raw)) throw new ArchiveError(`条目带盘符: ${raw}`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new ArchiveError(`条目含 ..: ${raw}`);
  if (parts.length === 0) return null;
  return parts.join("/");
}

/**
 * 解析 tar.gz 为条目列表（纯内存，不碰磁盘）。任何一条不合规即抛 ArchiveError，整包作废。
 */
export function parseTarGz(compressed: Buffer): ArchiveEntry[] {
  if (compressed.length > ARCHIVE_LIMITS.maxCompressedBytes) {
    throw new ArchiveError(`插件包超过 ${ARCHIVE_LIMITS.maxCompressedBytes} 字节上限`);
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: ARCHIVE_LIMITS.maxUncompressedBytes });
  } catch (err: any) {
    if (err?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new ArchiveError(`插件包解压后超过 ${ARCHIVE_LIMITS.maxUncompressedBytes} 字节上限`);
    }
    throw new ArchiveError(`插件包不是合法的 gzip: ${err?.message ?? err}`);
  }

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let pendingName: string | undefined;
  let off = 0;

  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // 结束块

    const magic = readString(header, 257, 6);
    if (!magic.startsWith("ustar")) throw new ArchiveError("不是 ustar 格式的 tar 包");

    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]!);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new ArchiveError("tar 包被截断");
    const data = tar.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // 元数据头：只取名字，不产生条目
    if (typeflag === "x") {
      pendingName = paxPath(data) ?? pendingName;
      continue;
    }
    if (typeflag === "g") continue;
    if (typeflag === "L") {
      pendingName = readString(data, 0, data.length);
      continue;
    }

    const prefix = readString(header, 345, 155);
    const shortName = readString(header, 0, 100);
    const rawName = pendingName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    pendingName = undefined;

    let type: ArchiveEntry["type"];
    if (typeflag === "0" || typeflag === "\0") type = "file";
    else if (typeflag === "5") type = "dir";
    else if (typeflag === "1" || typeflag === "2") {
      throw new ArchiveError(`插件包不允许链接条目: ${rawName}`);
    } else {
      throw new ArchiveError(`插件包只允许普通文件与目录（${rawName} 类型 ${typeflag}）`);
    }

    const path = normalizeEntryPath(rawName);
    if (path === null) continue;
    if (seen.has(path)) throw new ArchiveError(`插件包有重复条目: ${path}`);
    seen.add(path);
    if (seen.size > ARCHIVE_LIMITS.maxEntries) {
      throw new ArchiveError(`插件包条目数超过 ${ARCHIVE_LIMITS.maxEntries}`);
    }

    entries.push(type === "file" ? { path, type, data: Buffer.from(data) } : { path, type });
  }

  // 文件与目录同名（a 是文件、a/b 也在）会让后写的那个失败或覆盖，按坏包处理
  const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.path));
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (files.has(parts.slice(0, i).join("/"))) {
        throw new ArchiveError(`插件包里 ${parts.slice(0, i).join("/")} 既是文件又是目录`);
      }
    }
  }
  return entries;
}

/**
 * 把条目写到 destDir（必须是**新建的空目录**，由调用方保证）。
 * 每条写之前再核一次解析后的绝对路径落在 destDir 内 —— 与 normalizeEntryPath 是两道独立的判据，
 * 任一被改坏另一道仍然拦得住。
 */
export async function writeEntries(entries: ArchiveEntry[], destDir: string): Promise<void> {
  const root = resolve(destDir);
  for (const e of entries) {
    const target = resolve(root, e.path);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
      throw new ArchiveError(`条目解析到目标目录之外: ${e.path}`);
    }
    if (e.type === "dir") {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      // flag "wx"：目标已存在即失败。目录是新建的，存在只可能是包内冲突
      await writeFile(target, e.data ?? Buffer.alloc(0), { flag: "wx", mode: 0o644 });
    }
  }
}

/** parseTarGz + writeEntries。返回写出的文件相对路径（排序）。 */
export async function extractTarGz(compressed: Buffer, destDir: string): Promise<string[]> {
  const entries = parseTarGz(compressed);
  await writeEntries(entries, destDir);
  return entries
    .filter((e) => e.type === "file")
    .map((e) => e.path)
    .sort();
}

/** 测试与调试用：包内路径拼到目录上 */
export function entryAbsPath(destDir: string, entryPath: string): string {
  return join(destDir, ...entryPath.split("/"));
}
