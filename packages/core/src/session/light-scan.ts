/**
 * 会话轻量扫描器（C1）：只为自动清理取「判删所需的最少信息」，不组装完整 SessionInfo。
 * R1：同一套回放也供会话列表用（{@link lightListSessions}），大文件的标题只从短行里取。
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
import type {
  SessionFileEntry,
  SessionInfo,
  SessionExcludeReason,
  GetSessionOptions,
} from "./utils.ts";
import {
  buildSessionFileEntry,
  extractFirstUserMessage,
  finalizeSessionList,
  isTitleCandidateMessage,
} from "./utils.ts";
import type { Message } from "../llm/types.ts";
import { flushPendingSessionWrites, listAllSessionDirs } from "./store.ts";
import { sidPaths } from "../config/paths.ts";

/** 不超过它的会话文件读全文、走全量判据（与列表扫描器完全同源） */
export const FULL_READ_MAX_BYTES = 1024 * 1024;
/** 大文件里，不超过它的行才整行 JSON.parse；更长的行只看行首与行尾 */
const SMALL_LINE_MAX_BYTES = 64 * 1024;
/**
 * 长行保留的行首字节数：要容纳 `{"type":"user_message","message":{"role":"user","content":[{"type":"tool_result"`
 * （R1 据此认出「工具结果开头」的巨型行，见 TOOL_RESULT_HEAD_RE）。
 */
const LINE_HEAD_BYTES = 256;
/**
 * 长行保留的行尾字节数。消息记录的键序是 type/message/timestamp/…/uuid/parentUuid
 * （store.ts appendRecord 的 `{ ...partial, uuid, parentUuid }`），timestamp 之后只剩
 * 几个短字段，4KB 足够覆盖。
 */
const LINE_TAIL_BYTES = 4096;

const TYPE_RE = /^\{"type":"([a-z_]+)"/;
/**
 * R1：巨型 user_message 行的首个内容块是 tool_result ⇒ 它是工具结果回传，不是用户输入，
 * 不可能当标题（getMessageContent 只取 text 块）。实测 2/517 个会话的首条合格输入排在一条
 * 巨型工具结果之后，不认出它就会把本可取到的标题判成占位。
 * ⚠️ 近似：同一条消息若在工具结果后面又带 text 块，这里会漏掉它——只影响列表标题，不影响判删。
 */
const TOOL_RESULT_HEAD_RE = /"content":\[\{"type":"tool_result"/;
// 行尾里最后一个 `"timestamp":"…"`。消息正文里的同名串在 JSON 字符串内会被转义成
// `\"timestamp\":\"`，不会匹配这个未转义形态。
const TS_RE = /"timestamp":"([^"\\]+)"/g;

/** 单行的可用视图：短行给全文，长行只给首尾 */
interface LineView {
  full?: string;
  head: string;
  tail: string;
}

/** 一条 user_message 的标题素材：短行给消息体；巨型工具结果行给空消息（非候选）；其余巨型行 null（未知） */
function titleSource(rec: Record<string, any> | undefined, v: LineView): Message | null {
  if (rec) return rec.message && typeof rec.message === "object" ? rec.message : null;
  if (TOOL_RESULT_HEAD_RE.test(v.head)) return { role: "user", content: [] } as Message;
  return null;
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
  /**
   * R1：与 stack 一一对应的「列表标题素材」。只有**短行**的 user_message 存消息体
   * （≤ SMALL_LINE_MAX_BYTES，已经 parse 过，不额外付出成本）；巨型行存 null，
   * 永远不为一个标题去读全文。其余类型存 undefined。
   */
  titles: Array<Message | null | undefined>;
  /** metadata 里的 summary / session_name（都是短行） */
  summary?: string;
  sessionName?: string;
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
      st.titles.push(type === "user_message" ? titleSource(rec, v) : undefined);
      if (ts) st.updatedAt = ts;
      return;
    case "metadata":
      if (rec?.key === "kind") st.kind = rec.value;
      if (rec?.key === "summary" && typeof rec.value === "string") st.summary = rec.value;
      if (rec?.key === "session_name" && typeof rec.value === "string") st.sessionName = rec.value;
      if (ts) st.updatedAt = ts;
      return;
    case "prompt_retracted": {
      const n = Math.min(Math.max(0, Math.floor(rec?.dropCount) || 0), st.stack.length);
      if (n > 0) {
        st.stack.splice(st.stack.length - n, n);
        st.titles.splice(st.titles.length - n, n);
      }
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
    titles: [],
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

/** 巨型首条输入的占位标题（R1：不为一个标题读全文） */
export const OVERSIZED_TITLE_PLACEHOLDER = "（首条消息内容过大）";

/**
 * R1：按 extractFirstUserMessage 的同一规则选首条用户消息，只是候选里的巨型行没有正文。
 * 按顺序走：先遇到巨型行 ⇒ 它可能就是首条，内容不可知 → 占位，不猜；
 * 先遇到合格短行 ⇒ 就是它。全都不合格 ⇒ 与原函数同样回退到第一条（巨型则占位）。
 */
function replayFirstUserMessage(st: ReplayState): string {
  const users = st.titles.filter((t) => t !== undefined);
  if (users.length === 0) return "空对话";
  for (const t of users) {
    if (t === null) return OVERSIZED_TITLE_PLACEHOLDER;
    if (isTitleCandidateMessage(t)) return extractFirstUserMessage([t]);
  }
  return extractFirstUserMessage(users as Message[]);
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

  const firstUserMessage = replayFirstUserMessage(st);
  const sessionInfo: SessionInfo = {
    id: st.sessionId,
    file: file.replace(/\.(json|jsonl)$/, ""),
    fileName: file,
    startTime: st.createdAt,
    lastUpdated: st.updatedAt,
    messageCount: st.stack.length,
    // 与 buildSessionFileEntry 同优先级：session_name → summary → 首条用户消息
    displayName:
      (st.sessionName?.trim() ? st.sessionName : undefined) || st.summary || firstUserMessage,
    firstUserMessage,
    summary: st.summary,
    isCurrentSession: currentSessionId ? st.sessionId === currentSessionId : false,
    index: 0,
    cwd: st.cwd,
    model: st.model,
    dirPath,
  };
  return { fileName: file, dirPath, sessionInfo };
}

/** 扫一个会话目录（与 utils.ts scanSessionDir 的文件筛选口径一致） */
async function lightScanDir(
  dir: string,
  currentSessionId?: string,
  options: GetSessionOptions = {},
): Promise<SessionFileEntry[]> {
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
        out.push(buildSessionFileEntry(file, dir, content, currentSessionId, options));
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
  options: GetSessionOptions = {},
): Promise<SessionFileEntry[]> {
  flushPendingSessionWrites();
  const dirs = sessionDir === sidPaths.sessions() ? listAllSessionDirs() : [sessionDir];
  const out: SessionFileEntry[] = [];
  for (const d of dirs) out.push(...(await lightScanDir(d, currentSessionId, options)));
  return out;
}

/**
 * R1：轻量版 getSessionFiles，供会话选择器 / `--list-sessions` / `-r <id>` 解析使用。
 *
 * 与全量版的差异只在 > FULL_READ_MAX_BYTES 的文件：
 * - 标题来自 session_name / summary / 短行里的首条用户消息；首条是巨型行时显示
 *   {@link OVERSIZED_TITLE_PLACEHOLDER}，不读全文；
 * - `includeFullContent`（选择器的全文搜索）对它们**不加载正文**，只能按标题 / id 命中。
 *   为了搜一个关键词把 222MB 整份读入 + parse，正是 R1 要消掉的冻结。
 * 小文件走同一个 buildSessionFileEntry，列表和搜索结果与全量版逐字段一致。
 */
export async function lightListSessions(
  sessionDir: string,
  currentSessionId?: string,
  options: GetSessionOptions = {},
): Promise<SessionInfo[]> {
  return finalizeSessionList(await lightScanSessionFiles(sessionDir, currentSessionId, options));
}
