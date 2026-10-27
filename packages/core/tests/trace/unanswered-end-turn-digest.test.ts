/**
 * 「未答复 end_turn」形态分布（UnansweredEndTurn 事件 → digest）。
 *
 * 此前形态只写在 warn.log 文本里，「是不是误报 / 哪种形态在涨」要逐个会话翻 raw.jsonl
 * （2026-10-26 两例就是这样排查的）。本文件锁两件事：聚合口径，以及 loop.ts 产出的
 * 事件名 / 字段名与 digest 读取的一致（源码字面量哨兵——任一侧改名本测试变红）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateUnansweredEndTurnStats,
  resolvePaths,
  listSessions,
  buildDigest,
  renderHuman,
  type DigestPaths,
} from "@sid-code/core/trace/digest.ts";

const ev = (data: Record<string, unknown>) => ({ event: "UnansweredEndTurn", data });

describe("aggregateUnansweredEndTurnStats", () => {
  test("无事件 → undefined（老会话不出这一节）", () => {
    expect(aggregateUnansweredEndTurnStats([{ event: "TurnComplete", data: {} }])).toBeUndefined();
  });

  test("按形态 / 模型计数，分母是命中次数；exhausted 单独计", () => {
    const s = aggregateUnansweredEndTurnStats([
      ev({ shape: "unparsed_tool_call", provider: "openai", model: "ds", exhausted: false }),
      ev({ shape: "unparsed_tool_call", provider: "openai", model: "ds", exhausted: true }),
      ev({ shape: "thinking_only", provider: "openai", model: "other", exhausted: false }),
      ev({}), // 字段缺失：外部数据不可信任形状，不得产出 NaN / 抛错
    ]);
    expect(s).toEqual({
      total: 4,
      byShape: { unparsed_tool_call: 2, thinking_only: 1, unknown: 1 },
      byModel: { "openai/ds": 2, "openai/other": 1, "?/?": 1 },
      exhausted: 1,
    });
  });
});

describe("事件契约：loop.ts 产出 ↔ digest 读取", () => {
  const REPO_ROOT = join(import.meta.dir, "../../../..");
  const loop = readFileSync(join(REPO_ROOT, "packages/core/src/query/loop.ts"), "utf8");
  test("loop.ts 以 digest 读取的事件名与字段名发射", () => {
    expect(loop).toContain('event: "UnansweredEndTurn"');
    for (const f of ["shape:", "exhausted,", "provider,", "model,"]) expect(loop).toContain(f);
  });
});

describe("digest 渲染", () => {
  let root: string;
  let paths: DigestPaths;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sid-unanswered-digest-"));
    mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
    paths = resolvePaths(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeSession(id: string, events: unknown[]) {
    const dir = join(root, "trajectories", "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.traj"),
      JSON.stringify({ trajectory: [], info: { exit_status: "submitted" } }),
    );
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  test("有事件时渲染形态与模型分布", () => {
    writeSession("ue1", [
      ev({ shape: "unparsed_tool_call", provider: "openai", model: "ds", exhausted: false }),
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    const out = renderHuman(d, { noColor: true });
    expect(out).toContain("未答复 end_turn: 1 次");
    expect(out).toContain("unparsed_tool_call=1");
    expect(out).toContain("openai/ds=1");
  });

  test("无事件时整节不渲染", () => {
    writeSession("ue2", [{ event: "SessionEnd", data: {} }]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.unansweredEndTurn).toBeUndefined();
    expect(renderHuman(d, { noColor: true })).not.toContain("未答复 end_turn:");
  });
});
