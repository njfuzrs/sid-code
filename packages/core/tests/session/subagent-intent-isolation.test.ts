/**
 * PR-2 — 子代理 agentId 独立登记回归测试
 *
 * 覆盖外部方案文档（20261016-并发冲突检测-worktree感知重构）§2.3 与缺陷表：
 * - B3（漏检）：并行子代理共用父 sessionId，queryFileIntents 按 sessionId 排除
 *   「自己」，兄弟子代理的声明被整体排除 → 互相检测不到。修复后各用自己的
 *   agentId（<parentSessionId>-sub-<taskId>）登记。
 * - C2（覆盖）：同一 sessionId 的多个子代理并发读-改-写同一个意图 JSON，
 *   后写覆盖先写。修复后一会话一文件的粒度细化到一子代理一文件，天然隔离。
 * - 归属展示：parentSessionId 只写不清、随查询透传，/conflict 与冲突警告
 *   标注「子代理 → 归属父会话」。
 * - 退出清理：子代理与父会话同 pid，读侧 isProcessAlive 探活清不掉，
 *   execute()/executeCustom() 的 finally 必须 clearFileIntent(agentId)。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  declareFileIntent,
  queryFileIntents,
  queryAllFileIntents,
  clearFileIntent,
  __clearIntentKeyCache,
} from "@sid-code/core/session/file-intent.ts";
import { checkConflict, formatConflictWarning } from "@sid-code/core/session/conflict-detector.ts";
import { FileReadTracker } from "@sid-code/core/tool/file-read-tracker.ts";

let home: string;
let sidHome: string;
let prevSidHome: string | undefined;

beforeEach(() => {
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr2-home-")));
  process.env.SID_CONFIG_DIR = sidHome;
  __clearIntentKeyCache();
  home = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr2-work-")));
  writeFileSync(join(home, "shared.ts"), "export const v = 1;\n");
  writeFileSync(join(home, "other.ts"), "export const w = 1;\n");
});

afterEach(() => {
  __clearIntentKeyCache();
  if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidHome;
  for (const d of [home, sidHome]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

const PARENT = "pr2-parent-session";
const SUB_A = `${PARENT}-sub-taskA`;
const SUB_B = `${PARENT}-sub-taskB`;
const shared = () => join(home, "shared.ts");

describe("B3 — 并行子代理互相可见", () => {
  it("两个 agentId 不同的子代理声明同一文件，checkConflict 互相命中且带归属", () => {
    declareFileIntent(SUB_A, process.pid, home, shared(), "edit", PARENT);
    try {
      const report = checkConflict(shared(), SUB_B);
      expect(report).not.toBeNull();
      expect(report!.conflictingSessions.length).toBe(1);
      expect(report!.conflictingSessions[0].sessionId).toBe(SUB_A);
      expect(report!.conflictingSessions[0].parentSessionId).toBe(PARENT);
    } finally {
      clearFileIntent(SUB_A);
    }
  });

  it("父会话查询也能看到子代理的声明（归属字段不影响判定）", () => {
    declareFileIntent(SUB_A, process.pid, home, shared(), "write", PARENT);
    try {
      const hits = queryFileIntents(shared(), PARENT);
      expect(hits.map((h) => h.sessionId)).toContain(SUB_A);
      expect(hits[0].parentSessionId).toBe(PARENT);
    } finally {
      clearFileIntent(SUB_A);
    }
  });

  it("旧形态对照：共用父 sessionId 时，排除「自己」把兄弟的声明整个吞掉（漏检根因）", () => {
    // PR-2 之前两个子代理的 tracker.sessionId 都是 PARENT：A 声明后 B 查询
    // 传 excludeSessionId=PARENT，命中的恰是"自己"这个键 → 零结果。
    declareFileIntent(PARENT, process.pid, home, shared(), "edit");
    try {
      expect(queryFileIntents(shared(), PARENT)).toEqual([]);
    } finally {
      clearFileIntent(PARENT);
    }
  });
});

describe("C2 — 意图文件互不覆盖", () => {
  it("两个子代理各自声明多个文件，两份意图文件独立且完整", () => {
    declareFileIntent(SUB_A, process.pid, home, shared(), "edit", PARENT);
    declareFileIntent(SUB_B, process.pid, home, join(home, "other.ts"), "write", PARENT);
    declareFileIntent(SUB_A, process.pid, home, join(home, "other.ts"), "read", PARENT);
    try {
      const all = queryAllFileIntents();
      expect(Object.keys(all[SUB_A].files).sort()).toEqual(
        [shared(), join(home, "other.ts")].sort(),
      );
      expect(Object.keys(all[SUB_B].files)).toEqual([join(home, "other.ts")]);
      expect(all[SUB_A].parentSessionId).toBe(PARENT);
      expect(all[SUB_B].parentSessionId).toBe(PARENT);
    } finally {
      clearFileIntent(SUB_A);
      clearFileIntent(SUB_B);
    }
  });

  it("归属只写不清：后续声明不带 parentSessionId 也不抹掉已写入的归属", () => {
    declareFileIntent(SUB_A, process.pid, home, shared(), "edit", PARENT);
    declareFileIntent(SUB_A, process.pid, home, join(home, "other.ts"), "read");
    try {
      expect(queryAllFileIntents()[SUB_A].parentSessionId).toBe(PARENT);
    } finally {
      clearFileIntent(SUB_A);
    }
  });
});

describe("退出清理", () => {
  it("clearFileIntent(agentId) 只删子代理自己，父与兄弟不受影响", () => {
    declareFileIntent(PARENT, process.pid, home, shared(), "edit");
    declareFileIntent(SUB_A, process.pid, home, shared(), "edit", PARENT);
    declareFileIntent(SUB_B, process.pid, home, shared(), "edit", PARENT);

    clearFileIntent(SUB_A);
    const all = queryAllFileIntents();
    expect(all[SUB_A]).toBeUndefined();
    expect(all[SUB_B]).toBeDefined();
    expect(all[PARENT]).toBeDefined();
    clearFileIntent(SUB_B);
    clearFileIntent(PARENT);
  });
});

describe("tracker 透传", () => {
  it("applySessionContext 存 parentSessionId；主会话形态不设", () => {
    const sub = new FileReadTracker();
    sub.applySessionContext({
      sessionId: SUB_A,
      pid: process.pid,
      cwd: home,
      parentSessionId: PARENT,
    });
    expect(sub.sessionId).toBe(SUB_A);
    expect(sub.parentSessionId).toBe(PARENT);

    const main = new FileReadTracker();
    main.applySessionContext({ sessionId: PARENT, pid: process.pid, cwd: home });
    expect(main.parentSessionId).toBeUndefined();
  });
});

describe("冲突警告文案", () => {
  it("formatConflictWarning 对子代理冲突方标注归属父会话", () => {
    declareFileIntent(SUB_A, process.pid, home, shared(), "edit", PARENT);
    try {
      const report = checkConflict(shared(), SUB_B);
      const text = formatConflictWarning(report!);
      expect(text).toContain(`归属父会话 ${PARENT.slice(-8)}`);
    } finally {
      clearFileIntent(SUB_A);
    }
  });

  it("主会话冲突方不带归属标注（文案不回归）", () => {
    declareFileIntent(PARENT, process.pid, home, shared(), "edit");
    try {
      const text = formatConflictWarning(checkConflict(shared(), "pr2-other")!);
      expect(text).not.toContain("归属父会话");
    } finally {
      clearFileIntent(PARENT);
    }
  });
});

describe("接线防回归（源码断言，W17 同款手法）", () => {
  const root = join(import.meta.dir, "..", "..", "..", "..");

  it("sub-agent.ts 用 agentId 登记、传归属，两条执行路径的 finally 都清理", () => {
    const src = readFileSync(join(root, "packages/core/src/agent/sub-agent.ts"), "utf-8");
    // 登记：sessionId 用 agentId，parentSessionId 作归属
    expect(src).toContain("sessionId: agentId ?? this.parentSessionId");
    expect(src).not.toContain("sessionId: this.parentSessionId,");
    // 两个调用点都把 agentId 传进隔离注册表
    expect(src).toMatch(
      /buildIsolatedToolRegistry\(\s*filteredTools,\s*task\.type,\s*this\.deriveSubAgentSessionId\(taskId\),\s*\)/,
    );
    expect(src).toContain("buildIsolatedToolRegistry(resolvedTools, task.type, observerAgentId)");
    // 退出清理：execute() 与 executeCustom() 各一处
    expect(src).toContain("clearFileIntent(agentId)");
    expect(src).toContain("clearFileIntent(customAgentId)");
  });

  it("read/edit/write 三个工具的 declareFileIntent 都透传 tracker.parentSessionId", () => {
    for (const f of ["read.ts", "edit.ts", "write.ts"]) {
      const src = readFileSync(join(root, "packages/core/src/tool", f), "utf-8");
      expect(src).toContain("this.tracker.parentSessionId");
    }
  });
});
