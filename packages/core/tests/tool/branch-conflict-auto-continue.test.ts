/**
 * PR-4（B-c）— worktree 分支分叉冲突不弹窗自动放行
 *
 * 验证 edit/write 的冲突处理分叉：
 * - 全部冲突方都是分支分叉（isWorktreeBranchConflict=true）→ conflictHandler 零调用，
 *   直接放行，成功输出附「并发分支提示」，埋点 action=branch_auto_continue（A1 契约：
 *   与用户裁决的 continue 严格分开，保护误报率代理口径）
 * - 同文件冲突 / 混合冲突 → 仍走弹窗（handler 被调用），弹窗路径不回归
 * - block 模式优先于自动放行（显式配置说要拦就拦，哪怕只是分支分叉）
 * - 无冲突 → 输出不附带任何提示
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  declareFileIntent,
  clearFileIntent,
  __clearIntentKeyCache,
} from "../../src/session/file-intent.ts";
import { FileReadTracker } from "../../src/tool/file-read-tracker.ts";
import { EditTool } from "../../src/tool/edit.ts";
import { WriteTool } from "../../src/tool/write.ts";
import { getLogger } from "../../src/debug/logger.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

let repo: string;
let outside: string;
let sidHome: string;
let prevSidHome: string | undefined;
let tracker: FileReadTracker;
let editTool: EditTool;
let writeTool: WriteTool;

/** 声明过意图的会话，afterEach 统一清理 */
const declaredSessions: string[] = [];

/** 埋点捕获：logger 单例实例级 spy（避免 mock.module 跨文件污染） */
let conflictEvents: Array<Record<string, unknown>>;
let origDebug: (category: string, message: string, data?: unknown) => void;

function captureConflictEvents(): void {
  const log = getLogger();
  origDebug = log.debug;
  conflictEvents = [];
  // emitConflictEvent 走 log.debug("CONFLICT", JSON.stringify(event))——
  // 只截 CONFLICT 类别，其余 debug 调用静默丢弃（测试进程本就不该依赖它们）。
  (log as any).debug = (category: string, message: string) => {
    if (category === "CONFLICT") {
      conflictEvents.push(JSON.parse(message));
    }
  };
}

function restoreLogger(): void {
  const log = getLogger();
  (log as any).debug = origDebug;
}

/** 建一个真实 linked worktree（git 会写 .git pointer 文件），并在其中声明 edit 意图 */
function declareFromWorktree(sessionId: string, branch: string, relFile: string): string {
  const sibling = join(outside, `wt-${branch}`);
  git(["worktree", "add", "-q", "-b", branch, sibling, "main"], repo);
  const wtFile = join(sibling, relFile);
  declareFileIntent(sessionId, process.pid, sibling, wtFile, "edit");
  declaredSessions.push(sessionId);
  return wtFile;
}

function declareSameFile(sessionId: string, filePath: string, op: "edit" | "write"): void {
  declareFileIntent(sessionId, process.pid, repo, filePath, op);
  declaredSessions.push(sessionId);
}

const MAIN_FILE = () => join(repo, "src", "login.ts");
const MAIN_CONTENT = "export const v = 1;\n";

beforeEach(() => {
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr4-home-")));
  process.env.SID_CONFIG_DIR = sidHome;
  __clearIntentKeyCache();

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr4-repo-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr4-out-")));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(MAIN_FILE(), MAIN_CONTENT);
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  tracker = new FileReadTracker();
  tracker.applySessionContext({
    sessionId: "pr4-main-session",
    pid: process.pid,
    cwd: repo,
  });
  tracker.conflictDetection = true;
  tracker.conflictSeverity = "warn";
  editTool = new EditTool(tracker);
  writeTool = new WriteTool(tracker);

  captureConflictEvents();
});

afterEach(() => {
  restoreLogger();
  for (const s of declaredSessions.splice(0)) {
    clearFileIntent(s);
  }
  __clearIntentKeyCache();
  if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidHome;
  for (const d of [repo, outside, sidHome]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

describe("PR-4 — worktree 分支分叉冲突自动放行（edit）", () => {
  it("分支分叉 + handler 已设 → handler 零调用、输出附提示、埋点 branch_auto_continue", async () => {
    declareFromWorktree("pr4-wt-edit", "feat-wt-edit", "src/login.ts");
    tracker.markAsRead(MAIN_FILE(), Date.now(), { content: MAIN_CONTENT });
    // handler 故意返回 stop：若被调用，结果必然 isError——零调用断言因此有双重证据
    const handler = mock(async () => "stop" as const);
    tracker.conflictHandler = handler;

    const result = await editTool.execute({
      file_path: MAIN_FILE(),
      old_string: "v = 1",
      new_string: "v = 2",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("并发分支提示");
    expect(result.output).toContain("不会互相覆盖");
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0].action).toBe("branch_auto_continue");
    expect(conflictEvents[0].tool).toBe("edit");
  });

  it("同文件冲突 → 仍走弹窗，handler 被调用（弹窗路径不回归）", async () => {
    declareSameFile("pr4-same-edit", MAIN_FILE(), "edit");
    tracker.markAsRead(MAIN_FILE(), Date.now(), { content: MAIN_CONTENT });
    const handler = mock(async () => "continue" as const);
    tracker.conflictHandler = handler;

    const result = await editTool.execute({
      file_path: MAIN_FILE(),
      old_string: "v = 1",
      new_string: "v = 2",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.output).not.toContain("并发分支提示");
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0].action).toBe("continue");
  });

  it("混合冲突（分叉 + 同文件）→ 保守弹窗，isWorktreeBranchConflict=false 语义生效", async () => {
    declareFromWorktree("pr4-wt-mix", "feat-wt-mix", "src/login.ts");
    declareSameFile("pr4-same-mix", MAIN_FILE(), "write");
    tracker.markAsRead(MAIN_FILE(), Date.now(), { content: MAIN_CONTENT });
    const handler = mock(async () => "continue" as const);
    tracker.conflictHandler = handler;

    const result = await editTool.execute({
      file_path: MAIN_FILE(),
      old_string: "v = 1",
      new_string: "v = 2",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(conflictEvents.map((e) => e.action)).not.toContain("branch_auto_continue");
  });

  it("block 模式优先：分支分叉也照样阻止（显式配置 > 自动放行）", async () => {
    declareFromWorktree("pr4-wt-block", "feat-wt-block", "src/login.ts");
    tracker.markAsRead(MAIN_FILE(), Date.now(), { content: MAIN_CONTENT });
    tracker.conflictSeverity = "block";
    const handler = mock(async () => "continue" as const);
    tracker.conflictHandler = handler;

    const result = await editTool.execute({
      file_path: MAIN_FILE(),
      old_string: "v = 1",
      new_string: "v = 2",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("已阻止");
    expect(handler).not.toHaveBeenCalled();
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0].action).toBe("blocked");
  });

  it("无冲突 → 输出不含提示、零 CONFLICT 埋点", async () => {
    tracker.markAsRead(MAIN_FILE(), Date.now(), { content: MAIN_CONTENT });
    tracker.conflictHandler = mock(async () => "stop" as const);

    const result = await editTool.execute({
      file_path: MAIN_FILE(),
      old_string: "v = 1",
      new_string: "v = 2",
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).not.toContain("并发分支提示");
    expect(conflictEvents.length).toBe(0);
  });
});

describe("PR-4 — worktree 分支分叉冲突自动放行（write）", () => {
  it("分支分叉 + handler 已设 → 自动放行、输出附提示、埋点 tool=write", async () => {
    declareFromWorktree("pr4-wt-write", "feat-wt-write", "src/login.ts");
    // 覆盖已有文件必须先完整 read（先读后写守卫），否则走不到冲突分叉这一步
    tracker.markAsRead(MAIN_FILE(), Date.now(), { content: MAIN_CONTENT });
    const handler = mock(async () => "stop" as const);
    tracker.conflictHandler = handler;

    const result = await writeTool.execute({
      file_path: MAIN_FILE(),
      content: "export const v = 3;\n",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("已写入");
    expect(result.output).toContain("并发分支提示");
    expect(result.output).toContain("不会互相覆盖");
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0].action).toBe("branch_auto_continue");
    expect(conflictEvents[0].tool).toBe("write");
  });
});
