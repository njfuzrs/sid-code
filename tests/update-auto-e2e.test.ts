/**
 * 自动更新 — latest.txt → install.sh → 安装 → 状态通知离线链路
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const INSTALL_TEMPLATE = join(ROOT, "scripts/install-template.sh");
const originalEnv = { ...process.env };

interface FakeRelease {
  releaseDir: string;
  home: string;
  oldBinary: string;
  newBinary: string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makeRelease(): FakeRelease {
  const root = mkdtempSync(join(tmpdir(), "sid-update-e2e-"));
  const releaseDir = join(root, "release");
  const home = join(root, "home");
  const oldBinary = join(root, "old-sid-code");
  const newBinary = join(root, "new-sid-code");
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(home, { recursive: true });

  writeFileSync(oldBinary, "#!/bin/bash\necho old\n", { mode: 0o700 });
  writeFileSync(newBinary, "#!/bin/bash\necho new\n", { mode: 0o700 });
  const version = "0.1.604";
  const versionDir = join(releaseDir, version);
  mkdirSync(versionDir, { recursive: true });
  const tarRoot = join(root, "payload", "sid-code");
  mkdirSync(tarRoot, { recursive: true });
  writeFileSync(join(tarRoot, "sid-code"), "#!/bin/bash\necho new\n", { mode: 0o700 });
  const tarball = join(
    versionDir,
    `sid-code-${version}-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`,
  );
  const archive = spawnSync("tar", ["-czf", tarball, "-C", join(root, "payload"), "sid-code"], {
    encoding: "utf8",
  });
  if (archive.status !== 0) throw new Error(archive.stderr);
  writeFileSync(`${tarball}.sha256`, `${sha256(tarball)}  ${tarball}\n`);
  writeFileSync(join(releaseDir, "latest.txt"), `${version}\n`);
  writeFileSync(join(releaseDir, "beta.txt"), `${version}\n`);

  return { releaseDir, home, oldBinary, newBinary };
}

function runInstall(releaseDir: string, home: string, extraEnv: Record<string, string> = {}) {
  const configDir = join(home, ".sid-code");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const oldPath = join(home, ".local", "bin", "sid-code");
  writeFileSync(oldPath, "#!/bin/bash\necho old\n", { mode: 0o700 });
  const result = spawnSync("bash", [INSTALL_TEMPLATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/bash",
      SID_CONFIG_DIR: configDir,
      RELEASE_BASE: `file://${releaseDir}`,
      ...extraEnv,
    },
  });
  return { result, oldPath };
}

function runLockWorker(
  lockModule: string,
  configDir: string,
  acquireDelayMs: number,
  holdMs: number,
): Promise<{ status: number | null; output: string }> {
  const script = `
    await new Promise((resolve) => setTimeout(resolve, ${acquireDelayMs}));
    const { acquireLock } = await import(${JSON.stringify(lockModule)});
    const lock = acquireLock();
    if (!lock) {
      console.log("busy");
      process.exit(0);
    }
    console.log("acquired");
    setTimeout(() => lock.release(), ${holdMs});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["-e", script], {
      env: { ...process.env, SID_CONFIG_DIR: configDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`锁 worker 超时: ${output}`));
    }, 5000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("自动更新离线安装链路", () => {
  test("stable latest.txt 安装成功并切换入口，失败前的旧入口不会被破坏", () => {
    const fixture = makeRelease();
    try {
      const { result, oldPath } = runInstall(fixture.releaseDir, fixture.home);
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      expect(result.status).toBe(0);
      expect(readFileSync(oldPath, "utf8")).toContain("new");
      expect(result.stdout).toContain("目标版本: v0.1.604（通道: stable）");
      expect(result.stdout).toContain("安装完成！v0.1.604");
    } finally {
      rmSync(join(fixture.releaseDir, "0.1.604"), { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  test("beta 通道读取 beta.txt，显式版本优先于 stable 指针", () => {
    const fixture = makeRelease();
    try {
      writeFileSync(join(fixture.releaseDir, "latest.txt"), "0.1.603\n");
      writeFileSync(join(fixture.releaseDir, "beta.txt"), "0.1.604\n");
      const { result } = runInstall(fixture.releaseDir, fixture.home, { SID_CODE_CHANNEL: "beta" });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("通道: beta");
      expect(result.stdout).toContain("目标版本: v0.1.604");
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(fixture.releaseDir, { recursive: true, force: true });
    }
  });

  test("下载失败时保持旧入口不变", () => {
    const fixture = makeRelease();
    try {
      rmSync(join(fixture.releaseDir, "0.1.604"), { recursive: true, force: true });
      const { result, oldPath } = runInstall(fixture.releaseDir, fixture.home);
      expect(result.status).not.toBe(0);
      expect(readFileSync(oldPath, "utf8")).toContain("old");
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(fixture.releaseDir, { recursive: true, force: true });
    }
  });

  test("并发抢锁时只有一个进程获得锁", async () => {
    const root = mkdtempSync(join(tmpdir(), "sid-update-lock-e2e-"));
    const configDir = join(root, "config");
    const lockModule = join(ROOT, "packages/core/src/update/lock.ts");
    try {
      const workers = await Promise.all([
        runLockWorker(lockModule, configDir, 0, 500),
        runLockWorker(lockModule, configDir, 100, 50),
      ]);
      expect(workers.filter(({ output }) => output.includes("acquired"))).toHaveLength(1);
      expect(workers.filter(({ output }) => output.includes("busy"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
