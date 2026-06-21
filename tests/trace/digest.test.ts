import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolvePaths,
  listSessions,
  resolveSession,
  buildDigest,
  renderHuman,
  renderList,
  type DigestPaths,
} from "../../src/trace/digest.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-digest-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** 写一个 session.traj 到 {root}/trajectories/sessions/{id}/ */
function writeSession(id: string, traj: unknown) {
  const dir = join(root, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.traj"), JSON.stringify(traj));
  return dir;
}

function normalSession(overrides: Record<string, unknown> = {}) {
  return {
    trajectory: [
      { message_type: "action", role: "assistant", tool_name: "read", tool_input: { file_path: "/a.ts" }, thought: "读文件" },
      { message_type: "observation", role: "user", content: "ok", is_error: false },
    ],
    info: { exit_status: "end_turn" },
    metadata: {
      session_id: "x",
      model: "test-model",
      exit_status: "end_turn",
      total_steps: 2,
      total_api_calls: 1,
      tools_used: ["read"],
      user_prompts: ["帮我读文件"],
      ...overrides,
    },
  };
}

describe("listSessions", () => {
  it("空目录返回空数组", () => {
    expect(listSessions(paths)).toEqual([]);
  });

  it("只收录有 session.traj 的目录,跳过隐藏目录", () => {
    writeSession("aaa11111", normalSession());
    writeSession("bbb22222", normalSession());
    mkdirSync(join(root, "trajectories", "sessions", ".hidden"), { recursive: true });
    mkdirSync(join(root, "trajectories", "sessions", "no-traj"), { recursive: true });
    const refs = listSessions(paths);
    expect(refs.map((r) => r.id).sort()).toEqual(["aaa11111", "bbb22222"]);
  });

  it("按 mtime 降序", () => {
    writeSession("old00000", normalSession());
    // 保证 mtime 有差异
    const dir2 = writeSession("new00000", normalSession());
    const future = Date.now() / 1000 + 100;
    require("fs").utimesSync(join(dir2, "session.traj"), future, future);
    const refs = listSessions(paths);
    expect(refs[0].id).toBe("new00000");
  });
});

describe("resolveSession", () => {
  function refs() {
    writeSession("abc12345", normalSession());
    writeSession("abd67890", normalSession());
    return listSessions(paths);
  }

  it("latest / 空参数取第一个", () => {
    const all = refs();
    expect(resolveSession(undefined, all).ref?.id).toBe(all[0].id);
    expect(resolveSession("latest", all).ref?.id).toBe(all[0].id);
  });

  it("精确 id 命中", () => {
    const all = refs();
    expect(resolveSession("abc12345", all).ref?.id).toBe("abc12345");
  });

  it("唯一前缀命中", () => {
    const all = refs();
    expect(resolveSession("abc", all).ref?.id).toBe("abc12345");
  });

  it("多前缀命中返回最近一个并给 warning", () => {
    const all = refs();
    const res = resolveSession("ab", all);
    expect(res.ref).not.toBeNull();
    expect(res.warning).toContain("命中");
  });

  it("无匹配返回 null", () => {
    const all = refs();
    expect(resolveSession("zzz", all).ref).toBeNull();
  });

  it("空列表返回 null", () => {
    expect(resolveSession("latest", []).ref).toBeNull();
  });
});

describe("buildDigest 异常检测", () => {
  it("正常会话:无异常信号", () => {
    writeSession("normal01", normalSession());
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.exitStatus).toBe("end_turn");
    expect(d.abnormal).toBe(false);
    expect(d.anomalies).toEqual([]);
    expect(d.toolSequence.length).toBe(1);
    expect(d.toolSequence[0].tool).toBe("read");
  });

  it("error 退出 → L0 事实 + L1 假设(带证伪条件)", () => {
    writeSession("err00001", normalSession({ exit_status: "error" }));
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.abnormal).toBe(true);
    // L0:exit_status_error 是带出处的纯事实
    const fact = d.anomalies.find((a) => a.kind === "exit_status_error");
    expect(fact?.layer).toBe("L0");
    expect(fact?.severity).toBe("high");
    expect(fact?.provenance?.length).toBeGreaterThan(0);
    // L1:运行时异常终止假设,必带 falsifier
    const hyp = d.anomalies.find((a) => a.kind === "hypothesis_runtime_abend");
    expect(hyp?.layer).toBe("L1");
    expect(hyp?.falsifier).toBeTruthy();
  });

  it("孤儿 tool_use → L0 客观计数 + L1 崩溃假设(带证伪条件)", () => {
    writeSession("orphan01", {
      trajectory: [
        { message_type: "action", tool_name: "read", tool_input: {} },
        { message_type: "observation", content: "[not found]", _orphan: true },
      ],
      metadata: { exit_status: "user_interrupt" },
    });
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "tool_use_without_result" && a.layer === "L0")).toBe(true);
    // fdb47f30 教训:崩溃判定降为 L1 假设,且证伪条件强制去查进程是否存活
    const hyp = d.anomalies.find((a) => a.kind === "hypothesis_crash_or_violation");
    expect(hyp?.layer).toBe("L1");
    expect(hyp?.falsifier).toContain("存活");
    expect(d.toolSequence[0].orphan).toBe(true);
  });

  it("工具失败 → 标记 isError 并产出 L0 事实", () => {
    writeSession("toolerr1", {
      trajectory: [
        { message_type: "action", tool_name: "bash", tool_input: { command: "x" } },
        { message_type: "observation", content: "command failed", is_error: true },
      ],
      metadata: { exit_status: "end_turn" },
    });
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.toolSequence[0].isError).toBe(true);
    expect(d.anomalies.some((a) => a.kind === "tool_result_is_error" && a.layer === "L0")).toBe(true);
  });

  it("连续同形状工具调用 ≥4 次 → L0 计数 + L1 循环假设(带证伪条件)", () => {
    const steps: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      steps.push({ message_type: "action", tool_name: "grep", tool_input: { pattern: "foo" } });
      steps.push({ message_type: "observation", content: "no match" });
    }
    writeSession("loop0001", { trajectory: steps, metadata: { exit_status: "end_turn" } });
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "repeated_tool_shape_run" && a.layer === "L0")).toBe(true);
    const hyp = d.anomalies.find((a) => a.kind === "hypothesis_stuck_loop");
    expect(hyp?.layer).toBe("L1");
    expect(hyp?.falsifier).toBeTruthy();
  });

  it("schema 漂移(缺 trajectory 和 metadata)→ 高优先级告警,不静默", () => {
    writeSession("badschem", { foo: "bar", baz: 123 });
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "schema_missing_core_keys" && a.severity === "high")).toBe(true);
  });

  it("损坏 JSON → buildDigest 返回 null", () => {
    const dir = join(root, "trajectories", "sessions", "broken01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "{ not valid json ");
    const all = listSessions(paths);
    expect(buildDigest(all[0], false, paths)).toBeNull();
  });
});

describe("buildDigest 成本归零(回归:不再 95% 误报)", () => {
  it("无 ledger 条目 → 不报成本归零", () => {
    writeSession("noledger", normalSession({ total_tokens_sent: 50000, total_cost_usd: 0 }));
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "ledger_cost_zero_with_tokens")).toBe(false);
  });

  it("有 ledger 且账本 costUSD=0 且非本地 → 才报成本归零(L0 事实 + L1 定价假设)", () => {
    writeSession("hasledg1", normalSession({ total_tokens_sent: 50000 }));
    writeFileSync(
      paths.ledgerPath,
      JSON.stringify({ sessionId: "hasledg1", model: "gpt", provider: "openai", costUSD: 0, durationMs: 1000 }) + "\n",
    );
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "ledger_cost_zero_with_tokens" && a.layer === "L0")).toBe(true);
    // fdb47f30 §11 教训:定价表缺失判定降为 L1 假设,证伪条件指向 grep 定价表
    const hyp = d.anomalies.find((a) => a.kind === "hypothesis_missing_pricing");
    expect(hyp?.layer).toBe("L1");
    expect(hyp?.falsifier).toBeTruthy();
  });

  it("本地 provider(ollama)costUSD=0 → 不报(本地本来免费)", () => {
    writeSession("localllm", normalSession({ total_tokens_sent: 50000 }));
    writeFileSync(
      paths.ledgerPath,
      JSON.stringify({ sessionId: "localllm", model: "qwen", provider: "ollama", costUSD: 0, durationMs: 1000 }) + "\n",
    );
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "ledger_cost_zero_with_tokens")).toBe(false);
  });
});

describe("渲染", () => {
  it("renderHuman 无颜色模式不含 ANSI 码", () => {
    writeSession("render01", normalSession());
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    const out = renderHuman(d, { noColor: true });
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("render01");
    expect(out).toContain("未检出异常信号");
  });

  it("renderHuman 默认带颜色", () => {
    writeSession("render02", normalSession({ exit_status: "error" }));
    const all = listSessions(paths);
    const d = buildDigest(all[0], false, paths)!;
    const out = renderHuman(d, { noColor: false });
    expect(out).toContain("\x1b[");
  });

  it("renderList 列出会话 + invocation 提示", () => {
    writeSession("listr001", normalSession());
    const all = listSessions(paths);
    const out = renderList(all, { noColor: true, invocation: "/trace" });
    expect(out).toContain("listr001");
    expect(out).toContain("/trace");
  });
});
