/**
 * Logger 落盘级别门控测试（配置生效性）
 *
 * 背景：`options.level` 原先只门控控制台，`writeToFile` 无条件调用（注释自称
 * 「文件始终写入所有级别」）。审计模式（cli.ts:995, level=WARN）复用同一落盘路径，
 * 导致 level 形同虚设——实测真实 audit.log 中 DEBUG 占 90.7%、INFO 占 8.1%，
 * 应落盘 1.2MB 实际 104MB（写放大 87 倍）。
 *
 * 这类「配置字段被声明、被注释承诺，但某条路径上没生效」的缺陷静态 review 极难发现，
 * 故补此测试：给每个关键选项一个**能观测的断言**。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { initLogger, LogLevel } from "@sid-code/core/debug/logger.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "logger-level-gate-"));
  tmpDirs.push(d);
  return d;
}

/** 等待 WriteStream 异步落盘 */
async function flushed(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
}

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("Logger 落盘级别门控", () => {
  test("审计模式（level=WARN）不把 INFO/DEBUG 写进文件", async () => {
    const logFile = join(makeTmpDir(), "audit.log");

    // 完整复制 cli.ts:995-1002 的零配置审计模式配置
    const lg = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile,
      console: false,
      fileOnly: true,
      append: true,
    });

    lg.error("T", "此条 ERROR 应落盘");
    lg.warn("T", "此条 WARN 应落盘");
    lg.info("T", "此条 INFO 不应落盘");
    lg.debug("T", "此条 DEBUG 不应落盘");
    await flushed();

    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("此条 ERROR 应落盘");
    expect(content).toContain("此条 WARN 应落盘");
    // 核心断言：level=WARN 时 INFO/DEBUG 必须被挡在文件外
    expect(content).not.toContain("此条 INFO 不应落盘");
    expect(content).not.toContain("此条 DEBUG 不应落盘");
  });

  // 回归：级别门控初版把 AUDIT:* 一并掐掉，audit.log 恰好丢掉了它存在的唯一理由
  // （§3.4 审计轨迹 AUDIT:MODEL / AUDIT:TOOL 是 INFO 级）。
  // 由 tests/trace/collector.test.ts §3.4 的两条测试暴露：门控与审计轨迹是两个
  // 相互冲突的契约，此处把「豁免」这一侧固化，防止再次被"优化"掉。
  test("审计模式下 AUDIT:* 豁免级别门控（INFO 级也必须落盘）", async () => {
    const logFile = join(makeTmpDir(), "audit.log");

    const lg = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile,
      console: false,
      fileOnly: true,
      append: true,
    });

    lg.info("AUDIT:MODEL", "→ BeforeModel index=1 必须落盘");
    lg.info("AUDIT:TOOL", "✓ bash id=toolu_ok 必须落盘");
    lg.info("AUDIT", "裸 AUDIT 分类也豁免");
    // 非豁免分类在同一配置下仍被挡住 —— 证明豁免是按分类而非放开整个 INFO 级
    lg.info("T", "普通 INFO 仍不应落盘");
    await flushed();

    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("→ BeforeModel index=1 必须落盘");
    expect(content).toContain("✓ bash id=toolu_ok 必须落盘");
    expect(content).toContain("裸 AUDIT 分类也豁免");
    expect(content).not.toContain("普通 INFO 仍不应落盘");
  });

  // 豁免不得凌驾于 mutedCategories 之上（静默是用户显式意图，优先级更高）
  test("AUDIT:* 豁免仍尊重 mutedCategories", async () => {
    const logFile = join(makeTmpDir(), "audit-muted.log");

    const lg = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile,
      console: false,
      fileOnly: true,
      append: true,
      mutedCategories: ["AUDIT:TOOL"],
    });

    lg.info("AUDIT:TOOL", "被静默的审计条目");
    lg.info("AUDIT:MODEL", "未静默的审计条目");
    await flushed();

    const content = readFileSync(logFile, "utf8");
    expect(content).not.toContain("被静默的审计条目");
    expect(content).toContain("未静默的审计条目");
  });

  test("默认 --debug（level=DEBUG）落盘行为不变，全级别保留", async () => {
    const logFile = join(makeTmpDir(), "debug.log");

    // config.ts:749 的默认 debugLevel="DEBUG" → cli.ts:976 的 --debug 模式
    const lg = initLogger({
      enabled: true,
      level: LogLevel.DEBUG,
      logFile,
      console: false,
      fileOnly: true,
    });

    lg.error("T", "D-ERROR");
    lg.warn("T", "D-WARN");
    lg.info("T", "D-INFO");
    lg.debug("T", "D-DEBUG");
    await flushed();

    // 门控在默认值下是恒等变换——--debug 用户不丢任何现场
    const content = readFileSync(logFile, "utf8");
    for (const m of ["D-ERROR", "D-WARN", "D-INFO", "D-DEBUG"]) {
      expect(content).toContain(m);
    }
  });

  test("--debug-level INFO 过滤 DEBUG（该 flag 首次真正生效）", async () => {
    const logFile = join(makeTmpDir(), "debug-info.log");
    const lg = initLogger({
      enabled: true,
      level: LogLevel.INFO,
      logFile,
      console: false,
      fileOnly: true,
    });

    lg.info("T", "I-INFO 应保留");
    lg.debug("T", "I-DEBUG 应过滤");
    await flushed();

    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("I-INFO 应保留");
    expect(content).not.toContain("I-DEBUG 应过滤");
  });

  test("级别门控不影响 per-session warn.log 落盘", async () => {
    const dir = makeTmpDir();
    const logFile = join(dir, "audit.log");
    const warnLog = join(dir, "warn.log");

    const lg = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile,
      console: false,
      fileOnly: true,
      append: true,
    });
    lg.setSessionWarnLogPath(warnLog);

    lg.warn("T", "warn-log-必须收到");
    lg.error("T", "error-log-必须收到");
    await flushed();

    // warn.log 与主文件是独立 sink（logger.ts:287-299），门控不得连带阻断
    const content = readFileSync(warnLog, "utf8");
    expect(content).toContain("warn-log-必须收到");
    expect(content).toContain("error-log-必须收到");
  });
});

describe("Logger append 模式轮转", () => {
  test("append 模式下已超阈值的既有文件会被轮转", async () => {
    const dir = makeTmpDir();
    const logFile = join(dir, "audit.log");

    // 预置一个超过 10MB 阈值的既有文件（模拟跨会话累积）
    writeFileSync(logFile, "x".repeat(11 * 1024 * 1024) + "\n");
    expect(statSync(logFile).size).toBeGreaterThan(10 * 1024 * 1024);

    const lg = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile,
      console: false,
      fileOnly: true,
      append: true,
    });

    // 写一条 WARN 即应触发轮转：currentLogSize 必须 seed 现有文件大小，
    // 否则每次启动都从 header 字节数重新计数，阈值永远撞不到
    lg.warn("T", "触发轮转");
    await flushed();

    expect(existsSync(logFile + ".1")).toBe(true);
    // 轮转后当前文件应远小于阈值
    expect(statSync(logFile).size).toBeLessThan(1024 * 1024);
  });
});
