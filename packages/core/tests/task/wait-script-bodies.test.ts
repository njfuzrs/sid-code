/**
 * P3 / P4：脚本正文参与抽对象 + 抽不出对象时按「命令 + 脚本 hash」去重。
 *
 * ## 为什么是这两条（方案 §4.8 / §4.9）
 *
 * 触发会话的等待几乎全是自定义监控脚本：`bash /tmp/watch-prs.sh`、`bash /tmp/waits.sh`。
 * 命令行上一个字都没有，对象在**脚本正文**里。于是：
 * - T-P3-1：monitor 的 `command` 恰好就是脚本正文，但 `readWaitScriptBodies` 原先只在
 *   bash 工具里 —— monitor 侧抽不到「在等哪个 PR」，R2 的去重与 P1 的覆盖判定双双失明；
 * - T-P4-1：抽不出对象时原实现**直接放行**，于是「同一份脚本连挂四次」可以同时跑四份
 *   —— 这正是 b0aa0f1e 的事故形态。
 *
 * T-P3-1 的夹具是触发会话里 `watch-prs.sh` 的原文（`cd "$REPO"` 替换了本机绝对路径），
 * 它同时含 `gh pr list`（P1）、`date +%H:%M`（P2）、「对象在脚本里」（P3）三个识别点。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MonitorTool } from "../../src/tool/monitor.ts";
import { __clearActiveMonitorsForTest } from "../../src/task/monitor-task.ts";
import { clearAllTasks, registerTask } from "../../src/task/registry.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import {
  __resetWaitRegistryForTest,
  listWaits,
  registerWait,
  setWaitTraceSink,
} from "../../src/task/wait-registry.ts";
import { decideWaitAdmission } from "../../src/task/wait-admission.ts";
import type { LocalShellTaskState } from "../../src/task/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";
const tool = new MonitorTool();

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wait-script-"));
  // monitor / task registry 都会往 tasks 目录落盘 → 重定向（CONTRIBUTING 测试约定）
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  clearAllTasks();
  dequeuePendingNotifications();
});

afterEach(() => {
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  __resetWaitRegistryForTest();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

function shellTask(id: string, command: string): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `cmd ${id}`,
    startTime: Date.now(),
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command,
    interrupted: false,
    isBackgrounded: true,
  };
}

/** 登记一条「没有对象」的显式等待（等价于已跑起来的自定义脚本） */
function addObjectlessWait(
  id: string,
  opts: { command: string; scriptHash?: string; toolUseId?: string },
): void {
  registerTask(shellTask(id, opts.command));
  registerWait({
    id,
    kind: "shell",
    promise: { kind: "deadline", deadlineAt: Date.now() + 600_000 },
    description: `wait ${id}`,
    registeredAt: Date.now(),
    command: opts.command,
    scriptHash: opts.scriptHash,
    ...(opts.toolUseId !== undefined ? { toolUseId: opts.toolUseId } : {}),
  });
}

describe("P3 脚本正文参与抽对象", () => {
  test("T-P3-1 monitor 跑 bash <tmp>/watch.sh → subject / family / scriptHash 都抽得到", async () => {
    const scriptPath = join(tmpHome, "watch.sh");
    copyFileSync(join(import.meta.dir, "fixtures", "watch-prs.sh"), scriptPath);

    const r = await tool.call({
      description: "监控 open PR",
      command: `bash ${scriptPath}`,
      timeout_ms: 60_000,
    });
    expect(r.isError).toBeFalsy();
    const id = /已启动监控 (m[a-z0-9]{8})/.exec(r.data)?.[1];
    expect(id).toBeTruthy();

    const wait = listWaits().find((w) => w.id === id);
    // monitor 的 command 是文件路径，命令行上一个字都没有 —— 不读脚本正文就抽不到对象。
    // 修复前这条一定是 undefined（`readWaitScriptBodies` 只在 bash 工具里）。
    expect(wait?.subjects).toContain("gh:prs:current:open");
    // 命令族同源同尺：P1 的覆盖判定靠它
    expect(wait?.commandFamilies).toContain("gh_pr_list");
    // hash 非空：P4 的无对象去重靠它区分「同一份脚本」与「改过的脚本」
    expect(wait?.scriptHash).toBeTruthy();
  });

  test("T-P3-2 所有 collectWaitSubjects 生产调用点都带 scriptBodies 或 prompt", () => {
    // 这条是**防漂移**：新增一个等待入口（比如插件里的等待）时，忘了传 scriptBodies
    // 不会报错、不会有测试红 —— 只会静默地「抽不到对象」，然后 R2 去重与 P1 覆盖一起退化。
    // 静态扫描把它变成一条会红的断言。
    //
    // ⚠️ 取的是**精确的调用表达式**（括号配对到 `)`），不是「后面 N 行」：
    // 取窗口会把下一行的 `hashScriptBodies(scriptBodies)` 也算进来，于是删除传参时
    // 扫描仍然通过 —— 变异自证实测抓到的假阴性（第一版就是这么写的）。
    const violations: string[] = [];
    for (const file of walkTs(join(import.meta.dir, "../../src"))) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const m of line.matchAll(/collectWaitSubjects\s*\(/g)) {
          // 定义处不是调用点
          if (/function\s+collectWaitSubjects/.test(line)) continue;
          const snippet = callExpression(lines, i, m.index + m[0].length - 1);
          // 命令类入口必须带 scriptBodies；唤醒类入口只有自然语言（prompt）
          if (/scriptBodies|prompt:/.test(snippet)) continue;
          violations.push(`${file}:${i + 1} → ${snippet.replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("P4 抽不出对象时的准入判定", () => {
  test("T-P4-1 同一份脚本再挂一次（同命令 + 同 hash）→ duplicate", () => {
    addObjectlessWait("s1", { command: "bash /tmp/wait-unknown.sh", scriptHash: "h1" });
    const d = decideWaitAdmission({
      kind: "monitor",
      subjects: [],
      command: "bash /tmp/wait-unknown.sh",
      scriptHash: "h1",
      deadlineAt: Date.now() + 300_000,
    });
    expect(d.action).toBe("duplicate");
    expect(d.existing.map((w) => w.id)).toEqual(["s1"]);
  });

  test("T-P4-1b 归一化后同一条命令（`cd X && bash …` 前缀）也算同一件事", () => {
    addObjectlessWait("s1", { command: "bash /tmp/wait-unknown.sh", scriptHash: "h1" });
    const d = decideWaitAdmission({
      kind: "monitor",
      subjects: [],
      command: "cd /repo && bash /tmp/wait-unknown.sh",
      scriptHash: "h1",
      deadlineAt: Date.now() + 300_000,
    });
    expect(d.action).toBe("duplicate");
  });

  test("T-P4-2 脚本改过（hash 不同）→ replace", () => {
    addObjectlessWait("s1", { command: "bash /tmp/wait-unknown.sh", scriptHash: "h1" });
    const d = decideWaitAdmission({
      kind: "monitor",
      subjects: [],
      command: "bash /tmp/wait-unknown.sh",
      scriptHash: "h2",
      deadlineAt: Date.now() + 300_000,
    });
    expect(d.action).toBe("replace");
    expect(d.existing.map((w) => w.id)).toEqual(["s1"]);
  });

  test("T-P4-3 两个不同的自定义脚本（都抽不出对象）→ 两个都 start", () => {
    addObjectlessWait("s1", { command: "bash /tmp/a.sh", scriptHash: "ha" });
    const d = decideWaitAdmission({
      kind: "monitor",
      subjects: [],
      command: "bash /tmp/b.sh",
      scriptHash: "hb",
      deadlineAt: Date.now() + 300_000,
    });
    expect(d.action).toBe("start");
  });

  test("T-P4-4 双方都没有脚本 hash（命令行直接写循环）→ 同命令判 duplicate", () => {
    addObjectlessWait("s1", { command: "until curl -s http://x/ok; do sleep 5; done" });
    const d = decideWaitAdmission({
      kind: "shell",
      subjects: [],
      command: "until curl -s http://x/ok; do sleep 5; done",
      deadlineAt: Date.now() + 60_000,
    });
    expect(d.action).toBe("duplicate");
  });

  test("T-P4-5 连命令都没有（唤醒只给了自然语言）→ start，不猜", () => {
    const d = decideWaitAdmission({
      kind: "wakeup",
      subjects: [],
      deadlineAt: Date.now() + 60_000,
    });
    expect(d.action).toBe("start");
  });

  test("T-P4-6 自己那条等待不与自己比（重挂同一 id）→ start", () => {
    addObjectlessWait("s1", { command: "bash /tmp/wait-unknown.sh", scriptHash: "h1" });
    const d = decideWaitAdmission({
      id: "s1",
      kind: "monitor",
      subjects: [],
      command: "bash /tmp/wait-unknown.sh",
      scriptHash: "h1",
      deadlineAt: Date.now() + 300_000,
    });
    expect(d.action).toBe("start");
  });

  test("P4 命中的事件带 action=duplicate（埋点可归因）", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    setWaitTraceSink((name, payload) => {
      events.push({ name, payload: payload as Record<string, unknown> });
    });
    addObjectlessWait("s1", { command: "bash /tmp/wait-unknown.sh", scriptHash: "h1" });
    decideWaitAdmission({
      kind: "monitor",
      subjects: [],
      command: "bash /tmp/wait-unknown.sh",
      scriptHash: "h1",
      deadlineAt: Date.now() + 300_000,
    });
    expect(events.some((e) => e.payload.action === "duplicate")).toBe(true);
    setWaitTraceSink(null);
  });
});

/** 递归列出 `.ts` 文件（跳过 node_modules / dist） */
function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkTs(p);
    else if (name.endsWith(".ts")) yield p;
  }
}

/**
 * 从 `(` 所在位置起截出**完整的调用表达式**（括号配对）。
 *
 * 为什么不用「后面 N 行」：那会把相邻语句里的 `scriptBodies` 也算进来，
 * 于是「删掉传参」的变异仍然通过 —— 变异自证实测的假阴性。
 */
function callExpression(lines: string[], startLine: number, openParenCol: number): string {
  let text = "";
  let depth = 0;
  for (let li = startLine; li < lines.length && li < startLine + 12; li++) {
    const line = lines[li]!;
    for (let ci = li === startLine ? openParenCol : 0; ci < line.length; ci++) {
      const ch = line[ci]!;
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      text += ch;
      if (depth === 0) return text;
    }
    text += "\n";
  }
  return text;
}
