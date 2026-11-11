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
 *
 * ── B21：拒绝与人工终局另存一份（2026-11-08）──
 *
 * 主日志 98.4% 是 allow（本机两代 34,387 行 / 12.3MB 里 deny 469 行），按体积轮转时
 * 大量 allow 噪声把旧 deny 一起挤出去：两代合计只覆盖约 11.5 天。而回头查的恰恰是
 * deny 与人工确认。所以每条 `decision=deny` 或带 `confirm_source` 的行**再追加**一份到
 * `permissions-audit-retained.log`（5MB × 1 代，最坏 10MB）。按本机 deny 约 58KB/天，
 * 一代能装约三个月。主日志的格式、路径、轮转都不变，既有读取脚本不受影响。
 *
 * ── B19：会话键 ──
 *
 * 每行写入时盖上本进程会话 id（`session_id`）。调用点不必各自记得传：审计调用点有十几个，
 * 逐个补等于下一个新分支一定漏。
 *
 * ── B16：落盘前脱敏（2026-11-11）──
 *
 * 审计的唯一自由文本出口是 `resource`（bash 没有 file_path，放的是**完整命令原文**，
 * 实测最长 1,909 字符）与 `reason` / `decisionReason.reason`。此前它们原样落盘：
 * 一条 `export OPENAI_API_KEY=…` 被拒或被批准，密钥就以原文进审计，留到轮转
 * （B21 之后 deny 行还会进保留日志，窗口约三个月）。
 *
 * 落点选在 `log()` 入口而不是各调用点，理由与 B19 同源：调用点有十几个，逐个补必漏。
 * 主日志与保留日志复用同一个 `line` 变量，入口一处收口两处同时生效。
 */

import { appendFileSync, existsSync, statSync, renameSync, mkdirSync, unlinkSync } from "fs";
import { sidPaths } from "../config/paths.ts";
import { getSessionId } from "../bootstrap/state.ts";
import { maskSensitiveJson, REDACTION_FAILED_PLACEHOLDER } from "./sensitive.ts";
import type { AuditEntry } from "./types.ts";

/** B21：这条审计行是否进保留日志——拒绝，或确认弹窗的终局（含人工批准） */
export function isRetainedAuditEntry(entry: AuditEntry): boolean {
  if (entry.source === "policy-probe") return false;
  return entry.decision === "deny" || entry.confirm_source !== undefined;
}

/** 保留日志路径：与主日志同目录，`x.log` → `x-retained.log` */
export function retainedAuditPath(logPath: string): string {
  return logPath.endsWith(".log") ? `${logPath.slice(0, -4)}-retained.log` : `${logPath}-retained`;
}

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
  /** B21 保留日志：只存 deny 与确认终局，量小，5MB 一代约够三个月 */
  private retainedPath: string;
  private retainedMaxSize = 5 * 1024 * 1024;

  constructor(logPath?: string) {
    const logsDir = sidPaths.logs();
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    this.logPath = logPath || sidPaths.log("permissions-audit.log");
    this.retainedPath = retainedAuditPath(this.logPath);
  }

  /** 写入审计日志条目 */
  log(entry: AuditEntry): void {
    try {
      // B19：会话键在写入口统一盖章；调用方显式给了就不覆盖
      let sessionId: string | undefined;
      try {
        sessionId = getSessionId() || undefined;
      } catch {
        sessionId = undefined;
      }
      const stamped: AuditEntry =
        entry.session_id || !sessionId ? entry : { ...entry, session_id: sessionId };
      // B16：落盘前脱敏。主日志与保留日志复用同一个 line 变量 —— 落点选在入口，
      // 主日志与 -retained.log 一次收口，不需要第二处改动。
      const line = this.redactLine(JSON.stringify(stamped)) + "\n";
      appendFileSync(this.logPath, line);
      this.rotateIfNeeded(this.logPath, this.maxSize);

      if (isRetainedAuditEntry(stamped)) {
        appendFileSync(this.retainedPath, line);
        this.rotateIfNeeded(this.retainedPath, this.retainedMaxSize);
      }
    } catch (err) {
      // 审计日志写入失败不应影响主流程，但**不能静默** ——
      // 静默的失败形态是「某类命令的审计行凭空消失」，比报错更难归因。
      // 脱敏异常不会落到这里：redactLine 自带降级（见该方法），本 catch 只管真正的 IO 失败。
      console.warn(`[audit] 审计日志写入失败: ${String(err)}`);
    }
  }

  /**
   * B16：审计行落盘前脱敏。整行词法扫描，只改字符串字面量，数字与结构不动。
   *
   * 为什么是整行 `maskSensitiveJson` 而不是逐字段 `maskSensitiveData`：
   *   - 逐字段要维护字段清单（`resource` / `reason` / `decisionReason.reason` …），
   *     **下一个新增自由文本字段一定漏** —— 这正是本文件开头记的 B19 教训
   *     （审计调用点有十几个，逐个补必漏）。
   *   - 整行扫描自动覆盖所有字符串字面量，且**数字绝不触碰**（`maskSensitiveJson`
   *     走词法扫描而非 parse→stringify，成本 / token 计数不会被 IEEE754 改写）。
   *
   * 为什么不用 `maskJsonSafe`：它依赖 `getLogger()` 告警（`trace/writer.ts`），
   * 而 `logger.ts` 已 import `sensitive.ts` → 直接搬会造成循环依赖。审计侧的降级自带。
   */
  private redactLine(json: string): string {
    try {
      // 字段级 fail-closed：某个字段脱敏出错时只把该字段换成占位，其余照常落盘
      const masked = maskSensitiveJson(json, 0, () => {});
      // 自校验：脱敏产物必须仍是合法 JSON。词法扫描理论上保证这一点，
      // 但审计行一旦损坏，读者侧（policy-trigger-rate / harbor 脚本）会整行丢弃 —— 宁可多校验一次。
      JSON.parse(masked);
      return masked;
    } catch {
      return this.redactFallback(json);
    }
  }

  /**
   * 整行脱敏失败时的兜底：手工构造只含枚举字段的行，自由文本字段全部换占位。
   *
   * 审计与 trace 的可用性要求不同：trace 丢一条会话还能重跑，**审计丢一行就是
   * 「这次决策没发生过」**。所以这里既不落原文，也不丢行：
   *   - `resource` / `reason` / `decisionReason.reason` → 占位
   *   - `tool` / `decision` / `session_id` / `tool_use_id` / `timestamp` 等
   *     枚举字段原样保留（不含自由文本，且是 join 与统计的键）
   */
  private redactFallback(json: string): string {
    try {
      const o = JSON.parse(json) as Record<string, unknown>;
      for (const k of ["resource", "reason"]) {
        if (typeof o[k] === "string") o[k] = REDACTION_FAILED_PLACEHOLDER;
      }
      if (o.decisionReason && typeof o.decisionReason === "object") {
        (o.decisionReason as Record<string, unknown>).reason = REDACTION_FAILED_PLACEHOLDER;
      }
      return JSON.stringify(o);
    } catch {
      // 连解析都失败（理论上只有 JSON.stringify 产出非法文本才会走到）→ 写占位行。
      // 绝不落原文，也绝不静默丢行。
      return JSON.stringify({ redaction_failed: true, ts: new Date().toISOString() });
    }
  }

  private rotateIfNeeded(path: string, limit: number): void {
    if (existsSync(path) && statSync(path).size > limit) {
      this.rotate(path);
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
  private rotate(logPath: string = this.logPath): void {
    /** 历史遗留代数的扫描上限：原实现的 maxFiles 是 10，不会有比这更旧的代数 */
    const LEGACY_MAX_GENERATION = 10;
    try {
      // 1. 删掉超出保留上限的代数（含历史遗留的 .maxFiles+1 ... .10）
      for (let i = this.maxFiles; i <= LEGACY_MAX_GENERATION; i++) {
        const stale = `${logPath}.${i}`;
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
        const old = `${logPath}.${i}`;
        const next = `${logPath}.${i + 1}`;
        if (existsSync(old)) {
          renameSync(old, next);
        }
      }

      // 3. 当前文件变为 .1
      renameSync(logPath, `${logPath}.1`);
    } catch {
      // 轮转失败不影响主流程
    }
  }
}
