/**
 * 「任何档位都绕不过的东西」契约表（04 权限决策横向剖析 5.7 第 1 条 / 5.9 第 3 条）。
 *
 * 这份清单原先散在 checker.ts 各 Step 的注释里。这里把它写成一张表：
 * 行 = 一类保护，列 = 最宽松的几个档位，格子 = 该档下这次调用**不得被自动放行**。
 * 新增一个放宽类决策源（模式、hook、分类器）时，先在这里加一列，表里任何一格变绿都是绕过。
 *
 * skip 档单独一列：它只尊重「用户写下的拒绝」（选项 B），系统认定的危险照常跳过，
 * 这里把这条边界也钉住，防止它滑向「全部生效」或滑回「全部跳过」。
 *
 * ⚠ 落盘隔离与工作区 realpath：同 pipeline-order-matrix.test.ts。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { PermissionRule, PermissionRequest } from "@sid-code/core/permission/types.ts";

let configRoot: string;
let ws: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-immune-cfg-"));
  ws = realpathSync(mkdtempSync(join(tmpdir(), "sid-immune-ws-")));
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

const rules = (r: Partial<PermissionRule>): PermissionRule => ({
  allow: [],
  deny: [],
  ask: [],
  ...r,
});

/** 会自动放行普通调用的档位（不含 skip，skip 见下方单独一组） */
const PERMISSIVE: Array<[string, Record<string, unknown>]> = [
  ["always-allow", { permissionMode: "always-allow" }],
  ["acceptEdits", { permissionMode: "acceptEdits" }],
  ["yesMode", { yesMode: true }],
  ["always-allow + 无头", { permissionMode: "always-allow", nonInteractive: true }],
];

interface Row {
  name: string;
  /** 这一行保护属于谁：user = 用户写下的拒绝（skip 下也生效），system = 系统认定的危险 */
  owner: "user" | "system";
  config?: Record<string, unknown>;
  rules?: Partial<PermissionRule>;
  req: () => PermissionRequest;
}

const ROWS: Row[] = [
  {
    name: "deny 规则",
    owner: "user",
    rules: { deny: ["Bash(curl *)"] },
    req: () => ({ toolName: "bash", input: { command: "curl https://example.com" } }),
  },
  {
    name: "disallowedTools",
    owner: "user",
    config: { disallowedTools: ["WebFetch"] },
    req: () => ({ toolName: "web_fetch", input: { url: "https://example.com" } }),
  },
  {
    name: "危险命令（Step 2）",
    owner: "system",
    req: () => ({ toolName: "bash", input: { command: "rm -rf /" } }),
  },
  {
    name: "safetyCheck：写 .git/hooks（Step 6）",
    owner: "system",
    req: () => ({ toolName: "write", input: { file_path: join(ws, ".git/hooks/pre-commit") } }),
  },
];

function checker(row: Row, mode: Record<string, unknown>) {
  const { nonInteractive, ...rest } = mode as { nonInteractive?: boolean };
  const c = new PermissionChecker(
    { ...defaultConfig(), ...row.config, ...rest } as never,
    rules(row.rules ?? {}),
    ws,
  );
  if (nonInteractive)
    (c as unknown as { isNonInteractive: () => boolean }).isNonInteractive = () => true;
  return c;
}

describe("契约表：最宽松档位下仍不得自动放行", () => {
  for (const row of ROWS) {
    for (const [label, mode] of PERMISSIVE) {
      test(`${row.name} × ${label}`, async () => {
        const r = await checker(row, mode).check(row.req());
        expect(r.allowed).toBe(false);
      });
    }
  }
});

describe("契约表 · skip 列：只有「用户写下的拒绝」生效", () => {
  for (const row of ROWS) {
    const expectDeny = row.owner === "user";
    test(`${row.name} × skip ⇒ ${expectDeny ? "拒绝" : "放行（skip 本来的语义）"}`, async () => {
      const r = await checker(row, { skipPermissions: true }).check(row.req());
      expect(r.allowed).toBe(!expectDeny);
      expect(r.mode).toBe("dangerously-skip-permissions");
    });
  }
});

describe("对照：契约表没有把普通调用也拦住", () => {
  for (const [label, mode] of PERMISSIVE) {
    test(`普通工作区写入 × ${label} 放行`, async () => {
      const row: Row = {
        name: "普通写入",
        owner: "system",
        req: () => ({ toolName: "write", input: { file_path: join(ws, "src/a.ts") } }),
      };
      const r = await checker(row, mode).check(row.req());
      // acceptEdits / always-allow / yesMode 都应放行工作区内的普通写入
      expect(r.allowed).toBe(true);
    });
  }
});
