/**
 * 权限审计日志
 * JSONL 格式，支持日志轮转（10MB 上限，保留 10 个历史文件）
 * 日志路径：~/.sid-code/permissions-audit.log
 */

import { join } from "path";
import { homedir } from "os";
import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from "fs";
import type { AuditEntry } from "./types.ts";

export class AuditLogger {
  private logPath: string;
  private maxSize = 10 * 1024 * 1024; // 10MB
  private maxFiles = 10;

  constructor(logPath?: string) {
    const configDir = join(homedir(), ".sid-code");
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    this.logPath = logPath || join(configDir, "permissions-audit.log");
  }

  /** 写入审计日志条目 */
  log(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.logPath, line);

      // 检查是否需要轮转
      if (existsSync(this.logPath)) {
        const stats = statSync(this.logPath);
        if (stats.size > this.maxSize) {
          this.rotate();
        }
      }
    } catch {
      // 审计日志写入失败不应影响主流程
    }
  }

  /** 日志轮转：保留最近 maxFiles 个文件 */
  private rotate(): void {
    try {
      // 删除最旧的文件
      const oldest = `${this.logPath}.${this.maxFiles}`;
      if (existsSync(oldest)) {
        Bun.write(oldest, ""); // 清空
      }

      // 依次重命名
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const old = `${this.logPath}.${i}`;
        const next = `${this.logPath}.${i + 1}`;
        if (existsSync(old)) {
          renameSync(old, next);
        }
      }

      // 当前文件变为 .1
      renameSync(this.logPath, `${this.logPath}.1`);
    } catch {
      // 轮转失败不影响主流程
    }
  }
}
