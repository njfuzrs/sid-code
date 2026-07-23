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

  it("缺陷2:同时间戳并行 fan-out 的 4 个 sub_agent 不报 stuck_loop", () => {
    // 复刻真实场景:把任务切成 4 份同时派发 4 个子代理,派发时间戳几乎一致(< 1s 窗口)。
    // 这是合法并行编排,不是"一个做完再做下一个"的串行空转,不应触发循环假设。
    const ts = "2026-07-23T02:15:34.985Z";
    const steps: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      steps.push({ message_type: "action", tool_name: "sub_agent", tool_input: { prompt: "你是代码审计子代理" }, timestamp: ts });
      steps.push({ message_type: "observation", content: "结论", is_error: false });
    }
    writeSession("para0001", { trajectory: steps, metadata: { exit_status: "end_turn" } });
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "repeated_tool_shape_run")).toBe(false);
    expect(d.anomalies.some((a) => a.kind === "hypothesis_stuck_loop")).toBe(false);
  });

  it("缺陷2:间隔秒级(串行空转)的同形状调用仍报 stuck_loop", () => {
    // 每个调用间隔一次完整 LLM 往返(> 1s 窗口),是真串行,应保留循环告警。
    const steps: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const ts = new Date(Date.parse("2026-07-23T02:15:34.000Z") + i * 5000).toISOString();
      steps.push({ message_type: "action", tool_name: "grep", tool_input: { pattern: "foo" }, timestamp: ts });
      steps.push({ message_type: "observation", content: "no match", is_error: false });
    }
    writeSession("serial02", { trajectory: steps, metadata: { exit_status: "end_turn" } });
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.anomalies.some((a) => a.kind === "repeated_tool_shape_run")).toBe(true);
    expect(d.anomalies.some((a) => a.kind === "hypothesis_stuck_loop")).toBe(true);
  });

  it("缺陷3:成功但内容含 error/failed 关键词的读取不标 ✗(只信任 is_error)", () => {
    // 读一个正文里恰好出现 "error"/"failed" 的源码文件,tool_result is_error=false → 成功。
    // 旧版关键词启发式会误标 ✗,现已移除。
    writeSession("falsex01", {
      trajectory: [
        { message_type: "action", tool_name: "read", tool_input: { file_path: "/loop.ts" } },
        { message_type: "observation", content: "function handleError() { throw failed exception }", is_error: false },
      ],
      metadata: { exit_status: "end_turn" },
    });
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.toolSequence[0].isError).toBe(false);
    expect(d.anomalies.some((a) => a.kind === "tool_result_is_error")).toBe(false);
  });

  it("缺陷3:截断读取(带'文件已截断'提示、is_error=false)不标 ✗", () => {
    writeSession("trunc001", {
      trajectory: [
        { message_type: "action", tool_name: "read", tool_input: { file_path: "/big.ts" } },
        { message_type: "observation", content: "...\n\n[文件已截断：当前显示第 1435-1489 行，共 2950 行。]", is_error: false },
      ],
      metadata: { exit_status: "end_turn" },
    });
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.toolSequence[0].isError).toBe(false);
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

describe("buildDigest 子代理 section (§9.6)", () => {
  /** 写 events.jsonl 到 session 目录 */
  function writeEvents(dir: string, events: unknown[]) {
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  /** 造一条 SubagentStart 事件 */
  function startEvt(ts: string, agentId: string, agentType: string, description?: string) {
    return {
      event: "SubagentStart",
      session_id: "x",
      timestamp: ts,
      cwd: "/tmp",
      data: { agent_id: agentId, agent_type: agentType, description: description ?? null },
    };
  }

  /** 造一条 SubagentStop 事件 */
  function stopEvt(ts: string, agentId: string, status: "completed" | "error" | "unknown", extra: Record<string, unknown> = {}) {
    return {
      event: "SubagentStop",
      session_id: "x",
      timestamp: ts,
      cwd: "/tmp",
      data: { agent_id: agentId, status, ...extra },
    };
  }

  it("无子代理事件时 subAgents 为 undefined", () => {
    writeSession("nosub001", normalSession());
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.subAgents).toBeUndefined();
  });

  it("4 个串行子代理（评估报告场景）→ 判定 serial + 留间隔铁证 + 成败正确", () => {
    const dir = writeSession("serial01", normalSession({ has_sub_agent: true }));
    // 复刻报告 §8.4 真实时间戳：120s 一个、相邻 3ms/1ms/2ms 排队
    writeEvents(dir, [
      startEvt("2026-06-30T11:55:40.347Z", "subagent-explore-a1", "explore", "深挖 tool-executor 串行根因"),
      stopEvt("2026-06-30T11:57:40.352Z", "subagent-explore-a1", "error", { elapsed_ms: 120005, turns: 5 }),
      startEvt("2026-06-30T11:57:40.355Z", "subagent-explore-a2", "explore"),
      stopEvt("2026-06-30T11:59:40.356Z", "subagent-explore-a2", "error"),
      startEvt("2026-06-30T11:59:40.357Z", "subagent-explore-a3", "explore"),
      stopEvt("2026-06-30T12:01:40.359Z", "subagent-explore-a3", "error"),
      startEvt("2026-06-30T12:01:40.361Z", "subagent-explore-a4", "explore"),
      stopEvt("2026-06-30T12:03:40.362Z", "subagent-explore-a4", "completed"),
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.subAgents).toBeDefined();
    const sa = d.subAgents!;
    expect(sa.total).toBe(4);
    expect(sa.succeeded).toBe(1);
    expect(sa.failed).toBe(3);
    expect(sa.concurrency).toBe("serial");
    // 相邻间隔 3ms/1ms/2ms 应作为铁证留下
    expect(sa.serialEvidence).toContain("3ms");
    expect(sa.serialEvidence).toContain("1ms");
    // 描述被携带
    expect(sa.spans[0].description).toContain("串行根因");
    // 串行 + 失败均产出异常信号
    const kinds = d.anomalies.map((a) => a.kind);
    expect(kinds).toContain("subagent_serial_execution");
    expect(kinds).toContain("subagent_execution_outcome");
    expect(kinds).toContain("hypothesis_missing_concurrency_safe");
    // 渲染包含子代理 section
    const out = renderHuman(d, { noColor: true });
    expect(out).toContain("子代理执行");
    expect(out).toContain("串行");
  });

  it("时间重叠的子代理 → 判定 parallel，不误报串行异常", () => {
    const dir = writeSession("parallel01", normalSession({ has_sub_agent: true }));
    // 三个几乎同时启动、执行区间互相重叠
    writeEvents(dir, [
      startEvt("2026-06-30T12:00:00.000Z", "p1", "explore"),
      startEvt("2026-06-30T12:00:00.010Z", "p2", "explore"),
      startEvt("2026-06-30T12:00:00.020Z", "p3", "explore"),
      stopEvt("2026-06-30T12:00:30.000Z", "p1", "completed"),
      stopEvt("2026-06-30T12:00:31.000Z", "p2", "completed"),
      stopEvt("2026-06-30T12:00:32.000Z", "p3", "completed"),
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    const sa = d.subAgents!;
    expect(sa.total).toBe(3);
    expect(sa.succeeded).toBe(3);
    expect(sa.concurrency).toBe("parallel");
    expect(d.anomalies.map((a) => a.kind)).not.toContain("subagent_serial_execution");
  });

  it("缺 agent_id 的旧轨迹 → 回退到时序配对", () => {
    const dir = writeSession("legacy01", normalSession({ has_sub_agent: true }));
    writeEvents(dir, [
      { event: "SubagentStart", session_id: "x", timestamp: "2026-06-30T12:00:00.000Z", cwd: "/tmp", data: { agent_type: "explore" } },
      { event: "SubagentStop", session_id: "x", timestamp: "2026-06-30T12:00:10.000Z", cwd: "/tmp", data: { status: "completed" } },
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    const sa = d.subAgents!;
    expect(sa.total).toBe(1);
    expect(sa.succeeded).toBe(1);
    expect(sa.concurrency).toBe("single");
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
