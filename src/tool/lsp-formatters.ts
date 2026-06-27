/**
 * LSP 查询结果格式化 —— 把各操作的 LSP 协议响应转为模型可读文本。
 *
 * 对齐 Claude Code 的格式化策略：
 * - location 类（definition/references/implementation）：`file:line:col` 列表
 * - hover：markdown 文本
 * - documentSymbol：层级缩进的符号树
 * - workspaceSymbol：`name (kind) — file:line` 列表
 * - callHierarchy：调用者/被调用者列表
 *
 * 两个横切关注点：
 * - 结果截断（最多 MAX_LOCATIONS 条），防止大型项目的 references 撑爆上下文。
 * - URI → 相对工作区路径展示，比绝对 file:// URI 更易读、更省 token。
 */

import { fileURLToPath } from "url";
import { relative } from "path";
import type {
  LSPLocation,
  LSPLocationLink,
  LSPHover,
  LSPMarkupContent,
  LSPMarkedString,
  LSPDocumentSymbol,
  LSPSymbolInformation,
  LSPCallHierarchyIncomingCall,
  LSPCallHierarchyOutgoingCall,
} from "../lsp/lsp-types.ts";
import { symbolKindName } from "../lsp/lsp-types.ts";

/** 结果截断上限（对标方案风险缓解：最多 50 个 location + 摘要统计） */
export const MAX_LOCATIONS = 50;

/** file:// URI → 相对工作区路径（失败回退原值） */
export function uriToDisplayPath(uri: string, workspaceFolder: string): string {
  try {
    const abs = fileURLToPath(uri);
    const rel = relative(workspaceFolder, abs);
    // relative 给出 ../ 开头说明在工作区外，用绝对路径更清晰
    return rel && !rel.startsWith("..") ? rel : abs;
  } catch {
    return uri;
  }
}

/** 把 0-based 的 LSP position 转为 1-based 的 line:col（与用户/编辑器口径一致） */
function fmtPos(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}

/** 归一化 definition/references/implementation 的多形态返回为 Location[] */
export function normalizeLocations(
  result: unknown,
): Array<{ uri: string; line: number; character: number }> {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out: Array<{ uri: string; line: number; character: number }> = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    // Location 形状
    if ("uri" in item && "range" in item) {
      const loc = item as LSPLocation;
      out.push({
        uri: loc.uri,
        line: loc.range.start.line,
        character: loc.range.start.character,
      });
    } else if ("targetUri" in item) {
      // LocationLink 形状（linkSupport=true）
      const link = item as LSPLocationLink;
      const range = link.targetSelectionRange ?? link.targetRange;
      out.push({
        uri: link.targetUri,
        line: range.start.line,
        character: range.start.character,
      });
    }
  }
  return out;
}

/**
 * 格式化 location 列表（definition/references/implementation 共用）。
 * 截断到 MAX_LOCATIONS，超出时附摘要统计。
 */
export function formatLocations(
  result: unknown,
  workspaceFolder: string,
  emptyLabel = "未找到结果",
): string {
  const locations = normalizeLocations(result);
  if (locations.length === 0) return emptyLabel;

  const shown = locations.slice(0, MAX_LOCATIONS);
  const lines = shown.map((loc) => {
    const path = uriToDisplayPath(loc.uri, workspaceFolder);
    return `${path}:${fmtPos(loc.line, loc.character)}`;
  });

  let out = lines.join("\n");
  if (locations.length > MAX_LOCATIONS) {
    out += `\n\n（共 ${locations.length} 处，仅显示前 ${MAX_LOCATIONS} 处）`;
  }
  return out;
}

/** 把单个 MarkedString 转为文本 */
function markedStringToText(m: LSPMarkedString): string {
  if (typeof m === "string") return m;
  // { language, value } → 代码块
  return "```" + m.language + "\n" + m.value + "\n```";
}

/** 格式化 hover 结果为 markdown 文本 */
export function formatHover(result: unknown): string {
  if (!result || typeof result !== "object") return "无悬停信息";
  const hover = result as LSPHover;
  const contents = hover.contents;
  if (contents == null) return "无悬停信息";

  let text: string;
  if (Array.isArray(contents)) {
    text = contents.map(markedStringToText).join("\n\n");
  } else if (typeof contents === "object" && "kind" in contents) {
    text = (contents as LSPMarkupContent).value;
  } else {
    text = markedStringToText(contents as LSPMarkedString);
  }

  text = text.trim();
  return text.length > 0 ? text : "无悬停信息";
}

/** 判断 documentSymbol 返回的是层级 DocumentSymbol[] 还是扁平 SymbolInformation[] */
function isDocumentSymbolArray(
  arr: unknown[],
): arr is LSPDocumentSymbol[] {
  return arr.length > 0 && !!arr[0] && typeof arr[0] === "object" && "selectionRange" in (arr[0] as object);
}

/** 递归格式化层级 DocumentSymbol 树 */
function formatSymbolTree(symbols: LSPDocumentSymbol[], depth: number, out: string[]): void {
  for (const sym of symbols) {
    const indent = "  ".repeat(depth);
    const kind = symbolKindName(sym.kind);
    const loc = fmtPos(sym.selectionRange.start.line, sym.selectionRange.start.character);
    const detail = sym.detail ? ` ${sym.detail}` : "";
    out.push(`${indent}${kind} ${sym.name}${detail} (${loc})`);
    if (sym.children && sym.children.length > 0) {
      formatSymbolTree(sym.children, depth + 1, out);
    }
  }
}

/** 格式化 documentSymbol 结果（兼容层级 / 扁平两种形态） */
export function formatDocumentSymbols(result: unknown, workspaceFolder: string): string {
  if (!result || !Array.isArray(result) || result.length === 0) return "未找到符号";

  const out: string[] = [];
  if (isDocumentSymbolArray(result)) {
    formatSymbolTree(result as LSPDocumentSymbol[], 0, out);
  } else {
    // SymbolInformation[]：扁平列表
    for (const item of result as LSPSymbolInformation[]) {
      const kind = symbolKindName(item.kind);
      const path = uriToDisplayPath(item.location.uri, workspaceFolder);
      const loc = fmtPos(item.location.range.start.line, item.location.range.start.character);
      const container = item.containerName ? `${item.containerName}.` : "";
      out.push(`${kind} ${container}${item.name} (${path}:${loc})`);
    }
  }
  return out.length > 0 ? out.join("\n") : "未找到符号";
}

/** 格式化 workspaceSymbol 结果（始终是 SymbolInformation[]） */
export function formatWorkspaceSymbols(result: unknown, workspaceFolder: string): string {
  if (!result || !Array.isArray(result) || result.length === 0) return "未找到符号";

  const items = result as LSPSymbolInformation[];
  const shown = items.slice(0, MAX_LOCATIONS);
  const lines = shown.map((item) => {
    const kind = symbolKindName(item.kind);
    const path = uriToDisplayPath(item.location.uri, workspaceFolder);
    const loc = fmtPos(item.location.range.start.line, item.location.range.start.character);
    const container = item.containerName ? ` — ${item.containerName}` : "";
    return `${item.name} (${kind})${container} — ${path}:${loc}`;
  });

  let out = lines.join("\n");
  if (items.length > MAX_LOCATIONS) {
    out += `\n\n（共 ${items.length} 个符号，仅显示前 ${MAX_LOCATIONS} 个）`;
  }
  return out;
}

/** 格式化 prepareCallHierarchy 结果（CallHierarchyItem[]） */
export function formatCallHierarchyItems(result: unknown, workspaceFolder: string): string {
  if (!result || !Array.isArray(result) || result.length === 0) {
    return "此位置无可用的调用层级项（请确认光标位于函数/方法名上）";
  }
  const items = result as Array<{ name: string; kind: number; uri: string; selectionRange: { start: { line: number; character: number } } }>;
  const lines = items.map((item) => {
    const kind = symbolKindName(item.kind);
    const path = uriToDisplayPath(item.uri, workspaceFolder);
    const loc = fmtPos(item.selectionRange.start.line, item.selectionRange.start.character);
    return `${kind} ${item.name} (${path}:${loc})`;
  });
  return lines.join("\n");
}

/** 格式化 incomingCalls 结果（谁调用了目标） */
export function formatIncomingCalls(result: unknown, workspaceFolder: string): string {
  if (!result || !Array.isArray(result) || result.length === 0) return "无调用者";
  const calls = result as LSPCallHierarchyIncomingCall[];
  const shown = calls.slice(0, MAX_LOCATIONS);
  const lines = shown.map((call) => {
    const kind = symbolKindName(call.from.kind);
    const path = uriToDisplayPath(call.from.uri, workspaceFolder);
    const loc = fmtPos(call.from.selectionRange.start.line, call.from.selectionRange.start.character);
    return `← ${kind} ${call.from.name} (${path}:${loc})  [${call.fromRanges.length} 处调用]`;
  });
  let out = lines.join("\n");
  if (calls.length > MAX_LOCATIONS) {
    out += `\n\n（共 ${calls.length} 个调用者，仅显示前 ${MAX_LOCATIONS} 个）`;
  }
  return out;
}

/** 格式化 outgoingCalls 结果（目标调用了谁） */
export function formatOutgoingCalls(result: unknown, workspaceFolder: string): string {
  if (!result || !Array.isArray(result) || result.length === 0) return "无被调用项";
  const calls = result as LSPCallHierarchyOutgoingCall[];
  const shown = calls.slice(0, MAX_LOCATIONS);
  const lines = shown.map((call) => {
    const kind = symbolKindName(call.to.kind);
    const path = uriToDisplayPath(call.to.uri, workspaceFolder);
    const loc = fmtPos(call.to.selectionRange.start.line, call.to.selectionRange.start.character);
    return `→ ${kind} ${call.to.name} (${path}:${loc})  [${call.fromRanges.length} 处调用]`;
  });
  let out = lines.join("\n");
  if (calls.length > MAX_LOCATIONS) {
    out += `\n\n（共 ${calls.length} 个被调用项，仅显示前 ${MAX_LOCATIONS} 个）`;
  }
  return out;
}
