/**
 * eval-runner wrapper readTrajectoryMeta 单测
 *
 * 关键回归保护：efficiency 维度按"LLM turn 数"（total_api_calls）打分，
 * 不能用 total_steps（= trajectory.length，含 observation 翻倍）。
 *
 * 错误版本会让多工具循环 case（case_005 / case_028 / deepseek case_017）
 * 的 efficiency 被严重低估（如 33/12=2.75x → 0.1，实际应为 16/12=1.3x → 0.7）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readTrajectoryMeta } from "../../evals/providers/sid-code-live.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `eval-traj-meta-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function writeTraj(name: string, metadata: Record<string, unknown>): string {
  const path = join(tmpRoot, `${name}.traj`);
  writeFileSync(path, JSON.stringify({ trajectory: [], metadata }));
  return path;
}

describe("readTrajectoryMeta totalSteps 语义", () => {
  test("metadata 有 total_api_calls 时优先用它（turn 语义）", () => {
    const path = writeTraj("with-api-calls", {
      total_steps: 33,        // trajectory.length，含 observation 翻倍
      total_api_calls: 16,    // 真实 LLM turn 数
      tools_used: ["grep", "read"],
      files_edited: [],
      total_tokens: 12000,
      exit_status: "end_turn",
    });
    const meta = readTrajectoryMeta(path);
    expect(meta.totalSteps).toBe(16);
    expect(meta.toolsUsed).toEqual(["grep", "read"]);
    expect(meta.exitStatus).toBe("end_turn");
  });

  test("metadata 没有 total_api_calls 时 fallback 到 total_steps", () => {
    const path = writeTraj("legacy-no-api-calls", {
      total_steps: 7,
      tools_used: ["ls"],
      files_edited: [],
      total_tokens: 500,
      exit_status: "end_turn",
    });
    const meta = readTrajectoryMeta(path);
    expect(meta.totalSteps).toBe(7);
  });

  test("total_api_calls=0 也优先用（不能被 fallback 吃掉）", () => {
    const path = writeTraj("zero-api-calls", {
      total_steps: 5,
      total_api_calls: 0,
      tools_used: [],
      files_edited: [],
      total_tokens: 0,
      exit_status: "error",
    });
    const meta = readTrajectoryMeta(path);
    expect(meta.totalSteps).toBe(0);
  });

  test("文件不存在返回空 meta", () => {
    const meta = readTrajectoryMeta(join(tmpRoot, "nonexistent.traj"));
    expect(meta.totalSteps).toBe(0);
    expect(meta.toolsUsed).toEqual([]);
    expect(meta.exitStatus).toBeNull();
  });

  test("JSON 损坏返回空 meta", () => {
    const path = join(tmpRoot, "broken.traj");
    writeFileSync(path, "{not valid json");
    const meta = readTrajectoryMeta(path);
    expect(meta.totalSteps).toBe(0);
    expect(meta.toolsUsed).toEqual([]);
  });

  test("trajPath=null 返回空 meta", () => {
    const meta = readTrajectoryMeta(null);
    expect(meta.totalSteps).toBe(0);
  });
});
