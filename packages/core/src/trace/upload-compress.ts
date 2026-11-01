/**
 * 上传前的流式变换 + 压缩，产物落盘缓存（U1/U3，PR-C）。
 *
 * ## 要堵的洞
 *
 * 旧实现对整份文件 `bytes()` 读入 → `TextDecoder` 整份解码 → 脱敏 replace → `Bun.gzipSync`，
 * 445MB 的 traj 每次 3.0–3.5s 同步 CPU + GB 级内存；而且**每次重试都重压一遍**（最多 5 次）。
 *
 * ## 做法
 *
 * `Bun.file().stream()` → 按行做 events 的 `stripLocalOnlyEventFields` 与家目录脱敏 →
 * `CompressionStream("gzip")` → 写入 `<sessionDir>/.upload-cache/<file>.gz`，边写边算 SHA256。
 * 内存只随「最长一行」增长，不随文件大小增长。
 *
 * 缓存 key = 源文件 size + mtimeMs + 变换选项。重试和下次启动直接复用；源文件一变即失效。
 * 上传成功 / 进入终态后由调用方删掉缓存目录。
 *
 * ⚠️ SHA256 对**实际发出去的字节**算（压缩之后），与服务端 `X-Content-SHA256` 校验口径一致。
 *
 * ## 为什么按行变换是安全的
 *
 * 两个变换都不跨行：`stripLocalOnlyEventFields` 本来就逐行处理；`redactHomeDir` 的匹配
 * 里不含换行（家目录路径不含 `\n`），右边界允许 `$`（行尾）——按行切与整份处理结果逐字节相同
 * （单测锁住）。切分只在 `\n` 上做，chunk 边界不会切开一行。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { redactHomeDir } from "./redact-home.ts";
import { preservingDirMtime } from "./upload-attempts.ts";

export const UPLOAD_CACHE_DIR = ".upload-cache";

export interface PreparedUpload {
  /** 实际要发送的文件（压缩开时是缓存里的 .gz；不压缩且无变换时就是源文件） */
  path: string;
  sha256: string;
  bytes: number;
  /** 是否命中已有缓存（验收用：证明重试/下次启动不再重压） */
  cacheHit: boolean;
}

export interface PrepareOptions {
  compress: boolean;
  redactHomeDir: boolean;
  /** events.jsonl 专用：剥掉只留本地的字段 */
  stripLocalOnly?: (line: string) => string;
  /** 测试注入家目录 */
  home?: string;
}

interface CacheMeta {
  srcSize: number;
  srcMtimeMs: number;
  compress: boolean;
  redact: boolean;
  strip: boolean;
  sha256: string;
  bytes: number;
}

function cachePaths(
  srcPath: string,
  compress: boolean,
): { dir: string; data: string; meta: string } {
  const dir = join(srcPath, "..", UPLOAD_CACHE_DIR);
  const name = basename(srcPath);
  // 不压缩时产物只是变换后的明文，别叫 .gz
  const data = join(dir, compress ? `${name}.gz` : `${name}.out`);
  return { dir, data, meta: join(dir, `${name}.meta.json`) };
}

/** 逐块读完一条流（不用 for-await：lib.dom 的 ReadableStream 类型不声明 asyncIterator） */
async function drain(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) onChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** 逐行变换的 TransformStream（只在 \n 上切，保留原有换行） */
function lineTransform(fn: (line: string) => string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = carry + decoder.decode(chunk, { stream: true });
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) {
        carry = text;
        return;
      }
      carry = text.slice(lastNl + 1);
      const complete = text.slice(0, lastNl);
      const out = complete
        .split("\n")
        .map((l) => fn(l))
        .join("\n");
      controller.enqueue(encoder.encode(out + "\n"));
    },
    flush(controller) {
      const rest = carry + decoder.decode();
      if (rest.length > 0) controller.enqueue(encoder.encode(fn(rest)));
    },
  });
}

/**
 * 准备一份可上传的文件。命中缓存时 O(1)（stat + 读一个小 meta）。
 * 未命中时整条流水线是异步分块的，不会长时间占住事件循环。
 */
export async function prepareUploadFile(
  srcPath: string,
  opts: PrepareOptions,
): Promise<PreparedUpload> {
  const st = statSync(srcPath);
  const strip = !!opts.stripLocalOnly;
  const needsTransform = opts.redactHomeDir || strip;

  // 不压缩也不变换：直接发源文件（仍要流式算 hash）
  if (!opts.compress && !needsTransform) {
    const hasher = new Bun.CryptoHasher("sha256");
    await drain(Bun.file(srcPath).stream(), (c) => hasher.update(c));
    return { path: srcPath, sha256: hasher.digest("hex"), bytes: st.size, cacheHit: false };
  }

  const { dir, data, meta } = cachePaths(srcPath, opts.compress);
  try {
    if (existsSync(meta) && existsSync(data)) {
      const m = JSON.parse(readFileSync(meta, "utf-8")) as CacheMeta;
      if (
        m.srcSize === st.size &&
        m.srcMtimeMs === st.mtimeMs &&
        m.compress === opts.compress &&
        m.redact === opts.redactHomeDir &&
        m.strip === strip &&
        statSync(data).size === m.bytes
      ) {
        return { path: data, sha256: m.sha256, bytes: m.bytes, cacheHit: true };
      }
    }
  } catch {
    /* 缓存损坏：重建 */
  }

  // 缓存目录建在会话目录里：保持会话目录 mtime（理由见 preservingDirMtime）
  if (!existsSync(dir))
    preservingDirMtime(join(dir, ".."), () => mkdirSync(dir, { recursive: true }));
  let stream: ReadableStream<Uint8Array> = Bun.file(srcPath).stream();
  if (needsTransform) {
    stream = stream.pipeThrough(
      lineTransform((line) => {
        let l = line;
        if (opts.stripLocalOnly) l = opts.stripLocalOnly(l);
        if (opts.redactHomeDir) l = redactHomeDir(l, opts.home);
        return l;
      }),
    );
  }
  if (opts.compress) {
    stream = stream.pipeThrough(
      new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  }

  // 先写临时文件再改名：中途被杀不会留下一个 meta 对得上、内容却残缺的缓存
  const tmp = `${data}.tmp-${process.pid}`;
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(tmp).writer();
  let bytes = 0;
  try {
    await drain(stream, (chunk) => {
      hasher.update(chunk);
      writer.write(chunk);
      bytes += chunk.byteLength;
    });
    await writer.end();
  } catch (err) {
    try {
      await writer.end();
    } catch {
      /* 忽略 */
    }
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, data);
  const sha256 = hasher.digest("hex");
  const m: CacheMeta = {
    srcSize: st.size,
    srcMtimeMs: st.mtimeMs,
    compress: opts.compress,
    redact: opts.redactHomeDir,
    strip,
    sha256,
    bytes,
  };
  writeFileSync(meta, JSON.stringify(m));
  return { path: data, sha256, bytes, cacheHit: false };
}

/** 上传成功或进入终态后清掉压缩缓存 */
export function clearUploadCache(sessionDir: string): void {
  try {
    const dir = join(sessionDir, UPLOAD_CACHE_DIR);
    if (existsSync(dir)) {
      preservingDirMtime(sessionDir, () => rmSync(dir, { recursive: true, force: true }));
    }
  } catch {
    /* 残留缓存只占盘，下次成功时再删 */
  }
}
