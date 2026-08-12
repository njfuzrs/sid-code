/**
 * W11.D1 单元测试 — sid-code-live adapter 关键纯函数
 *
 * 不测真实 spawn（成本高、依赖网络/API key），只测：
 * - findLatestSessionDir：扫目录找最新 session
 * - parseFinalResponseFromStdout：JSON / 非 JSON / 空 / 多对象 stdout
 * - readTrajectoryFile：trajectory 缺失 / JSON 错误 / 正常
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  findLatestSessionDir,
  parseFinalResponseFromStdout,
  readTrajectoryFile,
  findLatestPlanFile,
  countPlanFileUpdates,
  readStreamUntilDone,
} from "../../evals/bench-runner/adapters/sid-code-live.ts";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(
    tmpdir(),
    `sid-code-live-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("findLatestSessionDir", () => {
  test("空 sessions 目录返回 null", () => {
    const dir = join(tmpRoot, "case_empty");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const r = findLatestSessionDir({ trajectoriesDir: dir, sinceTimestamp: Date.now() });
    expect(r).toBeNull();
  });

  test("根目录不存在返回 null", () => {
    const r = findLatestSessionDir({
      trajectoriesDir: join(tmpRoot, "nonexistent_dir"),
      sinceTimestamp: Date.now(),
    });
    expect(r).toBeNull();
  });

  test("选中 mtime 最新且在 since 之后的目录", async () => {
    const dir = join(tmpRoot, "case_pick_latest");
    mkdirSync(join(dir, "sessions/abc111"), { recursive: true });
    mkdirSync(join(dir, "sessions/abc222"), { recursive: true });
    mkdirSync(join(dir, "sessions/abc333"), { recursive: true });

    const now = Date.now();
    // abc111 是 1 小时前（早于 since）
    const oldTime = new Date(now - 3600_000);
    utimesSync(join(dir, "sessions/abc111"), oldTime, oldTime);
    // abc222 / abc333 都在 since 之后，abc333 更新
    utimesSync(join(dir, "sessions/abc222"), new Date(now - 1000), new Date(now - 1000));
    utimesSync(join(dir, "sessions/abc333"), new Date(now), new Date(now));

    const sinceTs = now - 5000; // 5 秒前
    const r = findLatestSessionDir({ trajectoriesDir: dir, sinceTimestamp: sinceTs });
    expect(r).not.toBeNull();
    expect(r).toContain("abc333");
  });

  test("所有目录都早于 since → 返回 null", () => {
    const dir = join(tmpRoot, "case_all_old");
    mkdirSync(join(dir, "sessions/old1"), { recursive: true });
    const oldTime = new Date(Date.now() - 7200_000); // 2h ago
    utimesSync(join(dir, "sessions/old1"), oldTime, oldTime);

    const r = findLatestSessionDir({
      trajectoriesDir: dir,
      sinceTimestamp: Date.now() - 60_000, // 1 分钟前
    });
    expect(r).toBeNull();
  });
});

describe("parseFinalResponseFromStdout", () => {
  test("空 stdout → 空字符串", () => {
    expect(parseFinalResponseFromStdout("").text).toBe("");
    expect(parseFinalResponseFromStdout("   \n  ").text).toBe("");
  });

  test("JSON 模式标准输出", () => {
    const json = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      usage: { input_tokens: 10 },
    });
    expect(parseFinalResponseFromStdout(json).text).toBe("Hello world");
  });

  test("content 是字符串而不是数组", () => {
    const json = JSON.stringify({
      role: "assistant",
      content: "Plain string response",
    });
    expect(parseFinalResponseFromStdout(json).text).toBe("Plain string response");
  });

  test("多个 text block 拼接", () => {
    const json = JSON.stringify({
      role: "assistant",
      content: [
        { type: "text", text: "Part 1" },
        { type: "tool_use", id: "x", name: "Read" },
        { type: "text", text: "Part 2" },
      ],
    });
    expect(parseFinalResponseFromStdout(json).text).toBe("Part 1\nPart 2");
  });

  test("非 JSON stdout → 退化为原文", () => {
    const r = parseFinalResponseFromStdout("just plain text\nno json");
    expect(r.text).toContain("just plain text");
  });

  test("前缀有非 JSON 但末尾是 JSON 对象", () => {
    const stdout = `恢复会话: abc123 (5 条消息)\n${JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "Recovered output" }],
    })}`;
    expect(parseFinalResponseFromStdout(stdout).text).toBe("Recovered output");
  });

  test("超长 response 被截断到 3000 字符", () => {
    const longText = "x".repeat(5000);
    const json = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: longText }],
    });
    expect(parseFinalResponseFromStdout(json).text.length).toBe(3000);
  });

  test("提取 session_id 和 trajectory_path", () => {
    const json = JSON.stringify({
      session_id: "abc12345",
      trajectory_path: "/tmp/sessions/abc12345/session.traj",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    const r = parseFinalResponseFromStdout(json);
    expect(r.sessionId).toBe("abc12345");
    expect(r.trajectoryPath).toBe("/tmp/sessions/abc12345/session.traj");
    expect(r.text).toBe("ok");
  });

  test("没有 session_id 字段时 sessionId 为 null", () => {
    const json = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    const r = parseFinalResponseFromStdout(json);
    expect(r.sessionId).toBeNull();
    expect(r.trajectoryPath).toBeNull();
  });
});

describe("readTrajectoryFile", () => {
  test("trajectory 文件缺失 → null", () => {
    const dir = join(tmpRoot, "traj_missing");
    mkdirSync(dir, { recursive: true });
    expect(readTrajectoryFile(dir)).toBeNull();
  });

  test("trajectory JSON 解析错误 → null", () => {
    const dir = join(tmpRoot, "traj_bad_json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "{not valid json");
    expect(readTrajectoryFile(dir)).toBeNull();
  });

  test("trajectory 正常解析", () => {
    const dir = join(tmpRoot, "traj_good");
    mkdirSync(dir, { recursive: true });
    const traj = {
      trajectory: [{ message_type: "action", tool_name: "Read" }],
      metadata: {
        session_id: "abc",
        tools_used: ["Read"],
        total_steps: 1,
        exit_status: "end_turn",
      },
    };
    writeFileSync(join(dir, "session.traj"), JSON.stringify(traj));
    const r = readTrajectoryFile(dir);
    expect(r).not.toBeNull();
    expect(r?.metadata?.session_id).toBe("abc");
    expect(r?.trajectory?.length).toBe(1);
  });
});

describe("findLatestPlanFile", () => {
  test("plans 目录不存在 → null", () => {
    const r = findLatestPlanFile({
      plansDir: join(tmpRoot, "no_plans"),
      sinceTimestamp: Date.now(),
    });
    expect(r).toBeNull();
  });

  test("只看 .md 文件", () => {
    const dir = join(tmpRoot, "plans_mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-x.txt"), "not md");
    writeFileSync(join(dir, "plan-y.md"), "# plan");
    const r = findLatestPlanFile({ plansDir: dir, sinceTimestamp: Date.now() - 60_000 });
    expect(r).not.toBeNull();
    expect(r).toContain("plan-y.md");
  });

  test("过期的 plan 文件被过滤", () => {
    const dir = join(tmpRoot, "plans_old");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-old.md"), "# old");
    const oldTime = new Date(Date.now() - 7200_000);
    utimesSync(join(dir, "plan-old.md"), oldTime, oldTime);
    const r = findLatestPlanFile({ plansDir: dir, sinceTimestamp: Date.now() - 60_000 });
    expect(r).toBeNull();
  });
});

describe("countPlanFileUpdates — plan 文件 write/edit 真命中（W12.D3）", () => {
  const planPath = "/tmp/plan-test-w12.md";

  test("trajectory 为空 → 0", () => {
    expect(countPlanFileUpdates({ trajectory: [], planFilePath: planPath })).toBe(0);
    expect(countPlanFileUpdates({ trajectory: undefined, planFilePath: planPath })).toBe(0);
  });

  test("planFilePath 为空 → 0", () => {
    expect(
      countPlanFileUpdates({
        trajectory: [{ message_type: "action", tool_name: "write" }],
        planFilePath: null,
      }),
    ).toBe(0);
  });

  test("write 命中 plan 文件 → 1", () => {
    const traj = [
      {
        message_type: "action",
        tool_name: "write",
        tool_input: { file_path: planPath, content: "# v1" },
      },
    ];
    expect(countPlanFileUpdates({ trajectory: traj, planFilePath: planPath })).toBe(1);
  });

  test("write + edit 各 1 次命中 plan → 2", () => {
    const traj = [
      {
        message_type: "action",
        tool_name: "write",
        tool_input: { file_path: planPath, content: "# v1" },
      },
      { message_type: "observation", role: "user" },
      {
        message_type: "action",
        tool_name: "edit",
        tool_input: { file_path: planPath, content: "# v2" },
      },
    ];
    expect(countPlanFileUpdates({ trajectory: traj, planFilePath: planPath })).toBe(2);
  });

  test("write 命中其他文件 → 0（非 plan 文件不算）", () => {
    const traj = [
      {
        message_type: "action",
        tool_name: "write",
        tool_input: { file_path: "/tmp/other.ts", content: "x" },
      },
      {
        message_type: "action",
        tool_name: "edit",
        tool_input: { file_path: "/tmp/other.ts", content: "y" },
      },
    ];
    expect(countPlanFileUpdates({ trajectory: traj, planFilePath: planPath })).toBe(0);
  });

  test("非 write/edit 工具（read/grep/bash） → 0", () => {
    const traj = [
      { message_type: "action", tool_name: "read", tool_input: { file_path: planPath } },
      { message_type: "action", tool_name: "grep", tool_input: { pattern: "x" } },
      { message_type: "action", tool_name: "bash", tool_input: { command: "ls" } },
    ];
    expect(countPlanFileUpdates({ trajectory: traj, planFilePath: planPath })).toBe(0);
  });

  test("file_path 缺失 → 跳过该步", () => {
    const traj = [
      { message_type: "action", tool_name: "write", tool_input: {} },
      {
        message_type: "action",
        tool_name: "write",
        tool_input: { file_path: planPath, content: "v1" },
      },
    ];
    expect(countPlanFileUpdates({ trajectory: traj, planFilePath: planPath })).toBe(1);
  });

  test("路径含 ./ 或 ../ → resolve 后比较仍能匹配", () => {
    const traj = [
      {
        message_type: "action",
        tool_name: "write",
        tool_input: { file_path: "/tmp/./plan-test-w12.md", content: "v1" },
      },
    ];
    expect(countPlanFileUpdates({ trajectory: traj, planFilePath: planPath })).toBe(1);
  });

  test("observation 类型的 step 不计入（防御）", () => {
    const traj = [
      { message_type: "observation", role: "user", content: "result", tool_name: "write" },
    ];
    expect(countPlanFileUpdates({ trajectory: traj, planFilePath: planPath })).toBe(0);
  });
});

describe("readStreamUntilDone — deadline 行为（W12.D4 hotfix）", () => {
  function makeStream(chunks: string[], intervalMs: number): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      },
    });
  }

  test("无 deadline 时 stream 自然 EOF → timedOut=false", async () => {
    const stream = makeStream(["hello", " world"], 10);
    const { buf, timedOut } = await readStreamUntilDone(stream);
    expect(timedOut).toBe(false);
    expect(buf).toBe("hello world");
  });

  test("deadline 触发立即返回 → timedOut=true", async () => {
    // 每 200ms 一个 chunk，deadline 50ms → 应在第一个 chunk 之前或之后立即退出
    const stream = makeStream(["a", "b", "c", "d", "e"], 200);
    const start = Date.now();
    const { timedOut } = await readStreamUntilDone(stream, { deadlineMs: 50 });
    const elapsed = Date.now() - start;
    expect(timedOut).toBe(true);
    expect(elapsed).toBeLessThan(300);
  });

  test("deadline 触发后保留已读 buf", async () => {
    // 每 30ms 一个 chunk，deadline 100ms → 应读到 2-3 个 chunk
    const stream = makeStream(["aa", "bb", "cc", "dd", "ee"], 30);
    const { buf, timedOut } = await readStreamUntilDone(stream, { deadlineMs: 100 });
    expect(timedOut).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf).toContain("aa");
  });

  test("isDone 在 deadline 之前触发 → timedOut=false", async () => {
    // 构造含"会话摘要"完成标志的 stream
    const doneChunk =
      "────────────────────────────────────────\n会话摘要\n────────────────────────────────────────\n" +
      "x".repeat(60) +
      "\n────────────────────────────────────────\n";
    const stream = makeStream(["prefix ", doneChunk], 10);
    const { buf, timedOut } = await readStreamUntilDone(stream, { deadlineMs: 5000 });
    expect(timedOut).toBe(false);
    expect(buf).toContain("会话摘要");
  });
});
