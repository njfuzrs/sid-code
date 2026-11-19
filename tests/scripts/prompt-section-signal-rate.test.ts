/**
 * `scripts/prompt-section-signal-rate.ts` —— D-11 第一步度量口径的回归测试
 *
 * ## 这个文件在防什么
 *
 * 度量脚本算错了**没人会发现**，只会有人照抄数字去决定「哪一段改成条件注入」。
 * 所以断言分两类：
 *
 * A) **计数正确性**：喂构造轨迹，断言每段信号算出的数与手数一致；
 * B) **口径正确性**：定义不出信号的段必须是 `null`（不可度量），
 *    渲染时必须显式写「不可度量」而**不得**退化成 0。
 *
 * 两条口径错法都很顺理成章，因此都要有断言锁住：
 * 1. 零触发 = 没有信号 → 下一步删段；而"不可度量"其实是"没量"，删段就是删掉一段
 *    可能正在起作用的规则。报告里两者必须长得不一样。
 * 2. 弱信号（write 次数）不标注就会被当成与强信号同档的证据直接下结论。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  KNOWN_FLAGS,
  SIGNALS,
  computeRows,
  renderRows,
  scanEvents,
  selfTest,
  type ScanContext,
} from "../../scripts/prompt-section-signal-rate.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "prompt-section-signal-rate.ts");

function emptyCtx(): ScanContext {
  return { toolCalls: new Map(), bashCommands: [], readPaths: [], writePaths: [] };
}

const bySection = (rows: ReturnType<typeof computeRows>, s: string) =>
  rows.find((r) => r.section === s);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sid-section-signal-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 造一个会话目录，events 逐行写进 events.jsonl */
function plantSession(id: string, events: unknown[], mtimeSec?: number): string {
  const dir = join(tmpDir, id);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "events.jsonl");
  writeFileSync(
    p,
    events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n",
  );
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  return dir;
}

const pre = (tool: string, summary: Record<string, unknown> = {}) => ({
  event: "PreToolUse",
  data: { tool_name: tool, input_summary: summary },
});

describe("计数正确性", () => {
  test("从真实目录形态（<sessionsDir>/<id>/events.jsonl）扫出各段计数", () => {
    plantSession("s1", [
      pre("cron_create"),
      pre("schedule_wakeup"),
      pre("cron_list"),
      pre("cron_delete"),
      pre("monitor"),
      pre("bash", { command: "sid-wait gh-pr 42" }),
      pre("bash", { command: "ls" }),
      pre("read", { file_path: "/home/u/.sid-code/tasks/call_ab12.output" }),
      pre("read", { file_path: "/tmp/plain.output" }),
      pre("write", { file_path: "/tmp/a.md" }),
      // 非 PreToolUse 不计；坏行跳过
      {
        event: "PostToolUse",
        data: { tool_name: "bash", input_summary: { command: "sid-wait x" } },
      },
      "{bad json",
    ]);

    const rows = computeRows(scanEvents(tmpDir));
    expect(bySection(rows, "<scheduling-capability>")?.count).toBe(4);
    expect(bySection(rows, "<waiting-capability>")?.count).toBe(2);
    expect(bySection(rows, "<subagent-result-policy>")?.count).toBe(1);
    expect(bySection(rows, "<context-management>")?.count).toBe(1);
  });

  test("时间窗：早于 since 的会话不被计入（否则「近 30 天」实际是「全部历史」）", () => {
    const oldSec = Math.floor(Date.now() / 1000) - 40 * 24 * 3600;
    const freshSec = Math.floor(Date.now() / 1000) - 1 * 24 * 3600;
    plantSession("old", [pre("cron_create")], oldSec);
    plantSession("fresh", [pre("cron_create"), pre("cron_create")], freshSec);

    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const rows = computeRows(scanEvents(tmpDir, since));
    expect(bySection(rows, "<scheduling-capability>")?.count).toBe(2);
  });

  test("目录不存在时返回零计数而不是抛错", () => {
    const rows = computeRows(scanEvents(join(tmpDir, "nope")));
    expect(bySection(rows, "<scheduling-capability>")?.count).toBe(0);
  });
});

describe("口径正确性：不可度量不得退化成 0", () => {
  test("定义不出信号的段 count 是 null，且渲染里显式写「不可度量」", () => {
    const rows = computeRows(emptyCtx());
    const unmeasurable = SIGNALS.filter((s) => s.count(emptyCtx()) === null).map((s) => s.section);
    // 至少要有身份段这种确实定义不出信号的段，否则这条断言是空转
    expect(unmeasurable.length).toBeGreaterThan(0);

    const text = renderRows(rows).join("\n");
    for (const section of unmeasurable) {
      expect(bySection(rows, section)?.count).toBeNull();
      const start = text.indexOf(`■ ${section}`);
      expect(start).toBeGreaterThan(-1);
      const rest = text.slice(start + 1);
      const nextIdx = rest.indexOf("\n■ ");
      const block = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
      expect(block).toContain("不可度量");
      expect(block).not.toContain("计数：0");
    }
  });

  test("弱信号在渲染里被标注为需抽检（不得与强信号同档展示）", () => {
    const text = renderRows(computeRows(emptyCtx())).join("\n");
    expect(text).toMatch(/■ <context-management>[\s\S]*?需抽检/);
    // 强信号不应被误标
    const sched = text.slice(text.indexOf("■ <scheduling-capability>"));
    const block = sched.slice(0, sched.indexOf("\n■ ", 2));
    expect(block).not.toContain("需抽检");
  });
});

describe("--self-test", () => {
  test("内置合成轨迹自测全绿", () => {
    expect(selfTest()).toEqual([]);
  });

  test("子进程跑 --self-test 退出码 0（CI 走这条）", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, "--self-test"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("self-test 通过");
  });

  test("--self-test 不读真实轨迹：SID_CONFIG_DIR 指向空目录也照样通过", () => {
    const empty = mkdtempSync(join(tmpdir(), "sid-empty-home-"));
    try {
      const r = spawnSync(process.execPath, [SCRIPT_PATH, "--self-test"], {
        encoding: "utf8",
        env: { ...process.env, SID_CONFIG_DIR: empty },
      });
      expect(r.status).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("CLI 参数", () => {
  test("未识别参数早退并报错（不静默忽略）", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, "--nonsense"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("未识别参数");
  });

  test("KNOWN_FLAGS 覆盖实际用到的 flag", () => {
    expect([...KNOWN_FLAGS].sort()).toEqual(["--days", "--dir", "--json", "--self-test"]);
  });

  test("--days 非正数时报错", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, "--days", "0"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--days");
  });
});
