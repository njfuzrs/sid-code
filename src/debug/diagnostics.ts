/**
 * 诊断日志（对齐 Claude Code 的 diagnostics 模式）
 *
 * 与 debug/logger.ts 的区别：
 * - logger：开发调试用，含详细上下文，可能含 PII，受 LOG_LEVEL 控制
 * - diagnostics：生产性能分析用，只记录数值/枚举指标，不含 PII，
 *   仅当 SID_CODE_DIAGNOSTICS_FILE 环境变量设置时才写入
 *
 * 设计为零开销：未设置环境变量时，logDiagnostics 直接 return，
 * 不做任何字符串拼接或 IO。
 *
 * 零依赖模块：仅依赖 node:fs 和 process.env，任何模块可安全导入。
 */

import * as fs from "node:fs";

/** 诊断日志目标文件（每次调用时读取，支持启动后才设置环境变量） */
function getDiagnosticsFile(): string | undefined {
  return process.env.SID_CODE_DIAGNOSTICS_FILE;
}

/** 诊断数据：只允许标量，杜绝意外写入对象/PII */
export type DiagnosticData = Record<string, number | string | boolean>;

/**
 * 记录一条诊断事件。环境变量未设置时为零开销 no-op
 * （仅一次 env 查找 + 布尔判断后即返回）。
 * 追加写入（非阻塞），写入失败静默忽略——诊断不应影响主流程。
 *
 * @param event 事件名（如 "api_request" / "tool_execute"）
 * @param data 标量指标
 */
export function logDiagnostics(event: string, data: DiagnosticData = {}): void {
  const diagnosticsFile = getDiagnosticsFile();
  if (!diagnosticsFile) return;

  try {
    const entry = JSON.stringify({ ts: Date.now(), event, ...data });
    fs.appendFile(diagnosticsFile, entry + "\n", () => {
      // 写入失败静默忽略
    });
  } catch {
    // JSON 序列化失败等异常静默忽略
  }
}

/** 诊断日志是否启用（供调用方决定是否计算昂贵指标） */
export function isDiagnosticsEnabled(): boolean {
  return Boolean(getDiagnosticsFile());
}
