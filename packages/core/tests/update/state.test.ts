/**
 * 自动更新 — 状态文件读写单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readUpdateState,
  writeUpdateState,
  patchUpdateState,
  type UpdateState,
} from "@sid-code/core/update/state.ts";

describe("state", () => {
  let tmpHome: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sid-update-state-"));
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = tmpHome;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("state.json 不存在时返回空状态", () => {
    const state = readUpdateState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastCheckAt).toBeUndefined();
  });

  test("writeUpdateState 原子写入", () => {
    const state: UpdateState = {
      lastCheckAt: "2026-09-14T12:00:00.000Z",
      consecutiveFailures: 2,
      lastAttempt: {
        at: "2026-09-14T12:00:00.000Z",
        fromVersion: "0.1.602",
        toVersion: "0.1.603",
        status: "success",
      },
    };
    writeUpdateState(state);

    const statePath = join(tmpHome, "updates", "state.json");
    expect(existsSync(statePath)).toBe(true);

    const onDisk = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(onDisk.lastCheckAt).toBe("2026-09-14T12:00:00.000Z");
    expect(onDisk.consecutiveFailures).toBe(2);
    expect(onDisk.lastAttempt.status).toBe("success");
  });

  test("readUpdateState 往返", () => {
    const state: UpdateState = {
      lastCheckAt: "2026-09-14T12:00:00.000Z",
      consecutiveFailures: 3,
    };
    writeUpdateState(state);
    const read = readUpdateState();
    expect(read.lastCheckAt).toBe("2026-09-14T12:00:00.000Z");
    expect(read.consecutiveFailures).toBe(3);
  });

  test("patchUpdateState 合并更新", () => {
    writeUpdateState({
      lastCheckAt: "2026-09-14T12:00:00.000Z",
      consecutiveFailures: 0,
    });

    patchUpdateState({ consecutiveFailures: 5 });
    const read = readUpdateState();
    expect(read.lastCheckAt).toBe("2026-09-14T12:00:00.000Z"); // 未变
    expect(read.consecutiveFailures).toBe(5); // 已更新
  });

  test("损坏的 state.json 回退到空状态", () => {
    const statePath = join(tmpHome, "updates", "state.json");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(tmpHome, "updates"), { recursive: true });
    writeFileSync(statePath, "not valid json", { mode: 0o600 });

    const state = readUpdateState();
    expect(state.consecutiveFailures).toBe(0);
  });

  test("缺少 consecutiveFailures 字段时补 0", () => {
    const statePath = join(tmpHome, "updates", "state.json");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(tmpHome, "updates"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ lastCheckAt: "2026-09-14T12:00:00.000Z" }), {
      mode: 0o600,
    });

    const state = readUpdateState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastCheckAt).toBe("2026-09-14T12:00:00.000Z");
  });
});
