/**
 * 自动更新 — 编排逻辑测试
 */

import { describe, expect, test } from "bun:test";
import { runAutoUpdateCheck, type AutoUpdateDependencies } from "@sid-code/core/update/index.ts";
import type { LockHandle } from "@sid-code/core/update/lock.ts";
import type { UpdateState } from "@sid-code/core/update/state.ts";

function makeDeps(overrides: Partial<AutoUpdateDependencies> = {}) {
  const calls: string[] = [];
  const state: UpdateState = { consecutiveFailures: 0 };
  const lock: LockHandle = {
    lockDir: "/tmp/update-test-lock",
    release: () => calls.push("release"),
  };
  const deps: AutoUpdateDependencies = {
    getCurrentVersion: () => "0.1.603",
    getSettings: () => ({ settings: { autoUpdate: "auto" }, errors: [] }),
    fetchLatestVersion: async () => "0.1.604",
    readState: () => state,
    patchState: (patch) => Object.assign(state, patch),
    shouldCheck: () => true,
    acquireLock: () => lock,
    spawnInstall: () => calls.push("install"),
    writeNotice: (notice) => {
      calls.push(`notice:${notice.type}`);
      state.pendingNotice = notice;
    },
    ...overrides,
  };
  return { calls, state, deps };
}

describe("runAutoUpdateCheck", () => {
  test("off 模式不检查", async () => {
    const { calls, deps } = makeDeps({
      getSettings: () => ({ settings: { autoUpdate: "off" }, errors: [] }),
      fetchLatestVersion: async () => {
        calls.push("fetch");
        return "0.1.604";
      },
    });
    await runAutoUpdateCheck(deps);
    expect(calls).toEqual([]);
  });

  test("节流命中不检查", async () => {
    const { calls, deps } = makeDeps({ shouldCheck: () => false });
    await runAutoUpdateCheck(deps);
    expect(calls).toEqual([]);
  });

  test("notify 模式写入 available，不安装", async () => {
    const { calls, state, deps } = makeDeps({
      getSettings: () => ({ settings: { autoUpdate: "notify" }, errors: [] }),
    });
    await runAutoUpdateCheck(deps);
    expect(calls).toEqual(["notice:available"]);
    expect(state.pendingNotice?.toVersion).toBe("0.1.604");
  });

  test("auto 模式发现新版本后启动安装", async () => {
    const { calls, deps } = makeDeps();
    await runAutoUpdateCheck(deps);
    expect(calls).toEqual(["install"]);
  });

  test("锁被占用时跳过安装", async () => {
    const { calls, deps } = makeDeps({ acquireLock: () => null });
    await runAutoUpdateCheck(deps);
    expect(calls).toEqual([]);
  });

  test("没有新版本时不安装并清零失败计数", async () => {
    const { calls, state, deps } = makeDeps({
      fetchLatestVersion: async () => "0.1.603",
      readState: () => ({ consecutiveFailures: 2 }),
      patchState: (patch) => Object.assign(state, patch),
    });
    await runAutoUpdateCheck(deps);
    expect(calls).toEqual([]);
    expect(state.consecutiveFailures).toBe(0);
  });

  test("连续三次检查失败后写入失败通知", async () => {
    const { calls, state, deps } = makeDeps({
      readState: () => ({ consecutiveFailures: 2 }),
      fetchLatestVersion: async () => null,
      patchState: (patch) => Object.assign(state, patch),
    });
    await runAutoUpdateCheck(deps);
    expect(calls).toEqual(["notice:failed"]);
    expect(state.consecutiveFailures).toBe(0);
  });

  test("当前版本为 prerelease 时跳过", async () => {
    const { calls, deps } = makeDeps({
      getCurrentVersion: () => "0.1.604-beta.1",
      fetchLatestVersion: async () => {
        calls.push("fetch");
        return "0.1.605";
      },
    });
    await runAutoUpdateCheck(deps);
    expect(calls).toEqual([]);
  });
});
