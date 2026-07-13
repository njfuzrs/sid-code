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
  /**
   * 每个文件的**最新**诊断全量快照（uri → 诊断数组）。
   *
   * 与 pending/delivered 的"消费即清空"语义**完全独立**：pending 供 G1 每轮注入消费（collect
   * 后清空），而 latest 是只读镜像，只被 registerPending 覆盖、被 clearForFile/clear 清除，
   * 从不被 collect 消费。存在的唯一目的是给 codeAction 这类 pull 式查询提供 `context.diagnostics`——
   * 多数语言服务器在 context 无诊断时返回空 quickfix 列表，而我们不能为此去偷 pending
   * （否则 G1 注入链断掉）。LSP publishDiagnostics 语义即"该文档的全量诊断"，故每次覆盖。
   */
  private latest = new Map<string, Diagnostic[]>();

  /** 注册待投递的诊断（由 LSP 通知处理器调用） */
  registerPending(serverName: string, files: DiagnosticFile[]): void {
    const id = `${serverName}-${++this.pendingSeq}`;
    this.pending.set(id, { files, sent: false });
    // 同步刷新只读快照：publishDiagnostics 给的是该 uri 的全量诊断，直接覆盖。
    // 空数组也覆盖（表示"错误已清空"），这样 peek 到的永远是当前真实状态。
    for (const file of files) {
      this.latest.set(file.uri, file.diagnostics);
    }
  }

  /**
   * 只读快照：返回指定文件当前的全量诊断，**不消费、不清空、不影响 G1 注入链**。
   *
   * 供 codeAction 这类 pull 式查询填充 LSP `context.diagnostics`。没有对应文件的诊断时返回空数组。
   * 返回浅拷贝，防止调用方意外改动内部快照。
   */
  peekDiagnosticsForFile(uri: string): Diagnostic[] {
    const diags = this.latest.get(uri);
    return diags ? [...diags] : [];
  }

  /**
   * 检查并收集待投递的诊断。
   * 返回去重、限流后的诊断列表，调用后标记为已投递。
   *
   * @param scopeUris 可选的文件作用域过滤。
   *   - 不传（主循环行为，保持不变）：收集所有 pending 诊断，收集后清空**全部** pending。
   *   - 传入（子代理 / 并发场景）：只收集属于这些文件的诊断，且**只清空这些文件**的 pending 条目，
   *     其它文件的诊断原样保留给别的消费者。
   *
   * 作用域参数修复"全局单例 collect 串味"：registry 是进程级单例，主循环与并发子代理共用同一
   * 实例。旧的无差别 `collectDiagnostics()` 谁先调用谁就把**所有人**的 pending 捞走并清空，
   * 另一方永远看不到自己编辑引入的诊断。传 scopeUris 后各消费者只消费自己关心的文件，互不偷取。
   */
  collectDiagnostics(scopeUris?: Iterable<string>): DiagnosticFile[] {
    const scope = scopeUris ? new Set(scopeUris) : null;

    // 1. 收集未投递的诊断（有作用域时只收集作用域内文件）
    const allFiles: DiagnosticFile[] = [];
    for (const entry of this.pending.values()) {
      if (entry.sent) continue;
      for (const file of entry.files) {
        if (!scope || scope.has(file.uri)) allFiles.push(file);
      }
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

    // 6. 清空 pending。无作用域：清空全部（主循环行为不变）；有作用域：只清空作用域内文件的
    //    条目，保留其它文件的 pending 给别的消费者（并发隔离）。
    if (scope) {
      this.clearPendingForUris(scope);
    } else {
      this.pending.clear();
    }

    return limited;
  }

  /**
   * 从 pending 中移除指定文件集合的诊断条目（作用域消费后调用）。
   * 逐条目过滤 files 数组：全属于作用域内则删整条，部分属于则保留其余文件的诊断。
   * 复用与 clearForFile 一致的过滤策略。
   */
  private clearPendingForUris(uris: Set<string>): void {
    for (const [id, entry] of this.pending) {
      const remaining = entry.files.filter((f) => !uris.has(f.uri));
      if (remaining.length === 0) {
        this.pending.delete(id);
      } else if (remaining.length !== entry.files.length) {
        entry.files = remaining;
      }
    }
  }

  /** 清空所有状态（文件关闭/重置时） */
  clear(): void {
    this.pending.clear();
    this.delivered.clear();
    this.deliveredOrder = [];
    this.latest.clear();
  }

  /**
   * 清除指定文件的已投递诊断记录（文件编辑后调用）。
   *
   * 对标 Claude Code 的 clearDeliveredDiagnosticsForFile：文件被编辑后，旧诊断可能
   * 已失效（如错误已修复），但跨轮次去重缓存仍记着"这些诊断投递过"，会过滤掉服务器
   * 重新推送的同位置诊断——导致修复后的诊断永远不再出现，或反过来过时错误一直驻留。
   * 编辑后清除该文件的 delivered 记录，让下一轮的 publishDiagnostics 重新作为新诊断投递。
   *
   * 同时清除 pending 中该文件的待投递诊断（编辑前服务器基于旧内容推的诊断已无意义）。
   */
  clearForFile(uri: string): void {
    this.delivered.delete(uri);
    const idx = this.deliveredOrder.indexOf(uri);
    if (idx >= 0) this.deliveredOrder.splice(idx, 1);

    // 清除 pending 中只属于该文件的诊断条目（保留其它文件的诊断）。
    // registerPending 以 server-seq 为 key、files 为值，需逐条目过滤其 files 数组。
    for (const [id, entry] of this.pending) {
      const remaining = entry.files.filter((f) => f.uri !== uri);
      if (remaining.length === 0) {
        this.pending.delete(id);
      } else if (remaining.length !== entry.files.length) {
        entry.files = remaining;
      }
    }
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
