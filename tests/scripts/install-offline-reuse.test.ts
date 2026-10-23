/**
 * install.sh 回滚离线可用：显式锁版本且本地版本目录已有能跑通的二进制时，不联网。
 *
 * 用 file:// 指向一个**空**发布目录（没有 tarball 也没有 sha256）真跑：
 * 只要脚本还去下载，就会在下载步 fail —— 这正是修复前的行为。
 * HOME / SID_CONFIG_DIR 全指进 tmpdir，不碰真实 ~/.local 与 ~/.sid-code。
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "install-template.sh");

function run(opts: { binBody: string; version?: string }) {
  const home = mkdtempSync(join(tmpdir(), "sid-offline-home-"));
  const release = mkdtempSync(join(tmpdir(), "sid-offline-release-"));
  const dir = join(home, ".local", "share", "sid-code", "versions", "0.1.600");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "sid-code");
  writeFileSync(bin, `#!/bin/sh\n${opts.binBody}\n`);
  chmodSync(bin, 0o755);
  try {
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        SHELL: "/bin/bash",
        SID_CONFIG_DIR: join(home, ".sid-code"),
        RELEASE_BASE: `file://${release}`,
        ...(opts.version ? { SID_CODE_VERSION: opts.version } : {}),
      },
    });
    let link: string | null = null;
    try {
      link = readlinkSync(join(home, ".local", "bin", "sid-code"));
    } catch {
      /* 没切软链 */
    }
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), link, bin };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  }
}

describe("install.sh：本地已有版本时离线复用", () => {
  test("锁版本 + 本地二进制能跑 → 不下载，切软链成功", () => {
    const r = run({ binBody: 'echo "sid-code 0.1.600"', version: "0.1.600" });
    expect(r.out).toContain("跳过下载");
    expect(r.out).not.toContain("下载:");
    expect(r.status).toBe(0);
    expect(r.link).toBe(r.bin);
  });

  test("本地二进制跑不通 → 不复用，退回下载（空发布目录下载失败）", () => {
    const r = run({ binBody: "exit 1", version: "0.1.600" });
    expect(r.out).not.toContain("跳过下载");
    expect(r.out).toContain("下载失败");
    expect(r.status).not.toBe(0);
    expect(r.link).toBeNull();
  });
});
