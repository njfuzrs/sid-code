/**
 * 被动反馈 — 将 LSP 诊断转换为 Claude 可消费的附件
 *
 * 对标 Claude Code 的 passiveFeedback：
 * - 注册 publishDiagnostics 通知处理器
 * - 转换 LSP 严重度为 Claude 格式
 * - 错误隔离：单个服务器的处理器失败不影响其他服务器
 */

import type { LSPServerManager } from "./server-manager.ts";
import type { DiagnosticRegistry } from "./diagnostic-registry.ts";
import type { Diagnostic, DiagnosticSeverity } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** LSP 数字严重度 → Claude 字符串严重度 */
const LSP_SEVERITY_MAP: Record<number, DiagnosticSeverity> = {
  1: "Error",
  2: "Warning",
  3: "Info",
  4: "Hint",
};

/** 为所有 LSP 服务器注册 publishDiagnostics 通知处理器 */
export function registerLSPNotificationHandlers(
  manager: LSPServerManager,
  registry: DiagnosticRegistry,
): { successCount: number; errors: string[] } {
  const log = getLogger();
  const servers = manager.getAllServers();
  let successCount = 0;
  const errors: string[] = [];

  for (const [serverName, instance] of servers) {
    try {
      instance.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
        try {
          const p = params as { uri: string; diagnostics: any[] };
          if (!p?.uri || !Array.isArray(p.diagnostics)) return;

          const diagnostics: Diagnostic[] = p.diagnostics.map((d) => ({
            message: String(d.message ?? ""),
            severity: LSP_SEVERITY_MAP[d.severity] ?? "Info",
            range: d.range ?? {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            source: d.source,
            code: d.code,
          }));

          registry.registerPending(serverName, [{ uri: p.uri, diagnostics }]);
        } catch (err: any) {
          log.error("LSP", `[${serverName}] 处理诊断通知失败: ${err.message}`);
        }
      });
      successCount++;
    } catch (err: any) {
      errors.push(`${serverName}: ${err.message}`);
    }
  }

  return { successCount, errors };
}

/**
 * 将诊断文件列表格式化为人类可读文本（注入系统提示词）。
 */
export function formatDiagnostics(
  files: Array<{ uri: string; diagnostics: Diagnostic[] }>,
): string {
  const lines: string[] = [];
  for (const file of files) {
    // file:// URI → 相对路径展示
    let displayPath = file.uri;
    try {
      const { fileURLToPath } = require("url");
      displayPath = fileURLToPath(file.uri);
    } catch { /* 保持原样 */ }

    lines.push(`## ${displayPath}`);
    for (const diag of file.diagnostics) {
      const loc = `${diag.range.start.line + 1}:${diag.range.start.character + 1}`;
      const src = diag.source ? ` [${diag.source}]` : "";
      // code（如 TS2304 / no-unused-vars）在采集阶段已保留，此处一并输出，
      // 帮助模型判断错误类别、按错误码检索文档。缺省时不输出。
      const code = diag.code != null && diag.code !== "" ? ` ${diag.code}` : "";
      lines.push(`  ${diag.severity} (${loc})${src}${code}: ${diag.message}`);
    }
  }
  return lines.join("\n");
}
