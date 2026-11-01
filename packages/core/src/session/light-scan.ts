/**
 * 会话轻量扫描器（C1）：只为自动清理取「判删所需的最少信息」，不组装完整 SessionInfo。
 *
 * ## 为什么不能直接复用 getAllSessionFiles
 *
 * 全量扫描器对每个会话 `Bun.file().text()` + `parseSessionJsonl`，组装 displayName、
 * 首条用户消息和全部 messages。清理只需要 id / lastUpdated / 排除成因。本机实测：
 * 读 345MB、parse 一行 178MB 的消息 359ms，RSS 冲到 2.7–3GB——耗时与内存都随数据量增长。
 *
 * ## 判据同源（一条都不许丢）
 *
 * - **小文件（≤ {@link FULL_READ_MAX_BYTES}）**：读全文后交给 `buildSessionFileEntry`——
 *   与全量扫描器**同一个函数**，D4/D9/N1 判据零复刻。绝大多数会话走这条。
 * - **大文件**：流式逐行，每行只保留行首（取 `type`）与行尾（取 `timestamp`），
 *   ≤ {@link SMALL_LINE_MAX_BYTES} 的行才 JSON.parse（session_start / metadata /
 *   prompt_retracted 都很小）。巨型消息行（实测单行 7700 万字符）永远不做 parse。
 *   按记录类型**线性**回放出与解析器相同的几个量：
 *     - D9 sidechain：首行 type 为 `sidechain_start`
 *     - id / createdAt：`session_start` 记录
 *     - updatedAt：最后一条记录的 timestamp（与 parseSessionJsonlLines 每种记录都刷新 updatedAt 同口径）
 *     - D4 empty：按 prompt_retracted 的 dropCount 弹栈后，是否还剩 user/assistant 记录
 *     - D4 subagent：metadata `kind === "subagent"`
 *     - N1：拿不到 session_start 时，是否还有任何消息记录（chain-broken vs parse-error）
 *
 * ⚠️ 大文件这条路径是**线性**回放，不做 uuid 链重建（rebuildRecordOrder）。两者只在
 * 「多进程交叉写同一文件」时有差异；为此 `light-scan.test.ts` 用对照测试锁住
 * 「同一批 fixture 上与全量扫描器逐条判定一致」。
 *
 * ⚠️ 为什么大文件要扫到底，而不是方案里写的「读到第一条消息就停」：D4 的空会话判断是
 * **回放 prompt_retracted 之后**的结果——撤回掉唯一一条超大粘贴的会话，全量扫描器判 empty
 * （不可删），读到第一条就停会判成有效会话、过期即删。判据不同 = 删错，所以必须扫到底。
 * 代价是 O(大文件字节数) 的 IO，但 CPU 只做找换行与短正则，且只在维护子进程里跑（24h 一次）。
 */

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionFileEntry, SessionInfo, SessionExcludeReason } from "./utils.ts";
import { buildSessionFileEntry } from "./utils.ts";
import { flushPendingSessionWrites, listAllSessionDirs } from "./store.ts";
import { sidPaths } from "../config/paths.ts";

/** 不超过它的会话文件读全文、走全量判据（与列表扫描器完全同源） */
export const FULL_READ_MAX_BYTES = 1024 * 1024;
/** 大文件里，不超过它的行才整行 JSON.parse；更长的行只看行首与行尾 */
const SMALL_LINE_MAX_BYTES = 64 * 1024;
/** 长行保留的行首字节数：足够容纳 `{"type":"assistant_message",` */
const LINE_HEAD_BYTES = 64;
/**
 * 长行保留的行尾字节数。消息记录的键序是 type/message/timestamp/…/uuid/parentUuid
 * （store.ts appendRecord 的 `{ ...partial, uuid, parentUuid }`），timestamp 之后只剩
 * 几个短字段，4KB 足够覆盖。
 */
const LINE_TAIL_BYTES = 4096;

const TYPE_RE = /^\{"type":"([a-z_]+)"/;
// 行尾里最后一个 `"timestamp":"…"`。消息正文里的同名串在 JSON 字符串内会被转义成
// `\"timestamp\":\"`，不会匹配这个未转义形态。
const TS_RE = /"timestamp":"([^"\\]+)"/g;

/** 单行的可用视图：短行给全文，长行只给首尾 */
interface LineView {
  full?: string;
  head: string;
  tail: string;
}

/** 大文件线性回放的累积状态 */
interface ReplayState {
  lineNo: number;
  firstType?: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  cwd?: string;
  model?: string;
  kind?: unknown;
  sawMessage: boolean;
  /** 未被撤回的消息记录类型栈（只存类型，不存内容） */
  stack: string[];
}

function lineType(v: LineView): string | undefined {
  return TYPE_RE.exec(v.head)?.[1];
}

function lastTimestamp(text: string): string | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(TS_RE)) last = m[1];
  return last;
}

function applyLine(st: ReplayState, v: LineView): void {
  st.lineNo++;
  const type = lineType(v);
  if (st.lineNo === 1) st.firstType = type;
  if (!type) return; // 坏行：解析器线性兜底同样跳过

  let rec: Record<string, any> | undefined;
  if (v.full !== undefined) {
    try {
      rec = JSON.parse(v.full);
    } catch {
      // 短行却 parse 不了 = 坏行，解析器会跳过它（linearParseRecords 的 try/continue）
      return;
    }
  }
  const ts: string | undefined =
    rec && typeof rec.timestamp === "string" ? rec.timestamp : lastTimestamp(v.tail);

  switch (type) {
    case "session_start":
      if (!rec) return; // session_start 不可能是巨型行；真出现就按坏行处理（保守：拿不到 id）
      st.sessionId = rec.sessionId;
      st.createdAt = rec.timestamp;
      st.updatedAt = rec.timestamp;
      if (typeof rec.cwd === "string") st.cwd = rec.cwd;
      if (typeof rec.model === "string") st.model = rec.model;
      return;
    case "user_message":
    case "assistant_message":
    case "tool_result":
      st.sawMessage = true;
      st.stack.push(type);
      if (ts) st.updatedAt = ts;
      return;
    case "metadata":
      if (rec?.key === "kind") st.kind = rec.value;
      if (ts) st.updatedAt = ts;
      return;
    case "prompt_retracted": {
      const n = Math.min(Math.max(0, Math.floor(rec?.dropCount) || 0), st.stack.length);
      if (n > 0) st.stack.splice(st.stack.length - n, n);
      if (ts) st.updatedAt = ts;
      return;
    }
    case "context_compact":
    case "session_end":
      if (ts) st.updatedAt = ts;
      return;
    default:
      return;
  }
}

/**
 * 流式逐行读取大文件，每行只保留首尾（短行保留全文）。内存与文件大小无关。
 */
async function replayLargeFile(filePath: string): Promise<ReplayState> {
  const st: ReplayState = {
    lineNo: 0,
    sessionId: "",
    createdAt: "",
    updatedAt: "",
    sawMessage: false,
    stack: [],
  };
  const decoder = new TextDecoder();
  // 当前行的累积：短行时攒全文（chunks），超过阈值后丢弃中段，只留 head + 滚动 tail
  let chunks: Uint8Array[] = [];
  let lineLen = 0;
  let head: Uint8Array | null = null;
  let tail = new Uint8Array(0);

  const appendTail = (part: Uint8Array) => {
    if (part.length >= LINE_TAIL_BYTES) {
      tail = part.slice(part.length - LINE_TAIL_BYTES);
      return;
    }
    const merged = new Uint8Array(Math.min(LINE_TAIL_BYTES, tail.length + part.length));
    const keepOld = merged.length - part.length;
    merged.set(tail.subarray(tail.length - keepOld), 0);
    merged.set(part, keepOld);
    tail = merged;
  };

  const pushPart = (part: Uint8Array) => {
    if (part.length === 0) return;
    if (head === null) {
      // 仍在「短行」模式
      if (lineLen + part.length <= SMALL_LINE_MAX_BYTES) {
        chunks.push(part.slice());
        lineLen += part.length;
        return;
      }
      // 切换到长行模式：固化行首，旧 chunks 并入 tail。
      // ⚠️ 行首必须把**本次这段**也算进去：一行的第一个 chunk 本身就可能超过阈值
      // （流的 chunk 常见 64KB+），只取旧 chunks 会得到空行首 ⇒ 读不出 type ⇒
      // chain-broken 被误判成可删的 parse-error（对照测试实测抓到过）。
      const prev = concat(chunks, lineLen);
      const headBuf = new Uint8Array(Math.min(LINE_HEAD_BYTES, prev.length + part.length));
      headBuf.set(prev.subarray(0, headBuf.length), 0);
      if (prev.length < headBuf.length) {
        headBuf.set(part.subarray(0, headBuf.length - prev.length), prev.length);
      }
      head = headBuf;
      chunks = [];
      appendTail(prev);
    }
    lineLen += part.length;
    appendTail(part);
  };

  const endLine = () => {
    if (lineLen > 0) {
      let view: LineView;
      if (head === null) {
        const full = decoder.decode(concat(chunks, lineLen)).replace(/\r$/, "");
        if (full.trim()) {
          view = { full, head: full.slice(0, LINE_HEAD_BYTES), tail: full };
          applyLine(st, view);
        }
      } else {
        view = { head: decoder.decode(head), tail: decoder.decode(tail) };
        applyLine(st, view);
      }
    }
    chunks = [];
    lineLen = 0;
    head = null;
    tail = new Uint8Array(0);
  };

  const reader = Bun.file(filePath).stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let start = 0;
    for (;;) {
      const nl = value.indexOf(0x0a, start);
      if (nl === -1) {
        pushPart(value.subarray(start));
        break;
      }
      pushPart(value.subarray(start, nl));
      endLine();
      start = nl + 1;
    }
  }
  endLine();
  return st;
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 把大文件的回放结果翻译成与 buildSessionFileEntry 同形的条目 */
function entryFromReplay(
  file: string,
  dirPath: string,
  st: ReplayState,
  currentSessionId?: string,
): SessionFileEntry {
  const excluded = (excludeReason: SessionExcludeReason): SessionFileEntry => ({
    fileName: file,
    dirPath,
    sessionInfo: null,
    excludeReason,
  });
  if (st.firstType === "sidechain_start") return excluded("sidechain");
  if (!st.sessionId) return excluded(st.sawMessage ? "chain-broken" : "parse-error");
  if (!st.createdAt || !st.updatedAt) return excluded("missing-fields");
  if (!st.stack.some((t) => t === "user_message" || t === "assistant_message")) {
    return excluded("empty");
  }
  if (st.kind === "subagent") return excluded("subagent");

  // ⚠️ 只填清理用得到的字段。displayName / firstUserMessage 刻意留空：
  // 轻量条目**不供展示**，拿它渲染列表会出现一排空标题。
  const sessionInfo: SessionInfo = {
    id: st.sessionId,
    file: file.replace(/\.(json|jsonl)$/, ""),
    fileName: file,
    startTime: st.createdAt,
    lastUpdated: st.updatedAt,
    messageCount: st.stack.length,
    displayName: "",
    firstUserMessage: "",
    isCurrentSession: currentSessionId ? st.sessionId === currentSessionId : false,
    index: 0,
    cwd: st.cwd,
    model: st.model,
    dirPath,
  };
  return { fileName: file, dirPath, sessionInfo };
}

/** 扫一个会话目录（与 utils.ts scanSessionDir 的文件筛选口径一致） */
async function lightScanDir(dir: string, currentSessionId?: string): Promise<SessionFileEntry[]> {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => (f.endsWith(".json") || f.endsWith(".jsonl")) && !f.startsWith("."))
      .sort();
  } catch {
    return [];
  }
  const out: SessionFileEntry[] = [];
  // 串行：维护子进程里不追求并发，避免同时打开几百个大文件把内存顶上去
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const st = statSync(filePath);
      if (!st.isFile()) {
        out.push({ fileName: file, dirPath: dir, sessionInfo: null, excludeReason: "not-a-file" });
        continue;
      }
      // 旧 .json 是整份 JSON，只能全文解析；它们都是迁移前的小文件
      if (st.size <= FULL_READ_MAX_BYTES || file.endsWith(".json")) {
        const content = await Bun.file(filePath).text();
        out.push(buildSessionFileEntry(file, dir, content, currentSessionId));
        continue;
      }
      out.push(entryFromReplay(file, dir, await replayLargeFile(filePath), currentSessionId));
    } catch {
      // 与全量扫描器同口径：读失败可能是瞬时故障 → read-error（不可删）
      out.push({ fileName: file, dirPath: dir, sessionInfo: null, excludeReason: "read-error" });
    }
  }
  return out;
}

/**
 * 轻量版 getAllSessionFiles：返回值形态相同，可直接喂给 identifySessionsToDelete。
 * 语义同样是「sessionDir 为 sessions 根 ⇒ 跨全部项目子目录」。
 */
export async function lightScanSessionFiles(
  sessionDir: string,
  currentSessionId?: string,
): Promise<SessionFileEntry[]> {
  flushPendingSessionWrites();
  const dirs = sessionDir === sidPaths.sessions() ? listAllSessionDirs() : [sessionDir];
  const out: SessionFileEntry[] = [];
  for (const d of dirs) out.push(...(await lightScanDir(d, currentSessionId)));
  return out;
}
