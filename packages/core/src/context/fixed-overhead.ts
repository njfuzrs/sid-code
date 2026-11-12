/**
 * /context 的「固定开销来源」（F5 / PR-4）
 *
 * ─── 要解决的问题 ───
 *
 * 2026-11-12 排查：最近 7 个真实任务首轮 input 稳定在 ≈45.6k token，其中项目记忆索引
 * 21,936 字符、经 `@CONTRIBUTING.md` 全文内联的 21,853 字符，每一轮都带着。/context 只给出
 * 「记忆/CLAUDE.md」一个合计数，用户看不出这些固定开销**从哪来**、能不能动。
 *
 * 这里按来源逐项列出：项目记忆索引、全局记忆索引、团队记忆索引、每一个 `@` 导入文件。
 * sid-code 不替用户删减（`@` 是用户显式写的，静默不展开违背意图且与 CC 不一致），
 * 只负责让用户看见，并在单项超过窗口 2% 时说明来源与处理方法。
 *
 * ─── 取数口径（铁律：说得出源字段） ───
 *
 * - **文本取自实际发出的 system prompt**（`ctxMgr.getSystemPrompt()`），不是磁盘文件：
 *   被截断、被作用域拦下、召回模式下没注入的内容一律不算。
 * - **token 数 = 启发式 × 真实 usage 反推的校准系数**（`ContextManager.calibrationFactor`，
 *   与 /context 其它分类同一口径）。未校准时如实标注「启发式」。没有用官方 tokenizer：
 *   本基座多 provider 共用，单一厂商的 tokenizer 对其它 provider 反而引入新偏差（token.ts 头注释）。
 * - 这些来源都是「记忆/CLAUDE.md」分类的**细目**，不额外进 total，不会重复计数。
 */

import { estimateTextTokens } from "./token.ts";
import type { ImportedFileRecord } from "../config/import-processor.ts";

export interface FixedOverheadSource {
  /** 稳定键（UI 用作 React key） */
  key: string;
  /** 来源名 */
  label: string;
  /** 补充说明（如「经 CLAUDE.md:18 导入」「按需召回模式」） */
  detail?: string;
  /** 校准后 token 数 */
  tokens: number;
}

export interface FixedOverheadReport {
  sources: FixedOverheadSource[];
  /** 单项超过窗口 2% 时的提示（来源 + 处理方法） */
  hints: string[];
}

/** 单项提示阈值：占窗口比例 */
export const FIXED_OVERHEAD_HINT_RATIO = 0.02;

/** 记忆索引段标题（store.getIndexContent 生成，形如 `#### 项目记忆（目录：/abs/dir）`） */
const MEMORY_SECTION_RE = /^#### (项目记忆|全局记忆)（目录：([^）]*)）$/;
/** 团队记忆索引段标题（memory/prompt.ts 生成） */
const TEAM_SECTION_HEADER = "### 团队共享记忆索引（团队 MEMORY.md）";
/** 召回模式替身段的标志句（store.buildRecallModePointer） */
const RECALL_POINTER_MARK = "本会话改为**按需召回**";

/**
 * 从 system prompt 里切出记忆索引各段（只认我们自己生成的段标题，逐行扫描）。
 *
 * 段的结束 = 下一个 `#### ` / `### ` / `## ` 标题，或 `<system-reminder>` 等非索引块开头。
 * 索引条目行都以 `- ` 开头、摘要里的 markdown 标题已被 normalizeIndexContent 剥掉，
 * 所以不会出现「摘要里的 # 被误判成段结束」。
 */
function sliceMemorySections(
  systemPrompt: string,
): Array<{ key: string; label: string; text: string; recall: boolean }> {
  const lines = systemPrompt.split("\n");
  const out: Array<{ key: string; label: string; text: string; recall: boolean }> = [];
  let cur: { key: string; label: string; buf: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.buf.join("\n").trimEnd();
    out.push({ key: cur.key, label: cur.label, text, recall: text.includes(RECALL_POINTER_MARK) });
    cur = null;
  };
  for (const line of lines) {
    const m = line.match(MEMORY_SECTION_RE);
    if (m) {
      flush();
      const isProject = m[1] === "项目记忆";
      cur = {
        key: isProject ? "memoryIndex:project" : "memoryIndex:global",
        label: isProject ? "项目记忆索引" : "全局记忆索引",
        buf: [line],
      };
      continue;
    }
    if (line === TEAM_SECTION_HEADER) {
      flush();
      cur = { key: "memoryIndex:team", label: "团队记忆索引", buf: [line] };
      continue;
    }
    if (cur && (/^#{2,4} /.test(line) || line.startsWith("<system-reminder>"))) {
      flush();
      continue;
    }
    if (cur) cur.buf.push(line);
  }
  flush();
  return out;
}

/** 去掉一段文本里嵌套的 `@` 导入块，只留这个文件自身的内容（嵌套文件单独列一行，不重复计数） */
function stripNestedImports(text: string): string {
  return text.replace(/<!-- @import (.+?) -->\n[\s\S]*?\n<!-- end @import \1 -->/g, "");
}

/**
 * 切出某个 `@` 导入在 system prompt 里实际展开的正文（import-processor 的标记块）。
 * 找不到标记 = 这份导入没进最终提示词（被作用域拦下 / 规则被截断），返回 null，不计。
 */
function sliceImport(systemPrompt: string, importPath: string): string | null {
  const open = `<!-- @import ${importPath} -->\n`;
  const close = `\n<!-- end @import ${importPath} -->`;
  const a = systemPrompt.indexOf(open);
  if (a < 0) return null;
  const b = systemPrompt.indexOf(close, a + open.length);
  if (b < 0) return null;
  return systemPrompt.slice(a + open.length, b);
}

/** 展示用路径：项目根内的显示相对路径，其余原样 */
function displayPath(p: string, projectRoot?: string): string {
  if (projectRoot && p.startsWith(projectRoot + "/")) return p.slice(projectRoot.length + 1);
  return p;
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * 计算固定开销来源。
 *
 * @param systemPrompt       实际发送的 system prompt（`ctxMgr.getSystemPrompt()`）
 * @param importedFiles      当前生效规则的 `@` 导入清单（`ProjectRules.importedFiles`）
 * @param opts.maxTokens     窗口（2% 提示阈值的分母）
 * @param opts.calibrationFactor 真实 usage 反推的校准系数（未校准传 1）
 * @param opts.projectRoot   用于把路径显示成相对路径
 */
export function computeFixedOverheadSources(
  systemPrompt: string,
  importedFiles: readonly ImportedFileRecord[] | undefined,
  opts: { maxTokens: number; calibrationFactor: number; projectRoot?: string },
): FixedOverheadReport {
  const factor =
    Number.isFinite(opts.calibrationFactor) && opts.calibrationFactor > 0
      ? opts.calibrationFactor
      : 1;
  const tok = (text: string) => Math.round(estimateTextTokens(text) * factor);
  const sources: FixedOverheadSource[] = [];
  const hints: string[] = [];
  const threshold = opts.maxTokens > 0 ? opts.maxTokens * FIXED_OVERHEAD_HINT_RATIO : Infinity;
  const pct = (n: number) =>
    opts.maxTokens > 0 ? `${((n / opts.maxTokens) * 100).toFixed(1)}%` : "?";

  for (const s of sliceMemorySections(systemPrompt)) {
    const tokens = tok(s.text);
    sources.push({
      key: s.key,
      label: s.label,
      detail: s.recall ? "按需召回模式（索引未全量注入）" : undefined,
      tokens,
    });
    if (tokens > threshold && !s.recall) {
      hints.push(
        `${s.label}约 ${fmtK(tokens)} token（占窗口 ${pct(tokens)}），每轮都会带上。` +
          `可用 /memory 清理过时记忆；索引超过 200 条 / 25KB 上限时会自动改为按需召回。`,
      );
    }
  }

  const seen = new Set<string>();
  for (const r of importedFiles ?? []) {
    // 同一个导入标记在提示词里只能切出一次；重复登记（同文件被多层导入）只列第一处
    const dedupKey = `${r.importPath}\u0000${r.absolutePath}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const body = sliceImport(systemPrompt, r.importPath);
    if (body === null) continue;
    const tokens = tok(stripNestedImports(body));
    const from = `${displayPath(r.fromFile, opts.projectRoot)}:${r.line}`;
    const name = displayPath(r.absolutePath, opts.projectRoot);
    sources.push({
      key: `import:${r.absolutePath}`,
      label: `@${name}`,
      detail: `经 ${from} 导入`,
      tokens,
    });
    if (tokens > threshold) {
      hints.push(
        `${name} 经 ${from} 的 @ 导入全文内联，约 ${fmtK(tokens)} token（占窗口 ${pct(tokens)}），每轮都会带上。` +
          `如果多数任务用不到，可在 ${displayPath(r.fromFile, opts.projectRoot)} 里去掉这行 @ 导入，改为需要时再读。`,
      );
    }
  }

  return { sources, hints };
}
