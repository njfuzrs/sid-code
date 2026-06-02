/**
 * 诊断去重与限流注册表
 *
 * 对标 Claude Code 的 LSPDiagnosticRegistry，两层去重策略：
 * 1. 批内去重：同一批次中的重复诊断只保留一个
 * 2. 跨轮次去重：LRU 缓存记录已投递的诊断，避免重复
 *
 * 体积限制：
 * - 每个文件最多 10 条诊断
 * - 总计最多 30 条诊断
 * - 按严重程度排序（Error > Warning > Info > Hint）
 */

import type { Diagnostic, DiagnosticFile, DiagnosticSeverity } from "./types.ts";

/** 限流常量（对标 Claude Code） */
const MAX_DIAGNOSTICS_PER_FILE = 10;
const MAX_TOTAL_DIAGNOSTICS = 30;
const MAX_DELIVERED_FILES = 500; // LRU 缓存上限

/** 严重程度排序权重（数字越小越靠前） */
const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  Error: 0,
  Warning: 1,
  Info: 2,
  Hint: 3,
};

export class DiagnosticRegistry {
  /** 待投递的诊断 */
  private pending = new Map<string, { files: DiagnosticFile[]; sent: boolean }>();
  /** 已投递的诊断（LRU 缓存，防止无限增长） */
  private delivered = new Map<string, Set<string>>();
  private deliveredOrder: string[] = [];
  /** 单调递增 id（不依赖 Date.now，避免同毫秒碰撞） */
  private pendingSeq = 0;

  /** 注册待投递的诊断（由 LSP 通知处理器调用） */
  registerPending(serverName: string, files: DiagnosticFile[]): void {
    const id = `${serverName}-${++this.pendingSeq}`;
    this.pending.set(id, { files, sent: false });
  }

  /**
   * 检查并收集待投递的诊断。
   * 返回去重、限流后的诊断列表，调用后标记为已投递。
   */
  collectDiagnostics(): DiagnosticFile[] {
    // 1. 收集所有未投递的诊断
    const allFiles: DiagnosticFile[] = [];
    for (const entry of this.pending.values()) {
      if (!entry.sent) allFiles.push(...entry.files);
    }
    if (allFiles.length === 0) return [];

    // 2. 批内去重
    const dedupedFiles = this.deduplicateWithinBatch(allFiles);

    // 3. 跨轮次去重
    const newFiles = this.deduplicateAcrossRounds(dedupedFiles);

    // 4. 严重程度排序 + 体积限制
    const limited = this.applyLimits(newFiles);

    // 5. 记录已投递
    for (const file of limited) {
      this.markDelivered(file);
    }

    // 6. 清空 pending（已处理）
    this.pending.clear();

    return limited;
  }

  /** 清空所有状态（文件关闭/重置时） */
  clear(): void {
    this.pending.clear();
    this.delivered.clear();
    this.deliveredOrder = [];
  }

  // ─── 内部方法 ───

  /** 批内去重：合并同 uri 文件，去除重复诊断 */
  private deduplicateWithinBatch(files: DiagnosticFile[]): DiagnosticFile[] {
    const byUri = new Map<string, Map<string, Diagnostic>>();
    for (const file of files) {
      let diagMap = byUri.get(file.uri);
      if (!diagMap) {
        diagMap = new Map();
        byUri.set(file.uri, diagMap);
      }
      for (const diag of file.diagnostics) {
        diagMap.set(this.diagnosticKey(diag), diag);
      }
    }
    return Array.from(byUri.entries()).map(([uri, diagMap]) => ({
      uri,
      diagnostics: Array.from(diagMap.values()),
    }));
  }

  /** 跨轮次去重：过滤掉已投递过的诊断 */
  private deduplicateAcrossRounds(files: DiagnosticFile[]): DiagnosticFile[] {
    const result: DiagnosticFile[] = [];
    for (const file of files) {
      const deliveredKeys = this.delivered.get(file.uri);
      const newDiagnostics = file.diagnostics.filter(
        (diag) => !deliveredKeys?.has(this.diagnosticKey(diag)),
      );
      if (newDiagnostics.length > 0) {
        result.push({ uri: file.uri, diagnostics: newDiagnostics });
      }
    }
    return result;
  }

  /** 严重程度排序 + 体积限制 */
  private applyLimits(files: DiagnosticFile[]): DiagnosticFile[] {
    let totalCount = 0;
    const result: DiagnosticFile[] = [];

    for (const file of files) {
      if (totalCount >= MAX_TOTAL_DIAGNOSTICS) break;

      // 按严重程度排序
      const sorted = [...file.diagnostics].sort(
        (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
      );

      // 每文件限制 + 总数限制
      const remaining = MAX_TOTAL_DIAGNOSTICS - totalCount;
      const limited = sorted.slice(0, Math.min(MAX_DIAGNOSTICS_PER_FILE, remaining));

      if (limited.length > 0) {
        result.push({ uri: file.uri, diagnostics: limited });
        totalCount += limited.length;
      }
    }

    return result;
  }

  /** 记录已投递的诊断（LRU） */
  private markDelivered(file: DiagnosticFile): void {
    let keys = this.delivered.get(file.uri);
    if (!keys) {
      keys = new Set();
      this.delivered.set(file.uri, keys);
      this.deliveredOrder.push(file.uri);
    }
    for (const diag of file.diagnostics) {
      keys.add(this.diagnosticKey(diag));
    }
    // LRU 淘汰
    while (this.deliveredOrder.length > MAX_DELIVERED_FILES) {
      const evicted = this.deliveredOrder.shift()!;
      this.delivered.delete(evicted);
    }
  }

  private diagnosticKey(diag: Diagnostic): string {
    return JSON.stringify({
      message: diag.message,
      severity: diag.severity,
      range: diag.range,
      source: diag.source ?? null,
      code: diag.code ?? null,
    });
  }
}
