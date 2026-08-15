/**
 * 权限审计日志
 * JSONL 格式，支持日志轮转（10MB 上限，**只保留 1 代**历史文件）
 * 日志路径：~/.sid-code/logs/permissions-audit.log
 *
 * ── P2-12：保留代数从 10 收到 1（2026-08-14 实测）──
 *
 * 原设计是 10MB × 10 代 = 最坏 110MB，且 `rotate()` 对第 10 代只做「清空」不做删除，
 * 于是一个空的 `.10` 会永久留在盘上。实测用户盘上 `permissions-audit.log.1` 10MB、
 * `audit.log.1` 104MB（后者由 logger.ts 写），**轮转过一次之后就再没人碰过**。
 *
 * 判据是「审计日志的读者是谁」：出问题时查的是**最近**的权限决策，翻半年前的第 9 代
 * 从未发生过。保留 1 代（当前 + 上一代）足够覆盖「刚轮转完就要查上一段」这个唯一
 * 真实场景，总量上限也从 110MB 收到 20MB。
 */

import { appendFileSync, existsSync, statSync, renameSync, mkdirSync, unlinkSync } from "fs";
import { sidPaths } from "../config/paths.ts";
import type { AuditEntry } from "./types.ts";

export class AuditLogger {
  private logPath: string;
  private maxSize = 10 * 1024 * 1024; // 10MB
  /**
   * 保留代数上限（`.1` ... `.maxFiles`）。设 1 = 只留上一代。
   *
   * 总量上限 = maxSize × (maxFiles + 1) = 20MB。改这个值等于改总量上限，
   * 改之前先想清楚「谁会去读第 N 代」——找不出读者的代数就是纯占盘。
   */
  private maxFiles = 1;

  constructor(logPath?: string) {
    const logsDir = sidPaths.logs();
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    this.logPath = logPath || sidPaths.log("permissions-audit.log");
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

  /**
   * 日志轮转：保留最近 maxFiles 代，超出的**删掉**（不是清空）。
   *
   * 两处与原实现的差异，都是 P2-12 的实测教训：
   *
   * 1. 超出上限的代数用 `unlinkSync` **删除**，原来用 `Bun.write(oldest, "")` 清空 ——
   *    清空后文件仍在盘上，`ls` 里永远挂着一个 0 字节的 `.10`，且下次轮转又把它
   *    重命名成更旧的代数，形成永不回收的僵尸文件。
   * 2. 额外扫一遍 `.maxFiles+1` 起的**历史遗留代数**并删除。收紧 maxFiles（10 → 1）
   *    后，盘上早先产生的 `.2`~`.10` 不会被新逻辑的重命名循环碰到 —— 不主动清就是
   *    改了配置却回收不了空间。扫描上限设 10（原 maxFiles 值），够覆盖历史产物。
   */
  private rotate(): void {
    /** 历史遗留代数的扫描上限：原实现的 maxFiles 是 10，不会有比这更旧的代数 */
    const LEGACY_MAX_GENERATION = 10;
    try {
      // 1. 删掉超出保留上限的代数（含历史遗留的 .maxFiles+1 ... .10）
      for (let i = this.maxFiles; i <= LEGACY_MAX_GENERATION; i++) {
        const stale = `${this.logPath}.${i}`;
        if (existsSync(stale)) {
          try {
            unlinkSync(stale);
          } catch {
            /* 单个删除失败不影响其余 */
          }
        }
      }

      // 2. 依次把 .i 重命名为 .i+1（maxFiles=1 时这个循环不执行）
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const old = `${this.logPath}.${i}`;
        const next = `${this.logPath}.${i + 1}`;
        if (existsSync(old)) {
          renameSync(old, next);
        }
      }

      // 3. 当前文件变为 .1
      renameSync(this.logPath, `${this.logPath}.1`);
    } catch {
      // 轮转失败不影响主流程
    }
  }
}
