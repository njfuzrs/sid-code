/**
 * PR-6（B8）— notebook_edit 接入并发冲突检测回归测试
 *
 * 此前 notebook-edit 改 .ipynb 完全不声明意图也不查冲突：
 * - 其它会话对同一 notebook 的 edit/write 看不到它（漏登记 → 别人漏检）
 * - 它对其它会话已声明的意图也视而不见（漏查询 → 自己盲改）
 *
 * 本套件验证接线后的行为与 edit/write 完全同口径：
 * 1. 写成功后 declareFileIntent（operation=edit），其它会话可查见
 * 2. 同文件冲突 + handler stop → 拒绝且文件未被改动
 * 3. worktree 分支分叉 → handler 零调用自动放行 + output 附提示 +
 *    埋点 action=branch_auto_continue / tool=notebook_edit（A1 契约）
 * 4. block 模式 → 直接阻止（显式配置 > 自动放行）
 * 5. 写后回写 tracker 内容快照 → 紧随的 edit 不被误判「外部修改」（BUG1 类回归）
 * 6. 无 tracker 构造（旧路径/测试）→ 行为不变，零冲突检测
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  declareFileIntent,
  queryFileIntents,
  clearFileIntent,
  __clearIntentKeyCache,
} from "../../src/session/file-intent.ts";
import { FileReadTracker } from "../../src/tool/file-read-tracker.ts";
import { NotebookEditTool } from "../../src/tool/notebook-edit.ts";
import { EditTool } from "../../src/tool/edit.ts";
import { createStatefulTools, STATEFUL_TOOL_NAMES } from "../../src/tool/stateful-tools.ts";
import { getLogger } from "../../src/debug/logger.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** 最小合法 ipynb：一个带 id 的 code cell */
function makeNotebook(): string {
  return (
    JSON.stringify(
      {
        cells: [
          {
            cell_type: "code",
            source: ["print(1)\n"],
            metadata: { id: "c1" },
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    ) + "\n"
  );
}

let repo: string;
let outside: string;
let sidHome: string;
let prevSidHome: string | undefined;
let tracker: FileReadTracker;
let nbTool: NotebookEditTool;
let nbFile: string;

const declaredSessions: string[] = [];

/** 埋点捕获：logger 单例实例级 spy（同 branch-conflict-auto-continue.test.ts 模式） */
let conflictEvents: Array<Record<string, unknown>>;
let origDebug: (category: string, message: string, data?: unknown) => void;

function captureConflictEvents(): void {
  const log = getLogger();
  origDebug = log.debug;
  conflictEvents = [];
  (log as any).debug = (category: string, message: string) => {
    if (category === "CONFLICT") {
      conflictEvents.push(JSON.parse(message));
    }
  };
}

function restoreLogger(): void {
  (getLogger() as any).debug = origDebug;
}

/** 建真实 linked worktree 并在其中以 edit 意图声明同一逻辑 notebook */
function declareFromWorktree(sessionId: string, branch: string): string {
  const sibling = join(outside, `wt-${branch}`);
  git(["worktree", "add", "-q", "-b", branch, sibling, "main"], repo);
  const wtFile = join(sibling, "nb.ipynb");
  declareFileIntent(sessionId, process.pid, sibling, wtFile, "edit");
  declaredSessions.push(sessionId);
  return wtFile;
}

function declareSameFile(sessionId: string, op: "edit" | "write"): void {
  declareFileIntent(sessionId, process.pid, repo, nbFile, op);
  declaredSessions.push(sessionId);
}

function replaceCell(): Promise<{ output: string; isError?: boolean }> {
  return nbTool.execute({
    notebook_path: nbFile,
    cell_id: "c1",
    edit_mode: "replace",
    new_source: "print(2)",
  }) as Promise<{ output: string; isError?: boolean }>;
}

beforeEach(() => {
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr6-home-")));
  process.env.SID_CONFIG_DIR = sidHome;
  __clearIntentKeyCache();

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr6-repo-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr6-out-")));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  nbFile = join(repo, "nb.ipynb");
  writeFileSync(nbFile, makeNotebook());
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  tracker = new FileReadTracker();
  tracker.applySessionContext({
    sessionId: "pr6-main-session",
    pid: process.pid,
    cwd: repo,
  });
  tracker.conflictDetection = true;
  tracker.conflictSeverity = "warn";
  nbTool = new NotebookEditTool(tracker);

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

describe("PR-6 — notebook_edit 意图声明（B8 漏登记）", () => {
  it("写成功后 declareFileIntent：其它会话按同一逻辑路径可查见 operation=edit", async () => {
    const result = await replaceCell();
    expect(result.isError).toBeUndefined();

    const hits = queryFileIntents(nbFile, "pr6-other-session");
    expect(hits.map((h) => h.sessionId)).toContain("pr6-main-session");
    expect(hits.find((h) => h.sessionId === "pr6-main-session")!.intent.operation).toBe("edit");
  });

  it("其它会话已声明同文件意图 + handler stop → 拒绝且文件未被改动", async () => {
    declareSameFile("pr6-same-stop", "edit");
    const handler = mock(async () => "stop" as const);
    tracker.conflictHandler = handler;
    const before = readFileSync(nbFile, "utf-8");

    const result = await replaceCell();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("用户选择停止");
    expect(readFileSync(nbFile, "utf-8")).toBe(before);
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0].action).toBe("stop");
    expect(conflictEvents[0].tool).toBe("notebook_edit");
  });

  it("worktree 分支分叉 → handler 零调用自动放行、output 附提示、埋点 branch_auto_continue", async () => {
    declareFromWorktree("pr6-wt", "feat-pr6-wt");
    // handler 返回 stop：若被调用结果必然 isError——零调用断言有双重证据
    const handler = mock(async () => "stop" as const);
    tracker.conflictHandler = handler;

    const result = await replaceCell();

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("并发分支提示");
    expect(result.output).toContain("不会互相覆盖");
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0].action).toBe("branch_auto_continue");
    expect(conflictEvents[0].tool).toBe("notebook_edit");
  });

  it("block 模式优先：分支分叉也照样阻止", async () => {
    declareFromWorktree("pr6-wt-block", "feat-pr6-block");
    tracker.conflictSeverity = "block";
    const handler = mock(async () => "continue" as const);
    tracker.conflictHandler = handler;

    const result = await replaceCell();

    expect(result.isError).toBe(true);
    expect(result.output).toContain("已阻止");
    expect(handler).not.toHaveBeenCalled();
    expect(conflictEvents[0].action).toBe("blocked");
  });
});

describe("PR-6 — notebook_edit 写后回写（BUG1 类回归）", () => {
  it("写后 tracker 记录新内容：紧随的 edit 不被误判「外部修改」", async () => {
    const result = await replaceCell();
    expect(result.isError).toBeUndefined();
    expect(tracker.hasBeenRead(nbFile)).toBe(true);

    // 同一 tracker 交给 EditTool：notebook_edit 刚重写了整个 JSON，
    // 若没回写内容快照，edit 的新鲜度比对会拿旧内容把它误判为外部修改。
    const editTool = new EditTool(tracker);
    const editResult = await editTool.execute({
      file_path: nbFile,
      old_string: '"nbformat_minor": 5',
      new_string: '"nbformat_minor": 6',
    });
    // 精确命中且不被「没读过 / 外部修改」拒绝，即证明写后回写生效
    expect(editResult.isError).toBeUndefined();
  });

  it("回写的是有效完整视图：notebook_edit 后的真实外部修改能被 edit 守卫检出", async () => {
    const result = await replaceCell();
    expect(result.isError).toBeUndefined();

    // 外部进程改动（内容变 + mtime 推进）——回写快照若有效，
    // 下一次 edit 的新鲜度比对必须把它拦为「外部修改」
    const stale = readFileSync(nbFile, "utf-8");
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(nbFile, stale.replace('"nbformat_minor": 5', '"nbformat_minor": 99'));
    const { utimesSync } = await import("fs");
    const future = new Date(Date.now() + 2000);
    utimesSync(nbFile, future, future);

    const editTool = new EditTool(tracker);
    const editResult = await editTool.execute({
      file_path: nbFile,
      old_string: '"nbformat": 4',
      new_string: '"nbformat": 5',
    });
    expect(editResult.isError).toBe(true);
    expect(editResult.output).toContain("外部修改");
  });
});

describe("PR-6 — 兼容与接线", () => {
  it("无 tracker 构造（旧路径）→ 行为不变，正常编辑且零冲突检测", async () => {
    const bare = new NotebookEditTool();
    declareSameFile("pr6-bare-other", "write");

    const result = (await bare.execute({
      notebook_path: nbFile,
      cell_id: "c1",
      edit_mode: "replace",
      new_source: "print(3)",
    })) as { output: string; isError?: boolean };

    // 旧构造路径退回改造前行为：不检测（也就无弹窗/阻止），编辑成功
    expect(result.isError).toBeUndefined();
    expect(readFileSync(nbFile, "utf-8")).toContain("print(3)");
  });

  it("工厂接线：createStatefulTools 产出 notebook_edit，STATEFUL_TOOL_NAMES 收录", () => {
    const tools = createStatefulTools(new FileReadTracker());
    expect(tools.map((t) => t.name())).toContain("notebook_edit");
    expect(STATEFUL_TOOL_NAMES.has("notebook_edit")).toBe(true);
  });
});
