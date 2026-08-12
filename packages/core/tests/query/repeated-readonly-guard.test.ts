/**
 * 无进展只读命令重复检测 + git-status 刷新止损阀单测（query/repeated-readonly-guard.ts）
 *
 * 回归目标（根因分析-commit任务git状态快照冻结死循环.md，会话 20260710-164407）：
 * git-status 快照冻结进 system prompt 整会话不刷新，任务完成后模型被"快照说脏/实时说净"的
 * 矛盾锁死，在已干净的工作区上反复空跑 git status 11 轮直到用户 ESC。本阀识别这一模式：
 * "连续相同只读探查命令 + 输出稳定不变" → 先注入携带实时 git 状态的收敛提醒 → 注满上限强制收尾。
 */

import { describe, test, expect } from "bun:test";
import {
  isReadonlyProbeCommand,
  isReadFamilyTool,
  makeToolProbeCommand,
  stripLeadingCdAndEnv,
  makeSignature,
  processObservation,
  createRepeatedReadonlyState,
  buildStuckReminder,
  buildTerminateNotice,
  STUCK_REPEAT_THRESHOLD,
  MAX_STUCK_REMINDERS,
} from "@sid-code/core/query/repeated-readonly-guard.ts";

describe("isReadonlyProbeCommand — 只读探查命令识别", () => {
  test("识别 git status / diff / log / branch / show", () => {
    expect(isReadonlyProbeCommand("git status --short")).toBe(true);
    expect(isReadonlyProbeCommand("git diff --staged")).toBe(true);
    expect(isReadonlyProbeCommand("git log --oneline -5")).toBe(true);
    expect(isReadonlyProbeCommand("git branch")).toBe(true);
    expect(isReadonlyProbeCommand("git show HEAD")).toBe(true);
  });

  test("识别 ls / pwd / cat / head / tail / stat", () => {
    expect(isReadonlyProbeCommand("ls -la")).toBe(true);
    expect(isReadonlyProbeCommand("pwd")).toBe(true);
    expect(isReadonlyProbeCommand("cat package.json")).toBe(true);
  });

  // ★缺口 A 修复(§4.1/§3a)：本次真实死锁的命令全是带 `cd` 前缀的复合命令
  // （`cd /a/b && git status --short`）。旧逻辑因 cd 不在只读白名单把整条链判非只读、
  // 零触发止损。修复后剥离 cd/env 前缀再判主体,让这类形态也能进检测。
  test("★带 cd 前缀的只读探查命令现在纳入（缺口 A 修复）", () => {
    expect(isReadonlyProbeCommand("cd /tmp && git status")).toBe(true);
    expect(isReadonlyProbeCommand("cd /a/b && git status --short")).toBe(true);
    expect(isReadonlyProbeCommand("cd project; git diff")).toBe(true);
    expect(isReadonlyProbeCommand("cd a && cd b && git log --oneline")).toBe(true);
    expect(isReadonlyProbeCommand("FOO=1 cd x && git status")).toBe(true);
  });

  test("★剥离 cd 前缀后主体仍带副作用的复合命令绝不纳入（安全阀）", () => {
    // 剥离 `cd x &&` 后主体是 `rm y` / `git status && rm y`,仍被 isReadOnlyCommand 判非只读。
    // 只放行"cd 到某目录后执行纯只读探查",不误纳任何带副作用的复合命令。
    expect(isReadonlyProbeCommand("cd /tmp && rm -rf foo")).toBe(false);
    expect(isReadonlyProbeCommand("cd x && git status && rm y")).toBe(false);
    expect(isReadonlyProbeCommand("cd x && git commit -m y")).toBe(false);
  });

  test("写操作命令不算只读探查", () => {
    expect(isReadonlyProbeCommand("git commit -m x")).toBe(false);
    expect(isReadonlyProbeCommand("git add -A")).toBe(false);
    expect(isReadonlyProbeCommand("rm -rf foo")).toBe(false);
    expect(isReadonlyProbeCommand("npm install")).toBe(false);
  });

  test("带写入重定向/副作用的形式不算只读探查（AST 关卡兜底）", () => {
    // 仅靠正则会把这些误判为只读探查，AST 级 isReadOnlyCommand 关卡将其排除。
    expect(isReadonlyProbeCommand("git log > out.txt")).toBe(false);
    expect(isReadonlyProbeCommand("cat a.txt > b.txt")).toBe(false);
    expect(isReadonlyProbeCommand("ls && rm -rf x")).toBe(false);
    expect(isReadonlyProbeCommand("git status | tee status.log")).toBe(false);
  });
});

describe("★缺口 B：read 家族工具折叠进 probe 签名", () => {
  test("isReadFamilyTool 识别纯只读检查工具", () => {
    expect(isReadFamilyTool("read")).toBe(true);
    expect(isReadFamilyTool("read_many")).toBe(true);
    expect(isReadFamilyTool("ls")).toBe(true);
    expect(isReadFamilyTool("glob")).toBe(true);
    expect(isReadFamilyTool("grep")).toBe(true);
    expect(isReadFamilyTool("lsp")).toBe(true);
    // 有产出/副作用的工具不算
    expect(isReadFamilyTool("write")).toBe(false);
    expect(isReadFamilyTool("edit")).toBe(false);
    expect(isReadFamilyTool("todo_write")).toBe(false);
    expect(isReadFamilyTool("bash")).toBe(false);
  });

  test("makeToolProbeCommand：入参相同得同签名，入参不同得不同签名", () => {
    const a = makeToolProbeCommand("read", { file_path: "/a", offset: 585 });
    const b = makeToolProbeCommand("read", { offset: 585, file_path: "/a" }); // 键序不同
    const c = makeToolProbeCommand("read", { file_path: "/a", offset: 665 }); // offset 不同
    expect(a).toBe(b); // 键排序后序列化,键序抖动不造成伪差异
    expect(a).not.toBe(c); // 读了新区域 → 不同签名 → 视为新探查
  });

  test("stripLeadingCdAndEnv：剥离 cd/env 前缀取命令主体", () => {
    expect(stripLeadingCdAndEnv("cd /tmp && git status")).toBe("git status");
    expect(stripLeadingCdAndEnv("cd a && cd b && git log")).toBe("git log");
    expect(stripLeadingCdAndEnv("FOO=1 cd x && git status")).toBe("git status");
    expect(stripLeadingCdAndEnv("git status")).toBe("git status"); // 无前缀原样返回
  });

  test("★回放真实死锁：git status ↔ read 同一区域交替，不再被 read 清零", () => {
    // 历史死锁形态：#132 git status → #133 read×同区域 → #134 git status ...
    // 交替进行时旧逻辑每轮被 read 清零,连续计数永远到不了阈值 3。
    // 修复后 read 折叠进 probes,复合签名稳定,能累积到 stuck。
    const state = createRepeatedReadonlyState();
    const gitProbe = { command: "git status --short", output: "" };
    const readProbe = {
      command: makeToolProbeCommand("read", { file_path: "/x", offset: 585 }),
      output: "同样的内容",
    };
    // 交替：每轮同时有 git status 和 read（同一复合签名），hadOtherActivity=false。
    let last;
    for (let i = 0; i < STUCK_REPEAT_THRESHOLD; i++) {
      last = processObservation(state, [gitProbe, readProbe], false);
    }
    expect(last!.stuck).toBe(true);
    expect(last!.action).toBe("remind");
  });
});

describe("makeSignature — 归一化", () => {
  test("空白折叠后相同命令+输出得同签名", () => {
    expect(makeSignature("git status", "")).toBe(makeSignature("git  status ", "  "));
  });
  test("输出不同 → 签名不同", () => {
    expect(makeSignature("git status", "")).not.toBe(makeSignature("git status", "M a.ts"));
  });
});

describe("processObservation — 卡住判定", () => {
  test("连续相同空跑达阈值 → stuck + remind", () => {
    const state = createRepeatedReadonlyState();
    let last;
    for (let i = 0; i < STUCK_REPEAT_THRESHOLD; i++) {
      last = processObservation(state, [{ command: "git status --short", output: "" }], false);
    }
    expect(last!.stuck).toBe(true);
    expect(last!.action).toBe("remind");
    expect(last!.command).toBe("git status --short");
    expect(last!.output).toBe("");
  });

  test("未达阈值前不触发", () => {
    const state = createRepeatedReadonlyState();
    for (let i = 0; i < STUCK_REPEAT_THRESHOLD - 1; i++) {
      const d = processObservation(state, [{ command: "git status", output: "" }], false);
      expect(d.stuck).toBe(false);
      expect(d.action).toBe("none");
    }
  });

  test("有其它活动（写操作/文本产出）→ 计数清零，永不误触发", () => {
    const state = createRepeatedReadonlyState();
    // 先攒两次
    processObservation(state, [{ command: "git status", output: "" }], false);
    processObservation(state, [{ command: "git status", output: "" }], false);
    // 中间穿插一次有进展
    const d = processObservation(state, [{ command: "git status", output: "" }], true);
    expect(d.stuck).toBe(false);
    expect(state.repeatCount).toBe(0);
  });

  test("输出变化 → 视为有新信息，计数重置", () => {
    const state = createRepeatedReadonlyState();
    processObservation(state, [{ command: "git status", output: "" }], false);
    processObservation(state, [{ command: "git status", output: "" }], false);
    const d = processObservation(state, [{ command: "git status", output: "M a.ts" }], false);
    expect(d.stuck).toBe(false);
    expect(state.repeatCount).toBe(1);
  });

  test("注满 MAX_STUCK_REMINDERS 次提醒后 → terminate", () => {
    const state = createRepeatedReadonlyState();
    const feed = () => processObservation(state, [{ command: "git status", output: "" }], false);
    const actions: string[] = [];
    // 先达阈值触发第一次 remind
    for (let i = 0; i < STUCK_REPEAT_THRESHOLD; i++) actions.push(feed().action);
    // 之后每次持续空跑，直到超过提醒上限
    for (let i = 0; i < MAX_STUCK_REMINDERS + 1; i++) actions.push(feed().action);
    expect(actions.filter((a) => a === "remind").length).toBe(MAX_STUCK_REMINDERS);
    expect(actions[actions.length - 1]).toBe("terminate");
  });

  test("非 git 探查（ls 轮询）注满提醒后不强制收尾，只沉默（保守，避免掐断合法轮询）", () => {
    const state = createRepeatedReadonlyState();
    const feed = () =>
      processObservation(state, [{ command: "ls dist/", output: "(命令无输出)" }], false);
    const actions: string[] = [];
    for (let i = 0; i < STUCK_REPEAT_THRESHOLD; i++) actions.push(feed().action);
    for (let i = 0; i < MAX_STUCK_REMINDERS + 2; i++) actions.push(feed().action);
    // 恰好 MAX_STUCK_REMINDERS 次 remind，之后是 none（不 terminate）。
    expect(actions.filter((a) => a === "remind").length).toBe(MAX_STUCK_REMINDERS);
    expect(actions.includes("terminate")).toBe(false);
    expect(actions[actions.length - 1]).toBe("none");
  });

  test("空 probes（无只读命令）→ 不触发且清零", () => {
    const state = createRepeatedReadonlyState();
    state.repeatCount = 2;
    const d = processObservation(state, [], false);
    expect(d.stuck).toBe(false);
    expect(state.repeatCount).toBe(0);
  });

  test("★复合探查 [git status, read]（last 是 read）注满提醒后仍能 terminate（缺口 B 联动）", () => {
    // 缺口 B 折叠 read 后,一轮可能是 [git status, read...],若只看 last(read)会永不 terminate。
    // 修复:代表命令优先挑批次里的 git status → 仍走强制收尾。
    const state = createRepeatedReadonlyState();
    const batch = [
      { command: "git status --short", output: "" },
      { command: makeToolProbeCommand("read", { file_path: "/x" }), output: "同内容" },
    ];
    const feed = () => processObservation(state, batch, false);
    const actions: string[] = [];
    for (let i = 0; i < STUCK_REPEAT_THRESHOLD; i++) actions.push(feed().action);
    for (let i = 0; i < MAX_STUCK_REMINDERS + 1; i++) actions.push(feed().action);
    expect(actions.filter((a) => a === "remind").length).toBe(MAX_STUCK_REMINDERS);
    const lastDecision = feed();
    expect(lastDecision.action).toBe("terminate");
    // 收尾文案用的是 git status 命令(死锁主体),而非 read。
    expect(lastDecision.command).toContain("git status");
  });
});

describe("buildStuckReminder — 提醒文案", () => {
  test("git status 且工作区干净（空串）→ 含任务完成/end_turn 终止锚点", () => {
    const r = buildStuckReminder("git status --short", "");
    expect(r).toContain("工作区已干净");
    expect(r).toContain("end_turn");
    expect(r).toContain("实时输出为准");
    expect(r).toContain("<system-reminder>");
  });

  test("git status 且输出为 bash 空输出哨兵 → 同样判为干净", () => {
    // bash 工具把空输出转成 "(命令无输出)"，干净工作区的 git status 实际返回此哨兵。
    const r = buildStuckReminder("git status --short", "(命令无输出)");
    expect(r).toContain("工作区已干净");
    expect(r).toContain("end_turn");
  });

  test("非空输出 → 提示基于实时输出下结论，不含收尾锚点", () => {
    const r = buildStuckReminder("ls -la", "file1\nfile2");
    expect(r).toContain("file1");
    expect(r).not.toContain("end_turn");
  });

  test("附带实时 git 状态块时一并注入", () => {
    const r = buildStuckReminder(
      "git status",
      "",
      "<git-status>\nCurrent branch: main\n</git-status>",
    );
    expect(r).toContain("Current branch: main");
  });
});

describe("buildTerminateNotice — 强制收尾提示", () => {
  test("含命令与强制结束语义", () => {
    const n = buildTerminateNotice("git status --short");
    expect(n).toContain("git status --short");
    expect(n).toContain("强制结束");
    expect(n).toContain("<system-reminder>");
  });
});
