/**
 * 实测进展信号单元测试（P1-4 item 1）
 *
 * 对应验收（方案 §4.5 第 1 条）：
 *   todo 全为 pending 但本轮有 edit 落盘 → work-log **不得**输出"已完成 0 项"，须体现实测进展。
 *
 * ⚠ 落盘隔离：本文件调 persistProgress（写 ~/.sid-code/progress/），必须把 SID_CONFIG_DIR
 * 重定向到 tmpdir。**存/恢复原值，不无条件 delete**——bun test 同批多文件同进程，
 * 无条件删会把 tests/preload-isolate-sid-home.ts 的兜底一起抹掉，
 * 后续测试文件会直接写用户真实家目录（见 CONTRIBUTING.md「测试约定」坑 1）。
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createMeasuredProgressState,
  recordFileChange,
  recordScalarObservation,
  extractScalarMetric,
  hasRealProgress,
  changedMetrics,
  describeMeasuredProgress,
  FILE_MUTATING_TOOLS,
  MAX_LISTED_FILES,
} from "@sid-code/core/query/measured-progress.ts";
import {
  snapshotFromTodos,
  renderProgressMarkdown,
  buildProgressReminder,
  persistProgress,
  progressFilePath,
} from "@sid-code/core/query/work-log.ts";
import { getSidHome } from "@sid-code/core/config/paths.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

const ENV_KEY = "SID_CONFIG_DIR";
let originalConfigDir: string | undefined;

beforeAll(() => {
  originalConfigDir = process.env[ENV_KEY];
  process.env[ENV_KEY] = mkdtempSync(join(tmpdir(), "sid-measured-progress-"));
});

afterAll(() => {
  // 存在则还原，不存在则删除——不能无条件 delete（会抹掉 preload 兜底）。
  if (originalConfigDir === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalConfigDir;
});

function todo(content: string, status: TodoItem["status"]): TodoItem {
  return { content, activeForm: `正在${content}`, status };
}

describe("extractScalarMetric — 只认单标量输出", () => {
  it("纯数字输出可解析", () => {
    expect(extractScalarMetric("139")).toBe(139);
    expect(extractScalarMetric("  113\n")).toBe(113);
    expect(extractScalarMetric("0")).toBe(0);
  });

  it("wc -l 风格（数字 + 无数字尾巴）可解析", () => {
    expect(extractScalarMetric("      12 /tmp/e.txt")).toBe(12);
  });

  it("多值输出不解析（取哪个都可能错）", () => {
    // "Found 139 errors in 34 files" 有两个数，刻意不猜。
    expect(extractScalarMetric("Found 139 errors in 34 files")).toBeNull();
    expect(extractScalarMetric("139 /tmp/a2.txt")).toBeNull();
  });

  it("多行输出不解析（本身已含可执行信息）", () => {
    expect(
      extractScalarMetric("src/a.ts(1,2): error TS2322\nsrc/b.ts(3,4): error TS2345"),
    ).toBeNull();
  });

  it("空输出与 bash 空输出哨兵都不解析", () => {
    expect(extractScalarMetric("")).toBeNull();
    expect(extractScalarMetric("   ")).toBeNull();
    expect(extractScalarMetric("(命令无输出)")).toBeNull();
  });
});

describe("MeasuredProgressState — 进展判据", () => {
  it("空状态无进展", () => {
    expect(hasRealProgress(createMeasuredProgressState())).toBe(false);
    expect(hasRealProgress(undefined)).toBe(false);
  });

  it("有文件落盘即为有进展", () => {
    const s = createMeasuredProgressState();
    recordFileChange(s, "/repo/src/a.ts");
    expect(hasRealProgress(s)).toBe(true);
    expect(s.filesChanged.size).toBe(1);
  });

  it("同一文件重复改动只计一次；非字符串路径忽略", () => {
    const s = createMeasuredProgressState();
    recordFileChange(s, "/repo/src/a.ts");
    recordFileChange(s, "/repo/src/a.ts");
    recordFileChange(s, undefined);
    recordFileChange(s, "  ");
    expect(s.filesChanged.size).toBe(1);
  });

  it("观测值恒定不算进展，变化才算（139 ×N → 仍无进展；降到 113 → 有进展）", () => {
    const s = createMeasuredProgressState();
    const cmd = 'bunx tsc --noEmit 2>&1 | grep -c "error TS"';
    // 事故里的真实序列：139 连续 22 次。
    for (let i = 0; i < 22; i++) recordScalarObservation(s, cmd, "139");
    expect(hasRealProgress(s)).toBe(false);
    expect(s.metrics.get(cmd)!.count).toBe(22);

    recordScalarObservation(s, cmd, "113");
    expect(hasRealProgress(s)).toBe(true);
    const changed = changedMetrics(s);
    expect(changed).toHaveLength(1);
    expect(changed[0].first).toBe(139);
    expect(changed[0].last).toBe(113);
  });

  it("方向不做价值判断——观测值升高同样算「世界变了」", () => {
    // 刻意不判定"降了才是进展"：错误数升高可能是新增测试暴露出来的真实推进，
    // harness 不替模型下价值判断，只如实报告变化。
    const s = createMeasuredProgressState();
    recordScalarObservation(s, "cnt", "10");
    recordScalarObservation(s, "cnt", "42");
    expect(hasRealProgress(s)).toBe(true);
    expect(describeMeasuredProgress(s)[0]).toContain("10 → 42");
  });

  it("不可解析的输出不产生指标（不硬编码任何具体命令名）", () => {
    const s = createMeasuredProgressState();
    recordScalarObservation(s, "some-cmd", "Found 139 errors in 34 files");
    expect(s.metrics.size).toBe(0);
    expect(hasRealProgress(s)).toBe(false);
  });

  it("todo_write 不属于文件落盘工具（否则退化回「只数 todo」）", () => {
    expect(FILE_MUTATING_TOOLS.has("edit")).toBe(true);
    expect(FILE_MUTATING_TOOLS.has("write")).toBe(true);
    expect(FILE_MUTATING_TOOLS.has("notebook_edit")).toBe(true);
    expect(FILE_MUTATING_TOOLS.has("todo_write")).toBe(false);
    // bash 无法从工具名判定是否写盘，宁可漏报不误报。
    expect(FILE_MUTATING_TOOLS.has("bash")).toBe(false);
  });

  it("文件列表超上限时截断并注明剩余数量", () => {
    const s = createMeasuredProgressState();
    for (let i = 0; i < MAX_LISTED_FILES + 3; i++) recordFileChange(s, `/repo/f${i}.ts`);
    const desc = describeMeasuredProgress(s).join("\n");
    expect(desc).toContain(`已落盘改动 ${MAX_LISTED_FILES + 3} 个文件`);
    expect(desc).toContain("另有 3 个");
  });
});

describe("§4.5 验收 1 — todo 全 pending + 有 edit 落盘时不得报「已完成 0 项」", () => {
  const allPending: TodoItem[] = [
    todo("修复 Color 类型问题", "pending"),
    todo("修复测试 Tool 类型", "pending"),
  ];

  /** 复刻事故现场：7 个文件已落盘 + 观测值 139→113，而 todo 一项都没标 completed。 */
  function incidentState() {
    const s = createMeasuredProgressState();
    for (let i = 0; i < 7; i++) recordFileChange(s, `/repo/src/ui/f${i}.ts`);
    const cmd = 'bunx tsc --noEmit 2>&1 | grep -c "error TS"';
    recordScalarObservation(s, cmd, "139");
    recordScalarObservation(s, cmd, "113");
    return s;
  }

  it("回注文案体现实测进展，且不出现「已完成 0 项」这个假信号", () => {
    const snap = snapshotFromTodos("acc-1", allPending, [], incidentState());
    const reminder = buildProgressReminder(snap)!;

    // 核心断言：旧版必然输出的这句假信号不得再出现。
    expect(reminder).not.toContain("已完成 0 项");
    // 必须体现两个维度的实测进展。
    expect(reminder).toContain("实测进展");
    expect(reminder).toContain("已落盘改动 7 个文件");
    expect(reminder).toContain("139 → 113");
    // 必须点破"标记数为 0 不等于没进展"，否则模型会把矛盾当成上下文错乱。
    expect(reminder).toContain("不代表你没有进展");
    // 清单标记仍如实呈现（不伪造 todo 状态），待办也不丢。
    expect(reminder).toContain("清单标记");
    expect(reminder).toContain("仍待办 2 项");
  });

  it("防幻觉文案（不要臆造新工作）必须保留", () => {
    const snap = snapshotFromTodos("acc-1b", allPending, [], incidentState());
    const reminder = buildProgressReminder(snap)!;
    expect(reminder).toContain("todo_write");
    expect(reminder).toContain("臆造");
  });

  it("无实测进展时回退到原行为（不凭空说有进展）", () => {
    const snap = snapshotFromTodos("acc-2", allPending, [], createMeasuredProgressState());
    const reminder = buildProgressReminder(snap)!;
    expect(reminder).not.toContain("实测进展");
    expect(reminder).not.toContain("不代表你没有进展");
    expect(reminder).toContain("已完成 0 项");
  });

  it("不传 measured 时与改动前完全兼容", () => {
    const reminder = buildProgressReminder(snapshotFromTodos("acc-3", allPending))!;
    expect(reminder).toContain("已完成 0 项");
    expect(reminder).not.toContain("实测进展");
  });

  it("无待办时仍返回 null（不改变原有短路语义）", () => {
    const done = [todo("x", "completed")];
    expect(buildProgressReminder(snapshotFromTodos("acc-4", done, [], incidentState()))).toBeNull();
  });

  it("落盘 markdown 同样体现实测进展（第二处渲染，跨会话读的就是它）", () => {
    const sid = "acc-persist";
    const snap = snapshotFromTodos(sid, allPending, [], incidentState());
    const md = renderProgressMarkdown(snap);
    expect(md).toContain("## 实测进展（真实副作用，不依赖清单标记）");
    expect(md).toContain("已落盘改动 7 个文件");
    expect(md).toContain("139 → 113");
    // 旧版这里会渲染成 "总进度：0 已完成 / 2 待办" + "## 已完成\n- （暂无）"
    expect(md).not.toContain("总进度：0 已完成");
    expect(md).toContain("只是未同步清单");

    // 真落一次盘，确认写进的是 tmpdir 而不是用户真实家目录。
    expect(persistProgress(snap)).toBe(true);
    const fp = progressFilePath(sid);
    expect(fp.startsWith(getSidHome())).toBe(true);
    expect(fp).toContain(process.env[ENV_KEY]!);
    expect(existsSync(fp)).toBe(true);
    expect(readFileSync(fp, "utf-8")).toContain("139 → 113");
  });
});
