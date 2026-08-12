/**
 * scan-trajectory-secrets.ts 单测（B6-4）
 *
 * 覆盖：
 *  - classifyHits 三档判定：safe / needs_sanitization / unsafe_for_holdout
 *  - loadSplitTaskIds：仅保留 T 开头 task_id，过滤 trajectory sid（uuid）行 + 注释行
 *  - scanTask：task.yaml 不存在 → null；正常扫返回 result
 *  - renderReport：3 个 section 都生成、unsafe/sanitization 列表正确
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyHits,
  loadSplitTaskIds,
  scanTask,
  renderReport,
  type TaskScanResult,
} from "../../scripts/eval/scan-trajectory-secrets.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `bench-scan-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("classifyHits - 三档判定", () => {
  test("无任何命中 → safe", () => {
    expect(classifyHits([], [])).toBe("safe");
  });

  test("contamination 命中（任何一条）→ unsafe_for_holdout", () => {
    expect(classifyHits(["tool_result_content @line:5"], [])).toBe("unsafe_for_holdout");
  });

  test("private_key 命中 → unsafe_for_holdout", () => {
    expect(classifyHits([], [{ kind: "private_key", match: "-----BEGIN..." }])).toBe(
      "unsafe_for_holdout",
    );
  });

  test("api_key 命中 → unsafe_for_holdout", () => {
    expect(classifyHits([], [{ kind: "api_key", match: "sk-AAAA..." }])).toBe("unsafe_for_holdout");
  });

  test("仅 email 命中 → needs_sanitization", () => {
    expect(classifyHits([], [{ kind: "email", match: "a@b.com" }])).toBe("needs_sanitization");
  });

  test("仅 ip 命中 → needs_sanitization", () => {
    expect(classifyHits([], [{ kind: "ip", match: "127.0.0.1" }])).toBe("needs_sanitization");
  });

  test("混合 ip + private_key → unsafe_for_holdout（强 secret 优先）", () => {
    expect(
      classifyHits(
        [],
        [
          { kind: "ip", match: "127.0.0.1" },
          { kind: "private_key", match: "-----BEGIN..." },
        ],
      ),
    ).toBe("unsafe_for_holdout");
  });
});

describe("loadSplitTaskIds - 仅保留 T 开头的合法 task_id", () => {
  test("混合 task_id + sid + 注释 + 空行 → 只保留 T 开头", () => {
    const root = join(tmpRoot, "bench-mixed");
    mkdirSync(join(root, "bench", "splits"), { recursive: true });
    writeFileSync(
      join(root, "bench", "splits", "mixed.txt"),
      [
        "T0001",
        "# 注释行，应被过滤",
        "",
        "T0042",
        "3b1d0d73-151", // trajectory sid，应被过滤
        "T0099",
        "0d13d9de-49b",
      ].join("\n"),
      "utf-8",
    );
    const ids = loadSplitTaskIds(root, "mixed");
    expect(ids).toEqual(["T0001", "T0042", "T0099"]);
  });

  test("split 文件不存在 → 空数组", () => {
    expect(loadSplitTaskIds(tmpRoot, "nonexistent").length).toBe(0);
  });

  test("holdout 全是 sid → 0 个 task_id（不是 bug，是 split 设计）", () => {
    const root = join(tmpRoot, "bench-holdout-sid");
    mkdirSync(join(root, "bench", "splits"), { recursive: true });
    writeFileSync(
      join(root, "bench", "splits", "holdout.txt"),
      "3b1d0d73-151\n7c38afa1-3b8\n0d13d9de-49b",
      "utf-8",
    );
    expect(loadSplitTaskIds(root, "holdout").length).toBe(0);
  });
});

describe("scanTask - 单 task 扫描", () => {
  test("task.yaml 不存在 → null", () => {
    expect(scanTask(tmpRoot, "T9999", "test")).toBeNull();
  });

  test("clean task → status=safe", () => {
    const root = join(tmpRoot, "bench-clean");
    mkdirSync(join(root, "bench", "tasks", "T0001"), { recursive: true });
    writeFileSync(
      join(root, "bench", "tasks", "T0001", "task.yaml"),
      "id: T0001\ninstruction:\n  text: 修 bug\n",
      "utf-8",
    );
    const r = scanTask(root, "T0001", "capability")!;
    expect(r).not.toBeNull();
    expect(r.status).toBe("safe");
    expect(r.contamination_hits.length).toBe(0);
    expect(r.secret_hits.length).toBe(0);
  });

  test("含 contamination 字段 → status=unsafe_for_holdout", () => {
    const root = join(tmpRoot, "bench-cont");
    mkdirSync(join(root, "bench", "tasks", "T0002"), { recursive: true });
    writeFileSync(
      join(root, "bench", "tasks", "T0002", "task.yaml"),
      "id: T0002\ntool_result_content: 上一轮答案\n",
      "utf-8",
    );
    const r = scanTask(root, "T0002", "regression")!;
    expect(r.status).toBe("unsafe_for_holdout");
    expect(r.contamination_hits.length).toBeGreaterThan(0);
  });

  test("仅 ip → status=needs_sanitization", () => {
    const root = join(tmpRoot, "bench-ip");
    mkdirSync(join(root, "bench", "tasks", "T0003"), { recursive: true });
    writeFileSync(
      join(root, "bench", "tasks", "T0003", "task.yaml"),
      "id: T0003\ninstruction:\n  text: 连 203.0.113.7 验证服务\n",
      "utf-8",
    );
    const r = scanTask(root, "T0003", "regression")!;
    expect(r.status).toBe("needs_sanitization");
    expect(r.secret_hits.some((s) => s.kind === "ip")).toBe(true);
  });
});

describe("renderReport - markdown 报告生成", () => {
  test("混合状态报告含 3 个 section + 总览正确", () => {
    const results: TaskScanResult[] = [
      {
        task_id: "T0001",
        split: "capability",
        status: "safe",
        contamination_hits: [],
        secret_hits: [],
      },
      {
        task_id: "T0002",
        split: "capability",
        status: "needs_sanitization",
        contamination_hits: [],
        secret_hits: [{ kind: "ip", match: "127.0.0.1" }],
      },
      {
        task_id: "T0003",
        split: "regression",
        status: "unsafe_for_holdout",
        contamination_hits: ["tool_result_content @line:1"],
        secret_hits: [],
      },
    ];
    const report = renderReport(results);
    expect(report).toContain("# Trajectory-platform bench 脱敏二审报告");
    expect(report).toContain("## 1. 各 split 总览");
    expect(report).toContain("## 2. unsafe_for_holdout 详情");
    expect(report).toContain("## 3. needs_sanitization 详情");
    // 总览表行（capability 1 safe + 1 sanit / regression 1 unsafe）
    expect(report).toMatch(/\| capability \| 2 \| 1 \| 1 \| 0 \|/);
    expect(report).toMatch(/\| regression \| 1 \| 0 \| 0 \| 1 \|/);
    // 详情包含具体 task
    expect(report).toContain("T0003");
    expect(report).toContain("T0002");
    // 127.0.0.1 sample 出现
    expect(report).toContain("127.0.0.1");
  });

  test("全 safe 时，unsafe/sanitization section 渲染「（无）」", () => {
    const results: TaskScanResult[] = [
      { task_id: "T0001", split: "smoke", status: "safe", contamination_hits: [], secret_hits: [] },
    ];
    const report = renderReport(results);
    expect(report).toContain("（无）");
  });
});
