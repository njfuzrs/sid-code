/**
 * PR-7（B11）— 冲突弹窗等待墙钟插桩（conflict-gate.ts）回归测试
 *
 * 此前冲突弹窗阻塞工具执行的等待时长没有任何记录，整段被算进工具耗时
 * （436bfce5 实测 edit p95=428,400ms 而同会话 PermissionDecision(prompted=true)=0
 * ——量到的"工具慢"其实是人在犹豫）。
 *
 * 本套件钉住插桩口径：
 * 1. 只有 conflictHandler 弹窗分支的事件带 hitlMs，且 ≥ 真实等待墙钟
 * 2. 自动决策分支（branch_auto_continue / blocked / headless_fallback）一律
 *    **没有 hitlMs 键**——缺失=没等人，不落 0（0 会被读成"秒批"）
 * 3. 三个写路径工具共用同一闸门（PR-6 单一实现），edit 上验证的插桩
 *    对 write / notebook_edit 同口径生效
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  declareFileIntent,
  clearFileIntent,
  __clearIntentKeyCache,
} from "../../src/session/file-intent.ts";
import {
  setConflictEventObserver,
  type ConflictEvent,
} from "../../src/session/conflict-analytics.ts";
import { FileReadTracker } from "../../src/tool/file-read-tracker.ts";
import { EditTool } from "../../src/tool/edit.ts";

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
let mainFile: string;

const MAIN_CONTENT = "export const v = 1;\n";
const declaredSessions: string[] = [];
let events: ConflictEvent[];

/** 用观察者捕获（PR-7 新链路），不再走 logger spy——事件是类型化的，断言更直接 */
function captureViaObserver(): void {
  events = [];
  setConflictEventObserver((e) => events.push(e));
}

function declareSameFile(sessionId: string, op: "edit" | "write"): void {
  declareFileIntent(sessionId, process.pid, repo, mainFile, op);
  declaredSessions.push(sessionId);
}

function declareFromWorktree(sessionId: string, branch: string): void {
  const sibling = join(outside, `wt-${branch}`);
  git(["worktree", "add", "-q", "-b", branch, sibling, "main"], repo);
  declareFileIntent(sessionId, process.pid, sibling, join(sibling, "login.ts"), "edit");
  declaredSessions.push(sessionId);
}

/** 延迟后返回指定裁决的 handler（模拟"人在弹窗前想了一会儿"） */
function slowHandler(delayMs: number, action: "continue" | "stop") {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return action;
  };
}

function runEdit(): Promise<{ output: string; isError?: boolean }> {
  return editTool.execute({
    file_path: mainFile,
    old_string: "v = 1",
    new_string: "v = 2",
  }) as Promise<{ output: string; isError?: boolean }>;
}

beforeEach(() => {
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr7-home-")));
  process.env.SID_CONFIG_DIR = sidHome;
  __clearIntentKeyCache();

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr7-repo-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr7-out-")));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  mainFile = join(repo, "login.ts");
  writeFileSync(mainFile, MAIN_CONTENT);
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  tracker = new FileReadTracker();
  tracker.applySessionContext({
    sessionId: "pr7-main-session",
    pid: process.pid,
    cwd: repo,
  });
  tracker.conflictDetection = true;
  tracker.conflictSeverity = "warn";
  editTool = new EditTool(tracker);

  captureViaObserver();
});

afterEach(() => {
  setConflictEventObserver(null);
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

describe("PR-7（B11）— 弹窗分支的 hitlMs 插桩", () => {
  it("handler 裁决 continue：事件带 hitlMs 且 ≥ 真实等待墙钟", async () => {
    declareSameFile("pr7-same-cont", "edit");
    tracker.markAsRead(mainFile, Date.now(), { content: MAIN_CONTENT });
    tracker.conflictHandler = slowHandler(60, "continue");

    const result = await runEdit();

    expect(result.isError).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("continue");
    expect(events[0].tool).toBe("edit");
    // 插桩量的是 handler 前后的墙钟：handler 里睡了 60ms，hitlMs 必须 ≥ 它
    //（断言下界不断言上界——CI 慢机上调度抖动只会让它更大，不会更小）
    expect(typeof events[0].hitlMs).toBe("number");
    expect(events[0].hitlMs!).toBeGreaterThanOrEqual(55);
  });

  it("handler 裁决 stop：拒绝路径同样带 hitlMs（等过就要记，无论结果）", async () => {
    declareSameFile("pr7-same-stop", "edit");
    tracker.markAsRead(mainFile, Date.now(), { content: MAIN_CONTENT });
    tracker.conflictHandler = slowHandler(50, "stop");

    const result = await runEdit();

    expect(result.isError).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("stop");
    expect(events[0].hitlMs!).toBeGreaterThanOrEqual(45);
  });
});

describe("PR-7（B11）— 自动决策分支不产生 hitlMs（缺失=没等人，不落 0）", () => {
  it("branch_auto_continue（worktree 分支分叉）：无 hitlMs 键", async () => {
    declareFromWorktree("pr7-wt", "feat-pr7-hitl");
    tracker.markAsRead(mainFile, Date.now(), { content: MAIN_CONTENT });
    // handler 已设但分叉路径不应调它；万一被调，慢 handler 会让 hitlMs 显形
    tracker.conflictHandler = slowHandler(60, "stop");

    const result = await runEdit();

    expect(result.isError).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("branch_auto_continue");
    expect("hitlMs" in events[0]).toBe(false);
  });

  it("blocked（block 模式）：无 hitlMs 键", async () => {
    declareSameFile("pr7-block", "edit");
    tracker.markAsRead(mainFile, Date.now(), { content: MAIN_CONTENT });
    tracker.conflictSeverity = "block";
    tracker.conflictHandler = slowHandler(60, "continue");

    const result = await runEdit();

    expect(result.isError).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("blocked");
    expect("hitlMs" in events[0]).toBe(false);
  });

  it("headless_fallback（无 handler）：无 hitlMs 键", async () => {
    declareSameFile("pr7-headless", "edit");
    tracker.markAsRead(mainFile, Date.now(), { content: MAIN_CONTENT });
    tracker.conflictHandler = undefined;

    const result = await runEdit();

    // 无头降级放行（P1-6 既有语义），但没等人 → 不产生 HITL 样本
    expect(result.isError).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("headless_fallback");
    expect("hitlMs" in events[0]).toBe(false);
  });

  it("无冲突：零事件（插桩不在无冲突路径上凭空造样本）", async () => {
    tracker.markAsRead(mainFile, Date.now(), { content: MAIN_CONTENT });
    tracker.conflictHandler = slowHandler(60, "continue");

    const result = await runEdit();

    expect(result.isError).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});
