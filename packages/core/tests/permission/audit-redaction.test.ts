/**
 * 审计日志脱敏测试（B16）
 *
 * ── 背景 ──
 *
 * 审计的唯一自由文本出口是 `resource`（bash 没有 file_path，放的是**完整命令原文**，
 * 实测最长 1,909 字符）与 `reason` / `decisionReason.reason`。此前它们原样落盘：
 * 一条 `export OPENAI_API_KEY=…` 被拒或被批准，密钥就以原文进审计，留到轮转
 * （B21 之后 deny 行还会进保留日志，窗口约三个月）。
 *
 * ── 本文件锁四件事 ──
 *
 *   ① 含凭证的审计行落盘后被遮（主日志 + 保留日志）
 *   ② join / 统计依赖的字段逐字节不变（session_id / tool_use_id / decision / 数字）
 *   ③ 不含凭证的干净行逐字节不变（防止把所有历史行都改乱）
 *   ④ 降级：脱敏出错时写占位字段，不丢行、不落原文
 *
 * ── 落盘隔离 ──
 *
 * `AuditLogger` 构造器无条件 `mkdirSync(sidPaths.logs())`，所以必须重定向
 * `SID_CONFIG_DIR` 到 tmpdir，否则会往用户真实 `~/.sid-code/logs/` 里写假审计行。
 * 恢复时**存/恢复原值**而不是无条件 delete（bun test 同批多文件跑在一个进程里）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger, retainedAuditPath } from "@sid-code/core/permission/audit.ts";
import { REDACTION_FAILED_PLACEHOLDER } from "@sid-code/core/permission/sensitive.ts";
import type { AuditEntry } from "@sid-code/core/permission/types.ts";

let root: string;
let logPath: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-audit-redact-"));
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

/** 造一条字段齐全的审计条目（session_id 显式给，避免受进程状态影响） */
function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-11-11T00:00:00.000Z",
    type: "tool_use",
    tool: "Bash",
    decision: "allow",
    session_id: "20261111-000000-abcdef12",
    tool_use_id: "toolu_01abc",
    ...overrides,
  };
}

function lines(path: string): string[] {
  return readFileSync(path, "utf-8").trim().split("\n");
}

// 合成假值（不含任何真实凭证）
const OPENAI_KEY = "sk-proj-" + "a".repeat(32);
const GH_PAT = "github_pat_" + "b".repeat(49);
const PEM_BODY = "MIIEowIBAAKCAQEA" + "x".repeat(64);
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`;

describe("B16 审计行落盘前脱敏", () => {
  test("① resource 里的 OPENAI_API_KEY 赋值被遮", () => {
    const logger = new AuditLogger(logPath);
    logger.log(entry({ resource: `export OPENAI_API_KEY=${OPENAI_KEY}` }));

    const line = lines(logPath)[0]!;
    expect(line).not.toContain(OPENAI_KEY);
    expect(line).toContain("OPENAI_API_KEY"); // 键名保留，排查时看得见用了哪个 key
    expect(() => JSON.parse(line)).not.toThrow();
  });

  test("① resource 里的 GitHub fine-grained PAT 被遮（B15 补进 R2 的形态同样进审计）", () => {
    const logger = new AuditLogger(logPath);
    logger.log(entry({ resource: `git clone https://x:${GH_PAT}@github.com/o/r` }));

    const line = lines(logPath)[0]!;
    expect(line).not.toContain(GH_PAT);
  });

  test("① resource 里的 PEM 整块被遮（含 json 转义形态的换行）", () => {
    const logger = new AuditLogger(logPath);
    logger.log(entry({ resource: PEM }));

    const line = lines(logPath)[0]!;
    expect(line).not.toContain(PEM_BODY);
    expect(line).toContain("PEM");
  });

  test("① reason / decisionReason.reason 里的凭证同样被遮", () => {
    const logger = new AuditLogger(logPath);
    logger.log(
      entry({
        reason: `工具拒绝: 命令含 ${OPENAI_KEY}`,
        decisionReason: { type: "other", reason: `导出 ${OPENAI_KEY}` },
      }),
    );

    const line = lines(logPath)[0]!;
    expect(line).not.toContain(OPENAI_KEY);
  });

  test("① 保留日志同步生效：主日志与 -retained.log 都看不到完整密钥", () => {
    const logger = new AuditLogger(logPath);
    logger.log(
      entry({
        decision: "deny",
        resource: `export GITHUB_TOKEN=${GH_PAT}`,
        reason: "拒绝写凭证",
      }),
    );

    const retainedPath = retainedAuditPath(logPath);
    expect(readFileSync(logPath, "utf-8")).not.toContain(GH_PAT);
    expect(readFileSync(retainedPath, "utf-8")).not.toContain(GH_PAT);
  });

  test("② join / 统计字段逐字节不变：session_id / tool_use_id / decision / timestamp / tool", () => {
    const logger = new AuditLogger(logPath);
    const e = entry({ decision: "deny", resource: `export OPENAI_API_KEY=${OPENAI_KEY}` });
    logger.log(e);

    const parsed = JSON.parse(lines(logPath)[0]!) as AuditEntry;
    expect(parsed.session_id).toBe(e.session_id);
    expect(parsed.tool_use_id).toBe(e.tool_use_id);
    expect(parsed.decision).toBe("deny");
    expect(parsed.timestamp).toBe(e.timestamp);
    expect(parsed.tool).toBe("Bash");
    expect(parsed.type).toBe("tool_use");
  });

  test("② 数字字面量不被触碰（cost / token 计数不能因脱敏丢精度）", () => {
    const logger = new AuditLogger(logPath);
    // AuditEntry 没有 cost 字段，但审计行允许附加字段；这里验证整行扫描不碰数字
    const e = { ...entry({ resource: "a" }), cost: 0.4428123456780257, tokens: 4428123456780257 };
    logger.log(e as AuditEntry);

    const parsed = JSON.parse(lines(logPath)[0]!) as Record<string, unknown>;
    expect(parsed.cost).toBe(0.4428123456780257);
    expect(parsed.tokens).toBe(4428123456780257);
  });

  test("③ 不含凭证的干净行逐字节不变", () => {
    const logger = new AuditLogger(logPath);
    const e = entry({ resource: "a", reason: "quiet-allow" });
    logger.log(e);

    const raw = readFileSync(logPath, "utf-8");
    expect(raw).toBe(JSON.stringify(e) + "\n");
  });

  test("③ 含误伤反例的干净行不被改写（路径 / 任务名里的 sk- 片段）", () => {
    const logger = new AuditLogger(logPath);
    const e = entry({
      resource: "cd tasks/task-qemu-alpine-ssh-key-setup && ls",
      reason: "规则直接放行",
    });
    logger.log(e);

    const raw = readFileSync(logPath, "utf-8");
    expect(raw).toBe(JSON.stringify(e) + "\n");
  });
});

describe("B16 降级：脱敏失败不丢行、不落原文", () => {
  /** redactFallback 是 private，测试按行为验证（不导出内部方法） */
  const callFallback = (logger: AuditLogger, json: string): string =>
    (logger as unknown as { redactFallback: (s: string) => string }).redactFallback(json);

  test("④ 解析成功时自由文本字段换占位，枚举字段保留", () => {
    const logger = new AuditLogger(logPath);
    const out = callFallback(
      logger,
      JSON.stringify({
        timestamp: "2026-11-11T00:00:00.000Z",
        tool: "Bash",
        decision: "deny",
        resource: `export OPENAI_API_KEY=${OPENAI_KEY}`,
        reason: "含凭证",
        decisionReason: { type: "tool-denied", reason: "含凭证" },
        session_id: "s1",
        tool_use_id: "t1",
      }),
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.resource).toBe(REDACTION_FAILED_PLACEHOLDER);
    expect(parsed.reason).toBe(REDACTION_FAILED_PLACEHOLDER);
    expect((parsed.decisionReason as Record<string, unknown>).reason).toBe(
      REDACTION_FAILED_PLACEHOLDER,
    );
    expect(parsed.decision).toBe("deny");
    expect(parsed.tool).toBe("Bash");
    expect(parsed.session_id).toBe("s1");
    expect(parsed.tool_use_id).toBe("t1");
    // 绝不落原文
    expect(out).not.toContain(OPENAI_KEY);
  });

  test("④ 连解析都失败时写占位行（既不落原文，也不静默丢行）", () => {
    const logger = new AuditLogger(logPath);
    const out = callFallback(logger, `{"resource":"${OPENAI_KEY}"`);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.redaction_failed).toBe(true);
    expect(out).not.toContain(OPENAI_KEY);
  });

  test("④ 落盘路径上的降级不会把整行吞掉：写盘后仍有一行可读 JSON", () => {
    const logger = new AuditLogger(logPath);
    logger.log(entry({ resource: `export OPENAI_API_KEY=${OPENAI_KEY}` }));
    const all = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(all.length).toBe(1);
    expect(() => JSON.parse(all[0]!)).not.toThrow();
  });
});
