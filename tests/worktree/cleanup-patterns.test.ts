/**
 * Cleanup ephemeral pattern 单测（P1-8 / B3）
 */

import { describe, it, expect } from "bun:test";
import { isEphemeralWorktree } from "../../src/worktree/cleanup.ts";

describe("isEphemeralWorktree", () => {
  it("识别 agent 临时 worktree", () => {
    expect(isEphemeralWorktree("agent-a1b2c3d4")).toBe(true);
    expect(isEphemeralWorktree("agent-1234abcd")).toBe(true);
  });

  it("识别 swarm 临时 worktree", () => {
    expect(isEphemeralWorktree("swarm-backend-worker-a1b")).toBe(true);
    expect(isEphemeralWorktree("swarm-x")).toBe(true);
  });

  it("识别 workflow 临时 worktree（含 legacy）", () => {
    expect(isEphemeralWorktree("wf_task1-0-abc")).toBe(true);
    expect(isEphemeralWorktree("wf_run123-12-a1b2")).toBe(true);
    expect(isEphemeralWorktree("wf-42")).toBe(true);
  });

  it("识别 bridge / job 临时 worktree", () => {
    expect(isEphemeralWorktree("bridge-session1")).toBe(true);
    expect(isEphemeralWorktree("job-deploy-1")).toBe(true);
  });

  it("用户命名（词汇 slug）永不视为临时", () => {
    expect(isEphemeralWorktree("brave-eagle-42")).toBe(false);
    expect(isEphemeralWorktree("my-feature")).toBe(false);
    expect(isEphemeralWorktree("user+feature")).toBe(false);
    expect(isEphemeralWorktree("hotfix")).toBe(false);
  });

  it("不误伤含 agent 字样的命名", () => {
    expect(isEphemeralWorktree("agent")).toBe(false);
    expect(isEphemeralWorktree("my-agent-work")).toBe(false);
    expect(isEphemeralWorktree("agent-toolong12345")).toBe(false);
  });
});
