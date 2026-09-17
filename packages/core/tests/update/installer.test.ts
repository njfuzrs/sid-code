/**
 * 自动更新 — detached installer 进程测试
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const INSTALLER_MODULE = join(import.meta.dir, "../../src/update/installer.ts");

const originalConfigDir = process.env.SID_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
});

function waitFor(path: string, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function waitForRemoved(path: string, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function runInstaller(exitCode: number): {
  root: string;
  statePath: string;
  logPath: string;
  markerPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "sid-update-installer-"));
  const configDir = join(root, "config");
  const releaseScript = join(root, "install.sh");
  const markerPath = join(root, "env.txt");
  const statePath = join(configDir, "updates", "state.json");
  const logPath = join(configDir, "updates", "last-update.log");
  mkdirSync(join(configDir, "updates", "lock"), { recursive: true });
  writeFileSync(
    releaseScript,
    `#!/bin/bash
printf 'channel=%s\\nversion=%s\\nauto=%s\\n' "$SID_CODE_CHANNEL" "$SID_CODE_VERSION" "$SID_CODE_AUTO_UPDATE" > "$SID_CODE_TEST_MARKER"
printf 'fake installer exit %s\\n' '${exitCode}'
exit ${exitCode}
`,
    { mode: 0o700 },
  );

  const runner = `
    const { spawnBackgroundInstall } = await import(${JSON.stringify(pathToFileURL(INSTALLER_MODULE).href)});
    spawnBackgroundInstall("0.1.604", "0.1.603", ${JSON.stringify(join(configDir, "updates", "lock"))});
  `;
  const result = spawnSync("bun", ["--eval", runner], {
    encoding: "utf8",
    env: {
      ...process.env,
      SID_CONFIG_DIR: configDir,
      SID_CODE_INSTALL_URL: `file://${releaseScript}`,
      SID_CODE_CHANNEL: "beta",
      SID_CODE_VERSION: "0.1.500",
      SID_CODE_TEST_MARKER: markerPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `bun exited with ${result.status}`);
  }
  waitFor(statePath);
  waitForRemoved(join(configDir, "updates", "lock"));
  return { root, statePath, logPath, markerPath };
}

describe("spawnBackgroundInstall", () => {
  test("安装成功写入 success、updated 通知并释放锁", () => {
    const result = runInstaller(0);
    try {
      expect(existsSync(result.statePath)).toBe(true);
      const state = JSON.parse(readFileSync(result.statePath, "utf8"));
      expect(state.lastAttempt.status).toBe("success");
      expect(state.lastAttempt.fromVersion).toBe("0.1.603");
      expect(state.lastAttempt.toVersion).toBe("0.1.604");
      expect(state.pendingNotice.type).toBe("updated");
      expect(existsSync(join(result.root, "config", "updates", "lock"))).toBe(false);
      expect(readFileSync(result.logPath, "utf8")).toContain("fake installer exit 0");
      const env = readFileSync(result.markerPath, "utf8");
      expect(env).toContain("channel=stable");
      expect(env).toContain("version=");
      expect(env).toContain("auto=1");
      expect(env).not.toContain("version=0.1.500");
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  test("安装失败写入 failed、失败通知并释放锁", () => {
    const result = runInstaller(7);
    try {
      expect(existsSync(result.statePath)).toBe(true);
      const state = JSON.parse(readFileSync(result.statePath, "utf8"));
      expect(state.lastAttempt.status).toBe("failed");
      expect(state.lastAttempt.reason).toBe("install-exit:7");
      expect(state.pendingNotice.type).toBe("failed");
      expect(state.consecutiveFailures).toBe(1);
      expect(existsSync(join(result.root, "config", "updates", "lock"))).toBe(false);
      expect(readFileSync(result.logPath, "utf8")).toContain("fake installer exit 7");
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });
});
