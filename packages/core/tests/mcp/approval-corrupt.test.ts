/**
 * C1 回归：mcp-approvals.json 损坏后，下一次写入必须「先备份再覆盖」。
 *
 * 缺陷形态：`loadApprovals` 解析失败时返回空 store，紧接着 approve / reject /
 * setApproveAll 都走「load → 改 → 整个文件重写」—— 没有备份的话，用户**全部项目**的
 * 历史审批 / 拒绝记录会被一份几乎为空的文件静默覆盖，不可逆。
 *
 * 变异自证（逐条撤掉修复，对应断言必须变红）：
 * - 删掉 `saveApprovals` 里的备份逻辑 → 「approve 前先备份」用例红（找不到备份文件）；
 * - 删掉 `loadApprovals` 里的告警 → 「告警」用例红（日志里没有损坏消息）；
 * - 备份后不清 `corruptPending` → 「只备份一次」用例红（出现第二份 `.corrupt-*`）。
 *
 * 落盘隔离：`SID_CONFIG_DIR` 指向 tmpdir，测试前后存 / 恢复原值（不要无条件 delete）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { initLogger, LogLevel } from "@sid-code/core/debug/logger.ts";
import {
  approveProjectServer,
  computeServerConfigFingerprint,
  getProjectServerApproval,
} from "@sid-code/core/mcp/approval.ts";

/** 测试用 server 配置：审批按「名字 + 内容指纹」匹配，读写两侧必须传同一份 */
const CFG = { transport: "stdio", command: "echo" };
const FP = computeServerConfigFingerprint(CFG);

let ROOT: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), "sid-mcp-approval-corrupt-")));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(ROOT, "cfg");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(ROOT, { recursive: true, force: true });
});

/** 写一份损坏的审批文件；返回它自己的路径与所在状态目录。路径经 sidPaths 推导，不硬编码。 */
function writeCorrupt(content = '{"approved": ['): { file: string; stateDir: string } {
  const stateDir = sidPaths.state();
  mkdirSync(stateDir, { recursive: true });
  const file = sidPaths.stateFile("mcp-approvals.json");
  writeFileSync(file, content);
  return { file, stateDir };
}

/** 状态目录下的全部 `.corrupt-*` 备份文件 */
function corruptBackups(): string[] {
  const stateDir = sidPaths.state();
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir).filter((f) => f.includes(".corrupt-"));
}

describe("C1 审批文件损坏：告警 + 读取回退 pending + 写前备份", () => {
  test("损坏文件读出 pending（fail-safe 回退待审批，而不是当成已批准）", () => {
    writeCorrupt();
    expect(getProjectServerApproval("s", CFG, "/p")).toBe("pending");
  });

  test("approve 前先备份：备份与原内容逐字节相同，新文件合法且含本次记录", () => {
    const corrupt = '{"approved": [';
    const { file, stateDir } = writeCorrupt(corrupt);

    approveProjectServer("s2", CFG, "/p");

    const backups = corruptBackups();
    expect(backups.length).toBe(1);
    expect(readFileSync(join(stateDir, backups[0]), "utf-8")).toBe(corrupt);
    // 新写的审批文件是合法 JSON，本次批准已落盘、可读回
    const store = JSON.parse(readFileSync(file, "utf-8")) as { approved: string[] };
    expect(store.approved).toContain(`/p:s2#sha256:${FP}`);
    expect(getProjectServerApproval("s2", CFG, "/p")).toBe("approved");
  });

  test("同一个损坏文件只备份一次", () => {
    writeCorrupt();
    approveProjectServer("a", CFG, "/p");
    approveProjectServer("b", CFG, "/p");
    expect(corruptBackups().length).toBe(1);
    expect(getProjectServerApproval("b", CFG, "/p")).toBe("approved");
  });

  test("读到损坏后又读到合法内容（外部已修复）不会误备份好文件", () => {
    const { file, stateDir } = writeCorrupt();
    // 第一次读：损坏 → 标记待备份
    expect(getProjectServerApproval("s", CFG, "/p")).toBe("pending");
    // 外部把文件改回合法内容（用户手动修好 / 另一个进程写回）
    writeFileSync(file, JSON.stringify({ approved: [`/keep:s#sha256:${FP}`], rejected: [] }));

    approveProjectServer("x", CFG, "/p");

    expect(corruptBackups()).toEqual([]);
    // 原有记录没被当成损坏件挪走，且仍能读回（key 格式：<项目路径>:<server 名>#sha256:<指纹>）
    expect(getProjectServerApproval("s", CFG, "/keep")).toBe("approved");
    const store = JSON.parse(readFileSync(join(stateDir, "mcp-approvals.json"), "utf-8")) as {
      approved: string[];
    };
    expect(store.approved).toContain(`/keep:s#sha256:${FP}`);
    expect(store.approved).toContain(`/p:x#sha256:${FP}`);
  });

  test("文件不存在（首次使用）不产生任何备份", () => {
    mkdirSync(sidPaths.state(), { recursive: true });
    approveProjectServer("s", CFG, "/p");
    expect(corruptBackups()).toEqual([]);
    expect(getProjectServerApproval("s", CFG, "/p")).toBe("approved");
  });

  test("损坏时写一条 WARN：消息含文件路径与备份说明", async () => {
    const { file } = writeCorrupt('{"approved": [');
    const logFile = join(ROOT, "warn.log");
    const lg = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile,
      console: false,
      fileOnly: true,
    });
    try {
      getProjectServerApproval("s", CFG, "/p");
      await lg.flush();
      const text = readFileSync(logFile, "utf-8");
      expect(text).toContain("已损坏");
      expect(text).toContain(file);
      expect(text).toContain("备份");
    } finally {
      // 全局单例：不复位会污染同进程的其它测试文件
      initLogger({ enabled: false });
    }
  });
});
