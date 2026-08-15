/**
 * 审计日志轮转保留代数上限测试 — P2-12
 *
 * 背景（2026-08-14 实测用户盘上）：`audit.log.1` 104MB、`permissions-audit.log.1` 10MB，
 * **轮转过一次之后就再没人碰过**。原实现是 10MB × 10 代（最坏 110MB），且第 10 代
 * 只被"清空"不被删除 → 一个 0 字节的僵尸文件永久留在盘上。
 *
 * 现在收到「保留 1 代 + 总量上限 20MB」。本测试锁三件事：
 *   1. 轮转不累积代数（有 `.1` 时不会长出 `.2`）
 *   2. 历史遗留的 `.2`~`.10`（收紧配置之前产生的）会被主动回收
 *   3. **反向验证：`audit.log` 本体仍在正常追加** —— 防"为了清理把采集也关了"
 *
 * ⚠ 落盘隔离：`AuditLogger` 构造器无条件 `mkdirSync(sidPaths.logs())`，所以即使显式
 * 传 logPath 也必须重定向 `SID_CONFIG_DIR`，否则会往用户真实 `~/.sid-code/logs/` 里写。
 * 恢复时**存/恢复原值**而不是无条件 delete —— bun test 同批多文件跑在一个进程里，
 * 直接删会把 preload 的兜底一起抹掉（见 CONTRIBUTING.md 测试约定）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "@sid-code/core/permission/audit.ts";
import type { AuditEntry } from "@sid-code/core/permission/types.ts";

let root: string;
let logPath: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-audit-rotate-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = root;
  logPath = join(root, "logs", "permissions-audit.log");
});

afterEach(() => {
  // 存/恢复原值，不无条件 delete（否则抹掉 preload 兜底）
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (root) rmSync(root, { recursive: true, force: true });
});

function entry(tool: string): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    type: "tool_use",
    tool,
    decision: "allow",
  };
}

/**
 * 造一个 maxSize 很小的 logger，让轮转在几条日志内就触发。
 * 不这么做就得真写 10MB —— 测的是轮转的**代数策略**，不是阈值本身。
 */
function makeLogger(maxSizeBytes: number): AuditLogger {
  const logger = new AuditLogger(logPath);
  (logger as unknown as { maxSize: number }).maxSize = maxSizeBytes;
  return logger;
}

describe("P2-12 轮转保留代数上限", () => {
  test("反复轮转不累积代数：只有 .1，永远长不出 .2", () => {
    const logger = makeLogger(200);
    // 每条约 100 字节，写 40 条足够触发多次轮转
    for (let i = 0; i < 40; i++) logger.log(entry(`tool-${i}`));

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(false);
    expect(existsSync(`${logPath}.3`)).toBe(false);
  });

  test("历史遗留的 .2~.10 在下次轮转时被回收（收紧配置后能真正省出空间）", () => {
    // 先让构造器把 logs/ 目录建出来，再铺"收紧 maxFiles 之前"盘上已有的旧代数
    const logger = makeLogger(200);
    logger.log(entry("bootstrap"));
    for (let i = 1; i <= 10; i++) writeFileSync(`${logPath}.${i}`, "旧代数内容\n");

    // 触发一次轮转
    for (let i = 0; i < 40; i++) logger.log(entry(`tool-${i}`));

    expect(existsSync(`${logPath}.1`)).toBe(true); // 当代备份仍在
    for (let i = 2; i <= 10; i++) {
      expect(existsSync(`${logPath}.${i}`)).toBe(false); // 旧代数全部回收
    }
  });

  test("超出上限的代数是被删除而非清空（不留 0 字节僵尸文件）", () => {
    const logger = makeLogger(200);
    logger.log(entry("bootstrap"));
    writeFileSync(`${logPath}.1`, "上一代\n");
    writeFileSync(`${logPath}.2`, "上上一代\n");

    for (let i = 0; i < 40; i++) logger.log(entry(`tool-${i}`));

    // .2 必须彻底不存在，而不是存在但 size=0
    expect(existsSync(`${logPath}.2`)).toBe(false);
  });

  test("总量上限：当代 + 1 代备份，两个文件都不超过 maxSize 的量级", () => {
    const maxSize = 2000;
    const logger = makeLogger(maxSize);
    for (let i = 0; i < 100; i++) logger.log(entry(`tool-${i}`));

    const currentSize = statSync(logPath).size;
    const backupSize = statSync(`${logPath}.1`).size;
    // 轮转是"写完再检查"，所以单文件可能略微超出一条日志的量；
    // 关键是量级受控，而不是像原来那样无上限累积到 104MB。
    expect(currentSize).toBeLessThan(maxSize * 2);
    expect(backupSize).toBeLessThan(maxSize * 2);
  });
});

describe("反向验证：采集本体没被清理逻辑关掉", () => {
  test("audit.log 本体仍在正常追加（行数随写入增长）", () => {
    // 用默认 10MB 阈值，确保整个过程不发生轮转 —— 单纯验证追加行为
    const logger = new AuditLogger(logPath);

    logger.log(entry("first"));
    const linesAfter1 = readFileSync(logPath, "utf-8").trim().split("\n").length;

    for (let i = 0; i < 5; i++) logger.log(entry(`more-${i}`));
    const linesAfter6 = readFileSync(logPath, "utf-8").trim().split("\n").length;

    expect(linesAfter1).toBe(1);
    expect(linesAfter6).toBe(6);
    // 内容真的是 JSONL，且能解析回来（不是只长了字节数）
    const last = JSON.parse(readFileSync(logPath, "utf-8").trim().split("\n")[5]);
    expect(last.tool).toBe("more-4");
  });

  test("轮转之后新写入继续落进本体，不丢条目", () => {
    const logger = makeLogger(200);
    for (let i = 0; i < 40; i++) logger.log(entry(`tool-${i}`));

    // 轮转发生过（.1 存在），本体也还在被写
    expect(existsSync(`${logPath}.1`)).toBe(true);
    const before = readFileSync(logPath, "utf-8").trim().split("\n").length;
    logger.log(entry("after-rotate"));
    const after = readFileSync(logPath, "utf-8").trim().split("\n").length;
    expect(after).toBe(before + 1);
    expect(readFileSync(logPath, "utf-8")).toContain("after-rotate");
  });
});
