/**
 * `scripts/verify-monitor.ts` —— monitor 缺陷自动化验收脚本的纯函数单测
 *
 * ## 这个文件在防什么
 *
 * 该脚本是 D1-b / D2 / D3 / D4 的验收判据：它算错了没人会发现，只会有人照着结论说
 * 「修好了」或「没修好」。四类断言（对应修复方案 §7.4 的口径）：
 *
 * A) `filterMonitorPids` 必须排除无头宿主——宿主 argv 里带着 prompt，prompt 里带着
 *    带 token 的监控命令，漏掉某一种宿主形态（二进制四名 / `bun` `node` 直跑源码），
 *    「monitor 子进程为空」这条断言就会恒假或被污染；
 * B) `scanMonitorEvents` 的终态判据不能只看 completed：退出路径上 `TaskLifecycle{completed}`
 *    与 `WaitReleased` 是两条独立事件，漏一条就会把「修了一半」判成 PASS；
 * C) `parseWaitAuditOutput` 读不到字段时必须返回 null（调用方据此判 INVALID），
 *    默认 0 会把「脚本没跑起来」算成「monitor 没有事件」——这正是 D2 的形态；
 * D) `analyzeDiscovery` 必须跳过 observation：`tool_search` 的**返回**里含 "monitor"，
 *    把它算成「模型提到 monitor」会假阳性。
 *
 * 夹具全部按真实轨迹的字段形状裁剪（字段名与 `events.jsonl` / `session.traj` 一致），
 * 不做合成简化——合成夹具与真实渲染漂移，正是 D2 单测全绿而生产口径恒为 0 的成因。
 */

import { describe, expect, test } from "bun:test";
import {
  ALL_CASES,
  analyzeDiscovery,
  analyzeWakeupTurn,
  buildChecksSimScript,
  collectMonitorEvents,
  countForegroundPolls,
  filterMonitorPids,
  findOrphanCleanupLog,
  makeToken,
  parseArgs,
  parseWaitAuditOutput,
  scanMonitorEvents,
  verdictOf,
  type TrajStep,
  type TraceEvent,
} from "../../scripts/verify-monitor.ts";

const TOKEN = "VERIFY1762700000000D1bsignal";

/** 真实 `ps -Ao pid=,command=` 的形状：前面有 padding，command 里带整条 argv */
function psLine(pid: number, command: string): string {
  return `  ${pid} ${command}`;
}

describe("filterMonitorPids · 从 ps 输出里挑 monitor 子进程", () => {
  const monitor = psLine(
    81001,
    `bash -c for i in $(seq 1 200); do echo ${TOKEN}-$i; sleep 1; done`,
  );

  test("保留真正的 monitor 子进程", () => {
    expect(filterMonitorPids([monitor].join("\n"), TOKEN)).toEqual([81001]);
  });

  test("排除四个宿主二进制名（sid-code / sid-code-dev / sc / sc-dev 的 -p 形态）", () => {
    const hosts = [
      psLine(
        90001,
        `./sid-code -p --dangerously-skip-permissions 用 tool_search 激活 monitor：${TOKEN}`,
      ),
      psLine(90002, `/Users/x/sid-code-dev -p --dangerously-skip-permissions ${TOKEN}`),
      psLine(90003, `sc -p --dangerously-skip-permissions ${TOKEN}`),
      psLine(90004, `sc-dev -p --dangerously-skip-permissions ${TOKEN}`),
    ];
    const out = filterMonitorPids([monitor, ...hosts].join("\n"), TOKEN);
    // 只留下 monitor 自己；漏排任何一个宿主都会把宿主算成「残留子进程」
    expect(out).toEqual([81001]);
  });

  test("排除 --binary 指向任意文件名的宿主（按 argv 形态，不靠二进制名）", () => {
    // FIX-1 端到端变异自证实测：`sid-code-mutC -p` 不匹配二进制名正则，宿主被算成
    // 「monitor 仍存活」，D1b-orphan-scan-negative 的误杀断言因此假通过
    const hosts = [
      psLine(90011, `/tmp/fix1-mut/sid-code-mutC -p --dangerously-skip-permissions ${TOKEN}`),
      psLine(90012, `/opt/build/my-agent -p --dangerously-skip-permissions 监控 ${TOKEN}`),
    ];
    expect(filterMonitorPids([monitor, ...hosts].join("\n"), TOKEN)).toEqual([81001]);
  });

  test("排除 bun / node 直跑源码的宿主形态", () => {
    const lines = [
      monitor,
      psLine(
        90005,
        `bun run packages/cli/src/entrypoints/bootstrap.ts -p --dangerously-skip-permissions ${TOKEN}`,
      ),
      psLine(
        90006,
        `node packages/cli/src/entrypoints/bootstrap.ts -p --dangerously-skip-permissions ${TOKEN}`,
      ),
    ];
    expect(filterMonitorPids(lines.join("\n"), TOKEN)).toEqual([81001]);
  });

  test("命令行不含 token 的进程一律忽略（D4 的写循环进程属于这一类）", () => {
    const lines = [monitor, psLine(90007, "bash /tmp/sid-verify-abc/writer.sh"), ""];
    expect(filterMonitorPids(lines.join("\n"), TOKEN)).toEqual([81001]);
  });

  test("首列不是数字的行忽略（ps 表头 / 坏行），不抛错", () => {
    const lines = [" PID COMMAND", `  notapid bash -c ${TOKEN}`, monitor];
    expect(filterMonitorPids(lines.join("\n"), TOKEN)).toEqual([81001]);
  });

  test("空输出返回空数组", () => {
    expect(filterMonitorPids("", TOKEN)).toEqual([]);
  });
});

describe("scanMonitorEvents · monitor 的生命周期事件", () => {
  /** 真实 events.jsonl 的形状（字段照抄 20261109-223949-b177b927 会话） */
  const started: TraceEvent = {
    event: "TaskLifecycle",
    timestamp: "2026-11-09T14:39:56.424Z",
    data: { task_id: "mgwcch9os", task_type: "local_monitor", phase: "started", status: "running" },
  };
  const registered: TraceEvent = {
    event: "WaitRegistered",
    timestamp: "2026-11-09T14:39:56.424Z",
    data: {
      id: "mgwcch9os",
      kind: "monitor",
      promise_kind: "deadline",
      deadline_ms: 1794235216423,
    },
  };
  const completed: TraceEvent = {
    event: "TaskLifecycle",
    timestamp: "2026-11-09T14:40:01.467Z",
    data: {
      task_id: "mgwcch9os",
      task_type: "local_monitor",
      phase: "completed",
      status: "completed",
      exit_code: 0,
    },
  };
  const released: TraceEvent = {
    event: "WaitReleased",
    timestamp: "2026-11-09T14:40:01.468Z",
    data: { id: "mgwcch9os", kind: "monitor", reason: "terminal", held_ms: 5045 },
  };

  test("完整一生：started + registered + completed + released", () => {
    expect(scanMonitorEvents([started, registered, completed, released])).toEqual({
      started: true,
      registered: true,
      completed: true,
      completedStatus: "completed",
      released: true,
    });
  });

  test("D1 的泄漏形态：只有 started + registered（没有终态）", () => {
    const scan = scanMonitorEvents([started, registered]);
    expect(scan.started).toBe(true);
    expect(scan.registered).toBe(true);
    expect(scan.completed).toBe(false);
    expect(scan.released).toBe(false);
  });

  test("只有 completed 没有 WaitReleased 不算终态齐全（两条事件独立断言）", () => {
    const scan = scanMonitorEvents([started, registered, completed]);
    expect(scan.completed).toBe(true);
    expect(scan.released).toBe(false);
  });

  test("杀掉的终态带 status=killed（退出路径的期望值）", () => {
    const killed: TraceEvent = {
      event: "TaskLifecycle",
      timestamp: "2026-11-09T14:54:24.000Z",
      data: {
        task_id: "m2uy8n7sp",
        task_type: "local_monitor",
        phase: "completed",
        status: "killed",
      },
    };
    const scan = scanMonitorEvents([
      started,
      registered,
      killed,
      { ...released, data: { id: "m2uy8n7sp", kind: "monitor", reason: "terminal", held_ms: 1 } },
    ]);
    expect(scan.completed).toBe(true);
    expect(scan.completedStatus).toBe("killed");
    expect(scan.released).toBe(true);
  });

  test("非 monitor 任务的事件不参与判定（shell / agent 的同名事件不误命中）", () => {
    const shellStarted: TraceEvent = {
      event: "TaskLifecycle",
      data: { task_id: "s1", task_type: "local_shell", phase: "started", status: "running" },
    };
    const wakeupReleased: TraceEvent = {
      event: "WaitReleased",
      data: { id: "w1", kind: "wakeup", reason: "terminal", held_ms: 1 },
    };
    const scan = scanMonitorEvents([shellStarted, wakeupReleased]);
    expect(scan).toEqual({
      started: false,
      registered: false,
      completed: false,
      released: false,
    });
  });

  test("空事件列表返回全 false（不抛错）", () => {
    expect(scanMonitorEvents([])).toEqual({
      started: false,
      registered: false,
      completed: false,
      released: false,
    });
  });
});

describe("parseWaitAuditOutput · 解析 wait-audit 的人类可读输出", () => {
  // 真实输出形状（scripts/wait-audit.ts 的 main() 最后一段）
  const real =
    "20261109-223949-b177b927: windows=1 basis=wait_registry " +
    "[2026-11-09T14:39:56.424Z → 2026-11-09T14:40:01.468Z] " +
    "fg_polls=0 gh=0 polls/min=0 req=3 tok=1234 zombie=0 gate_retry=0 exit8=0 " +
    "monitor_ev=5 violations=0(late_terminal=0)";

  test("正常读出 monitor_ev 与 violations", () => {
    expect(parseWaitAuditOutput(real)).toEqual({ monitorEv: 5, violations: 0 });
  });

  test("D2 的形态：monitor_ev=0 要如实读成 0（不是「读不到」）", () => {
    expect(parseWaitAuditOutput(real.replace("monitor_ev=5", "monitor_ev=0"))).toEqual({
      monitorEv: 0,
      violations: 0,
    });
  });

  test("monitor_ev=n/a（未读 raw）返回 null，调用方据此判 INVALID 而不是 0", () => {
    expect(parseWaitAuditOutput(real.replace("monitor_ev=5", "monitor_ev=n/a"))).toEqual({
      monitorEv: null,
      violations: 0,
    });
  });

  test("字段缺失返回 null（脚本报错时不能默认 0）", () => {
    expect(parseWaitAuditOutput("会话 xxx 没有等待窗口（或轨迹不存在）")).toEqual({
      monitorEv: null,
      violations: null,
    });
  });

  test("violations 带括号尾注也能读出数字", () => {
    expect(parseWaitAuditOutput(real.replace("violations=0", "violations=3"))).toEqual({
      monitorEv: 5,
      violations: 3,
    });
  });
});

describe("analyzeDiscovery · D4 的发现性判据", () => {
  const eventsWithMonitor: TraceEvent[] = [
    { event: "PreToolUse", data: { tool_name: "tool_search", tool_use_id: "t1" } },
    { event: "PreToolUse", data: { tool_name: "monitor", tool_use_id: "t2" } },
  ];

  test("events 里出现 tool_name=monitor 即命中 called", () => {
    const signal = analyzeDiscovery(eventsWithMonitor, []);
    expect(signal.called).toBe(true);
  });

  test("tool_search 的 query 含 monitor → searched（events 里读不到 query，只能看 traj）", () => {
    const traj: TrajStep[] = [
      {
        message_type: "action",
        tool_name: "tool_search",
        tool_input: { query: "select:monitor", max_results: 3 },
        content: "先激活工具。",
      },
    ];
    expect(analyzeDiscovery([], traj)).toEqual({
      called: false,
      searched: true,
      mentioned: false,
    });
  });

  test("最终回复提到 monitor → mentioned（弱命中：想到了但没用）", () => {
    const traj: TrajStep[] = [
      {
        message_type: "action",
        tool_name: undefined,
        action: "final_answer",
        content: "建议用 monitor 盯这个文件，但也可以先 bash 轮询。",
      },
    ];
    expect(analyzeDiscovery([], traj)).toEqual({
      called: false,
      searched: false,
      mentioned: true,
    });
  });

  test("observation 里的 monitor 不算模型提到（tool_search 的返回含这个词）", () => {
    const traj: TrajStep[] = [
      {
        message_type: "observation",
        content: "已激活 1 个工具，将在下一轮出现：monitor: 按行事件监控外部状态",
      },
    ];
    expect(analyzeDiscovery([], traj)).toEqual({
      called: false,
      searched: false,
      mentioned: false,
    });
  });

  test("完全没提 monitor（用了前台轮询）→ 三个判据都 false", () => {
    const traj: TrajStep[] = [
      {
        message_type: "action",
        tool_name: "bash",
        tool_input: { command: "tail -5 /tmp/x.log" },
        content: "我用 tail 看看。",
      },
      { message_type: "observation", content: "line-1" },
    ];
    expect(analyzeDiscovery([], traj)).toEqual({
      called: false,
      searched: false,
      mentioned: false,
    });
  });

  test("traj 里直接调用 monitor 也命中 called（不依赖 events）", () => {
    const traj: TrajStep[] = [
      {
        message_type: "action",
        tool_name: "monitor",
        tool_input: { command: "tail -F /tmp/x.log" },
        content: "",
      },
    ];
    expect(analyzeDiscovery([], traj).called).toBe(true);
  });

  // ── D6（FIX-5）：target 参数化的发现性判据（task_output / workflow 场景） ──

  test("target=task_output：tool_search 搜过即命中 searched（D6 场景判据）", () => {
    const traj: TrajStep[] = [
      {
        message_type: "action",
        tool_name: "tool_search",
        tool_input: { query: "select:task_output", max_results: 3 },
        content: "回看后台输出用这个。",
      },
    ];
    expect(analyzeDiscovery([], traj, "task_output")).toEqual({
      called: false,
      searched: true,
      mentioned: false,
    });
  });

  test("target=workflow：回复提到即命中 mentioned（弱命中档）", () => {
    const traj: TrajStep[] = [
      {
        message_type: "action",
        tool_name: undefined,
        action: "final_answer",
        content: "这种规模用 workflow 编排脚本最合适。",
      },
    ];
    expect(analyzeDiscovery([], traj, "workflow")).toEqual({
      called: false,
      searched: false,
      mentioned: true,
    });
  });

  test("target 不串扰：搜 task_output 不误命中 workflow 的判据", () => {
    const traj: TrajStep[] = [
      {
        message_type: "action",
        tool_name: "tool_search",
        tool_input: { query: "select:task_output" },
        content: "",
      },
    ];
    // called 是全等匹配（tool_name === target），搜过 task_output 不算 workflow 命中
    expect(analyzeDiscovery([], traj, "task_output").called).toBe(false);
    expect(analyzeDiscovery([], traj, "workflow").searched).toBe(false);
  });
});

describe("findOrphanCleanupLog · 启动扫描的清理记录", () => {
  test("命中：同一行既含 monitor 又含清理语义", () => {
    const log = [
      "2026-11-10 10:00:00 [WARN] [DIAG] 心跳残留诊断：0 条",
      "2026-11-10 10:00:01 [WARN] [TASK] 清理 1 个孤儿 monitor 进程（父 pid 已退出）",
    ].join("\n");
    expect(findOrphanCleanupLog(log)).toContain("孤儿 monitor");
  });

  test("未命中：只有 monitor 不谈清理（普通监控日志不算）", () => {
    const log = "[INFO] [TASK] monitor m1 started\n[INFO] [TASK] monitor m1 completed";
    expect(findOrphanCleanupLog(log)).toBeNull();
  });

  test("未命中：只有清理语义但对象不是 monitor（别把别的孤儿告警算成这条）", () => {
    const log = "[WARN] [DIAG] 发现 2 个孤儿进程残留（进程已退出但 PID 文件未清理）";
    expect(findOrphanCleanupLog(log)).toBeNull();
  });

  test("空文本返回 null", () => {
    expect(findOrphanCleanupLog("")).toBeNull();
  });
});

describe("verdictOf · 三态合成", () => {
  test("全部断言通过 → PASS", () => {
    expect(
      verdictOf([
        { name: "a", pass: true },
        { name: "b", pass: true },
      ]),
    ).toBe("PASS");
  });

  test("任一断言失败 → FAIL", () => {
    expect(
      verdictOf([
        { name: "a", pass: true },
        { name: "b", pass: false },
      ]),
    ).toBe("FAIL");
  });

  test("INVALID 优先级最高：前置条件不成立时断言结果没有意义", () => {
    expect(verdictOf([{ name: "a", pass: false }], "monitor 没挂上")).toBe("INVALID");
    expect(verdictOf([{ name: "a", pass: true }], "monitor 没挂上")).toBe("INVALID");
  });

  test("空断言列表 → INVALID（一个什么都没断言的 case 不能判 PASS）", () => {
    expect(verdictOf([])).toBe("INVALID");
    expect(verdictOf([], null)).toBe("INVALID");
  });
});

describe("parseArgs · CLI 口径", () => {
  test("--case 单个", () => {
    expect(parseArgs(["--case", "D1b-signal"])).toEqual({
      cases: ["D1b-signal"],
      json: false,
      binary: undefined,
      help: false,
    });
  });

  test("--all 展开全部 case（顺序固定）", () => {
    expect(parseArgs(["--all"]).cases).toEqual([...ALL_CASES]);
  });

  test("--all 与 --case 混用去重", () => {
    const opts = parseArgs(["--all", "--case", "D4-discovery", "--case", "D4-discovery"]);
    expect(opts.cases.filter((c) => c === "D4-discovery")).toHaveLength(1);
    expect(opts.cases).toHaveLength(ALL_CASES.length);
  });

  test("--json / --binary 透传", () => {
    const opts = parseArgs(["--case", "D2D3-audit", "--json", "--binary", "./sid-code-dev"]);
    expect(opts.json).toBe(true);
    expect(opts.binary).toBe("./sid-code-dev");
  });

  test("未知 case 抛错（不静默跑别的 case）", () => {
    expect(() => parseArgs(["--case", "D9-nope"])).toThrow(/未知 case/);
  });

  test("--binary 缺参数抛错", () => {
    expect(() => parseArgs(["--binary"])).toThrow(/需要一个路径/);
  });
});

describe("makeToken · 唯一定位标记", () => {
  test("tag 里的非字母数字被清掉（ps 正则与 shell 命令都要求安全字符）", () => {
    expect(makeToken("D1b-signal", 1762700000000)).toBe("VERIFY1762700000000D1bsignal");
    expect(makeToken("d1b/negative", 1)).toBe("VERIFY1d1bnegative");
  });

  test("同一 tag 不同时刻不撞（并行 case 互不干扰）", () => {
    expect(makeToken("x", 1)).not.toBe(makeToken("x", 2));
  });
});

describe("D4-discovery-checks · CI 模拟与前台轮询计数（FIX-3）", () => {
  test("模拟脚本写 5 个状态：全 pending → 四项依次结束，第三项 e2e 是 fail", () => {
    const script = buildChecksSimScript("/tmp/x'y.json", 1);
    const states = [...script.matchAll(/printf '%s\\n' '(\[.*?\])'/g)].map((m) =>
      JSON.parse(m[1]!),
    );
    expect(states).toHaveLength(5);
    expect(states[0].every((c: { status: string }) => c.status === "pending")).toBe(true);
    expect(states[4].map((c: { status: string }) => c.status)).toEqual([
      "pass",
      "pass",
      "fail",
      "pass",
    ]);
    // 路径里的单引号必须转义，否则 bash 脚本语法错 → 状态文件不出现 → case 恒 INVALID
    expect(script).toContain(`f='/tmp/x'\\''y.json'`);
    // 原子替换：模型永远读不到半截 JSON
    expect(script).toContain('mv "$f.tmp" "$f"');
  });

  test("前台轮询只数 assistant 侧 bash/read 且参数里含目标路径", () => {
    const target = "/tmp/VERIFY1checks-checks.json";
    const traj: TrajStep[] = [
      { message_type: "action", tool_name: "bash", tool_input: { command: `cat ${target}` } },
      { message_type: "action", tool_name: "read", tool_input: { file_path: target } },
      { message_type: "observation", tool_name: "bash", tool_input: { command: `cat ${target}` } },
      { message_type: "action", tool_name: "bash", tool_input: { command: "ls /tmp" } },
      { message_type: "action", tool_name: "monitor", tool_input: { command: `tail ${target}` } },
    ];
    expect(countForegroundPolls(traj, target)).toBe(2);
  });

  test("D4-discovery-checks 在 ALL_CASES 里，可被 --case 选中", () => {
    expect(ALL_CASES).toContain("D4-discovery-checks");
    expect(parseArgs(["--case", "D4-discovery-checks"]).cases).toEqual(["D4-discovery-checks"]);
  });
});

describe("collectMonitorEvents · D5-events 的断言取数", () => {
  const mon = (seq: number, taskId = "m1", dropped = 0): TraceEvent => ({
    event: "MonitorEvent",
    timestamp: `2026-01-01T00:00:0${seq}.000Z`,
    data: { task_id: taskId, seq, chars: 10, lines: 1, dropped },
  });

  test("seq / task_id / dropped 按落盘顺序收集", () => {
    const out = collectMonitorEvents([
      mon(1),
      { event: "TaskLifecycle", timestamp: "t", data: { phase: "started" } },
      mon(2, "m1", 3), // 突发阀截断的那条：dropped>0
      mon(3),
    ]);
    expect(out.count).toBe(3);
    expect(out.seqs).toEqual([1, 2, 3]);
    expect(out.taskIds).toEqual(["m1"]);
    expect(out.droppedCount).toBe(1);
  });

  test("多个 monitor 的 task_id 都收集；非 MonitorEvent 事件不参与", () => {
    const out = collectMonitorEvents([mon(1, "m1"), mon(1, "m2")]);
    expect(out.count).toBe(2);
    expect(out.taskIds).toEqual(["m1", "m2"]);
  });

  test("没有 MonitorEvent（D5 未实现）→ count=0，不抛错", () => {
    const out = collectMonitorEvents([
      { event: "WaitRegistered", timestamp: "t", data: { kind: "monitor" } },
    ]);
    expect(out.count).toBe(0);
    expect(out.seqs).toEqual([]);
    expect(out.taskIds).toEqual([]);
  });

  test("D5-events 在 ALL_CASES 里，可被 --case 选中", () => {
    expect(ALL_CASES).toContain("D5-events");
    expect(parseArgs(["--case", "D5-events"]).cases).toEqual(["D5-events"]);
  });
});

describe("analyzeWakeupTurn · N2 的判据取数", () => {
  const target = "/tmp/VERIFY1n2wake-checks.json";
  const pre = (tool: string, input: Record<string, unknown> = {}): TraceEvent => ({
    event: "PreToolUse",
    timestamp: `2026-01-01T00:00:00.000Z`,
    data: { tool_name: tool, input_summary: input },
  });
  const wake = (): TraceEvent => pre("schedule_wakeup", { delay_seconds: 240 });
  const poll = (): TraceEvent => pre("bash", { command: `cat ${target}` });
  const end = (): TraceEvent => ({ event: "EndTurnShape", timestamp: "t", data: { kind: "text" } });

  test("排完唤醒到本轮结束之间的前台读状态全部计入", () => {
    const facts = analyzeWakeupTurn([wake(), poll(), poll(), end()], target);
    expect(facts.wakeupCalled).toBe(true);
    expect(facts.foregroundPolls).toBe(2);
    expect(facts.toolsInWindow).toBe(2);
  });

  test("后台 bash 不算前台（run_in_background=true 正是正确出路）", () => {
    const facts = analyzeWakeupTurn(
      [wake(), pre("bash", { command: `cat ${target}`, run_in_background: true }), poll(), end()],
      target,
    );
    expect(facts.foregroundPolls).toBe(1);
  });

  test("本轮结束之后的查询不计：那一轮属于「等唤醒是否有效」，不是 N2", () => {
    const facts = analyzeWakeupTurn([wake(), poll(), end(), poll(), poll(), poll()], target);
    expect(facts.foregroundPolls).toBe(1);
  });

  test("没排唤醒 → wakeupCalled=false 且计数为 0（调用方据此判 FAIL）", () => {
    const facts = analyzeWakeupTurn([poll(), poll(), end()], target);
    expect(facts.wakeupCalled).toBe(false);
    expect(facts.foregroundPolls).toBe(0);
    expect(facts.toolsInWindow).toBe(0);
  });

  test("没有 EndTurnShape（本轮还没收尾）→ 统计到轨迹末尾", () => {
    const facts = analyzeWakeupTurn([wake(), poll(), poll()], target);
    expect(facts.foregroundPolls).toBe(2);
  });

  test("只数带目标路径的调用：读别的文件不算", () => {
    const facts = analyzeWakeupTurn(
      [
        wake(),
        pre("bash", { command: "ls /tmp" }),
        pre("read", { file_path: "/etc/hosts" }),
        poll(),
      ],
      target,
    );
    expect(facts.foregroundPolls).toBe(1);
    expect(facts.toolsInWindow).toBe(3);
  });

  test("N2-wakeup-then-end 在 ALL_CASES 里，可被 --case 选中", () => {
    expect(ALL_CASES).toContain("N2-wakeup-then-end");
    expect(parseArgs(["--case", "N2-wakeup-then-end"]).cases).toEqual(["N2-wakeup-then-end"]);
  });
});
