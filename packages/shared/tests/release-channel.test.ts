/**
 * 发布通道标记读取 —— beta 用户必须在 --version / TUI 上看得出自己是预发布版。
 * 判据：标记文件内容 → 通道；无证据一律 stable（误标 beta 比漏标更误导）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CHANNEL_MARKER_FILE,
  _resetReleaseChannelCache,
  getChannelLabel,
  getReleaseChannel,
  readChannelMarker,
  resolveReleaseChannel,
} from "../src/release-channel.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sid-release-channel-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  _resetReleaseChannelCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readChannelMarker", () => {
  test("标记为 beta → beta（容忍换行）", () => {
    const d = tmp();
    writeFileSync(join(d, CHANNEL_MARKER_FILE), "beta\n");
    expect(readChannelMarker(d)).toBe("beta");
  });

  test("标记为 stable → stable", () => {
    const d = tmp();
    writeFileSync(join(d, CHANNEL_MARKER_FILE), "stable\n");
    expect(readChannelMarker(d)).toBe("stable");
  });

  test("无标记 / 未知值 → stable（不凭空打 beta 标）", () => {
    const d = tmp();
    expect(readChannelMarker(d)).toBe("stable");
    writeFileSync(join(d, CHANNEL_MARKER_FILE), "Beta\n");
    expect(readChannelMarker(d)).toBe("stable");
  });
});

describe("resolveReleaseChannel", () => {
  // dev 先判：本地 make build / 源码运行即使目录里恰好有 beta 标记，也必须显示 dev
  test("origin 不是 release → dev（无论有没有标记）", () => {
    const d = tmp();
    writeFileSync(join(d, CHANNEL_MARKER_FILE), "beta\n");
    for (const origin of ["local", "ci", "source", "unknown"] as const) {
      expect(resolveReleaseChannel(origin, d)).toBe("dev");
    }
  });

  test("origin=release：有 beta 标记 → beta，否则 stable", () => {
    const d = tmp();
    expect(resolveReleaseChannel("release", d)).toBe("stable");
    writeFileSync(join(d, CHANNEL_MARKER_FILE), "beta\n");
    expect(resolveReleaseChannel("release", d)).toBe("beta");
  });
});

describe("getChannelLabel", () => {
  test("只有正式版不显示标签", () => {
    expect(getChannelLabel("stable")).toBeUndefined();
    expect(getChannelLabel("beta")).toBe("beta 预发布版");
    expect(getChannelLabel("dev")).toBe("dev 本地开发版");
  });
});

describe("getReleaseChannel", () => {
  // 源码运行（bun test）没有编进字节的构建身份 → origin=source → dev
  test("源码运行判为 dev", () => {
    expect(getReleaseChannel(join(tmp(), "sid-code"))).toBe("dev");
  });
});

describe("readChannelMarker 经软链", () => {
  // 真实安装布局：~/.local/bin/sid-code 是软链，标记在软链目标旁边
  test("经软链定位到版本目录里的标记", () => {
    const root = tmp();
    const verDir = join(root, "versions", "0.1.700");
    const binDir = join(root, "bin");
    mkdirSync(verDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(verDir, "sid-code"), "");
    writeFileSync(join(verDir, CHANNEL_MARKER_FILE), "beta\n");
    symlinkSync(join(verDir, "sid-code"), join(binDir, "sid-code"));
    const real = realpathSync(join(binDir, "sid-code"));
    expect(readChannelMarker(dirname(real))).toBe("beta");
  });
});
