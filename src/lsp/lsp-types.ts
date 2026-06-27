/**
 * LSP 查询结果的协议类型（textDocument/definition、references、hover 等的响应形状）。
 *
 * 仅覆盖 LSP 查询工具用到的子集。与 types.ts（诊断/配置类型）分离，避免后者膨胀。
 * 字段定义参照 LSP 3.17 规范：https://microsoft.github.io/language-server-protocol/
 */

/** 位置：0-based 行/列 */
export interface LSPPosition {
  line: number;
  character: number;
}

/** 范围 */
export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

/** 位置（textDocument/definition、references 等返回） */
export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

/**
 * LocationLink（linkSupport=true 时 definition/implementation 可能返回此形状）。
 * 与 Location 的区别：用 targetUri/targetRange 而非 uri/range。
 */
export interface LSPLocationLink {
  targetUri: string;
  targetRange: LSPRange;
  targetSelectionRange?: LSPRange;
  originSelectionRange?: LSPRange;
}

/** Hover 响应 */
export interface LSPHover {
  contents: LSPMarkupContent | LSPMarkedString | LSPMarkedString[];
  range?: LSPRange;
}

export interface LSPMarkupContent {
  kind: "markdown" | "plaintext";
  value: string;
}

/** 旧式 MarkedString：string 或 { language, value } */
export type LSPMarkedString = string | { language: string; value: string };

/**
 * DocumentSymbol（hierarchicalDocumentSymbolSupport=true 时返回，含 children 树）。
 */
export interface LSPDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: LSPDocumentSymbol[];
}

/**
 * SymbolInformation（旧式扁平符号，documentSymbol / workspaceSymbol 可能返回）。
 */
export interface LSPSymbolInformation {
  name: string;
  kind: number;
  location: LSPLocation;
  containerName?: string;
}

/** CallHierarchyItem（prepareCallHierarchy 返回） */
export interface LSPCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LSPRange;
  selectionRange: LSPRange;
  detail?: string;
}

/** CallHierarchyIncomingCall（callHierarchy/incomingCalls 返回） */
export interface LSPCallHierarchyIncomingCall {
  from: LSPCallHierarchyItem;
  fromRanges: LSPRange[];
}

/** CallHierarchyOutgoingCall（callHierarchy/outgoingCalls 返回） */
export interface LSPCallHierarchyOutgoingCall {
  to: LSPCallHierarchyItem;
  fromRanges: LSPRange[];
}

/**
 * LSP SymbolKind 数字 → 名称映射（LSP 3.17 规范定义的 1-26）。
 * 用于格式化 documentSymbol / workspaceSymbol 结果，让模型看到 "Function" 而非 "12"。
 */
export const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/** 取 SymbolKind 名称，未知码回退数字 */
export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? `Kind${kind}`;
}
