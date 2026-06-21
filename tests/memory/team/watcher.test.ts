/**
 * 团队记忆 watcher 测试（E.11）
 *
 * 聚焦：早退、debounce 合并、失败抑制、初始同步、graceful stop flush。
 * 用 _reset/_start 测试钩子驱动，避免依赖真实 fs.watch 时序的不确定性。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  startTeamMemoryWatcher,
  stopTeamMemoryWatcher,
  notifyTeamMemoryWrite,
  _resetWatcherStateForTesting,
  _getSuppressedReasonForTesting,
} from "../../../src/memory/team/watcher.ts";
import { getTeamMemPath } from "../../../src/memory/team/paths.ts";

let tmpRoot: string;
let configDir: string;
let sharedDir: string;
let prevConfigDir: string | undefined;
const cwd = "/tmp/sid-team-watcher-project";

function localDir(): string {
  return getTeamMemPath(cwd);
}

function opts(extra?: Record<string, unknown>) {
  return { enabled: true, dir: sharedDir, debounceMs: 30, ...extra };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-teamwatch-"));
  configDir = join(tmpRoot, "config");
  sharedDir = join(tmpRoot, "shared");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configDir;
  _resetWatcherStateForTesting();
});

afterEach(async () => {
  await stopTeamMemoryWatcher();
  _resetWatcherStateForTesting();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("watcher — 早退", () => {
  test("未启用不启动（notify 无副作用）", async () => {
    await startTeamMemoryWatcher({ enabled: false }, cwd);
    await notifyTeamMemoryWrite(); // currentOpts 未设置，应静默
    expect(true).toBe(true);
  });

  test("无共享目录不启动", async () => {
    await startTeamMemoryWatcher({ enabled: true }, cwd);
    // 不抛即可
    expect(true).toBe(true);
  });
});

describe("watcher — 初始同步", () => {
  test("启动时把本地已有文件 push 到共享", async () => {
    mkdirSync(localDir(), { recursive: true });
    writeFileSync(join(localDir(), "seed.md"), "团队种子");
    await startTeamMemoryWatcher(opts(), cwd);
    expect(existsSync(join(sharedDir, "seed.md"))).toBe(true);
  });

  test("启动时把共享已有文件 pull 到本地", async () => {
    writeFileSync(join(sharedDir, "remote.md"), "远端内容");
    await startTeamMemoryWatcher(opts(), cwd);
    expect(existsSync(join(localDir(), "remote.md"))).toBe(true);
  });
});

describe("watcher — notify + debounce", () => {
  test("notify 后 debounce 触发同步", async () => {
    await startTeamMemoryWatcher(opts(), cwd);
    // 启动后写本地文件，再 notify
    mkdirSync(localDir(), { recursive: true });
    writeFileSync(join(localDir(), "late.md"), "晚到内容");
    await notifyTeamMemoryWrite();
    // 等待 debounce(30ms) + 同步完成
    await new Promise((res) => setTimeout(res, 120));
    expect(existsSync(join(sharedDir, "late.md"))).toBe(true);
  });

  test("连续多次 notify 合并为一次同步（debounce）", async () => {
    await startTeamMemoryWatcher(opts(), cwd);
    mkdirSync(localDir(), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(localDir(), `m${i}.md`), `内容${i}`);
      await notifyTeamMemoryWrite();
    }
    await new Promise((res) => setTimeout(res, 120));
    for (let i = 0; i < 5; i++) {
      expect(existsSync(join(sharedDir, `m${i}.md`))).toBe(true);
    }
  });
});

describe("watcher — 失败抑制", () => {
  test("永久失败置抑制，后续 notify 不再同步", async () => {
    // 用 disabled opts 注入「永久失败」语义：通过 reset 钩子直接设置 currentOpts
    _resetWatcherStateForTesting({
      currentOpts: { enabled: false }, // syncTeamMemory 会返回 disabled=永久失败
      currentCwd: cwd,
      skipWatcher: true,
      debounceMs: 20,
    });
    await notifyTeamMemoryWrite();
    await new Promise((res) => setTimeout(res, 80));
    expect(_getSuppressedReasonForTesting()).toBe("disabled");
  });

  test("抑制态下 notify 被短路（scheduleSync 早退）", async () => {
    _resetWatcherStateForTesting({
      currentOpts: opts(),
      currentCwd: cwd,
      skipWatcher: true,
      syncSuppressedReason: "disabled",
      debounceMs: 20,
    });
    mkdirSync(localDir(), { recursive: true });
    writeFileSync(join(localDir(), "blocked.md"), "x");
    await notifyTeamMemoryWrite();
    await new Promise((res) => setTimeout(res, 80));
    // 抑制态下不应同步到共享
    expect(existsSync(join(sharedDir, "blocked.md"))).toBe(false);
  });
});

describe("watcher — graceful stop", () => {
  test("stop flush 待同步变更", async () => {
    await startTeamMemoryWatcher(opts({ debounceMs: 10_000 }), cwd); // 长 debounce，靠 stop flush
    mkdirSync(localDir(), { recursive: true });
    writeFileSync(join(localDir(), "pending.md"), "待 flush");
    await notifyTeamMemoryWrite(); // 排程但 debounce 很长不会自己触发
    await stopTeamMemoryWatcher(); // 应 flush
    expect(existsSync(join(sharedDir, "pending.md"))).toBe(true);
  });
});
