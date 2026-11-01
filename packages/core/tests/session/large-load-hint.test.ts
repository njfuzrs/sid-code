/**
 * R2：恢复巨型会话前的可见提示。只 stat，不读内容。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { largeSessionLoadHint } from "@sid-code/core/session/large-load-hint.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

let testDir: string;
let orig: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `sid-large-hint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  orig = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = testDir;
  mkdirSync(join(sidPaths.sessions(), "proj"), { recursive: true });
});

afterEach(() => {
  if (orig === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = orig;
  rmSync(testDir, { recursive: true, force: true });
});

describe("largeSessionLoadHint", () => {
  test("超阈值给出体积与预计耗时，并说明可取消", () => {
    writeFileSync(join(sidPaths.sessions(), "proj", "s1.jsonl"), "x".repeat(3 * 1024 * 1024));
    const h = largeSessionLoadHint("s1", 1024 * 1024);
    expect(h).not.toBeNull();
    expect(h!.bytes).toBe(3 * 1024 * 1024);
    expect(h!.message).toContain("3MB");
    expect(h!.message).toContain("Ctrl+C");
  });

  test("阈值以下不提示", () => {
    writeFileSync(join(sidPaths.sessions(), "proj", "s2.jsonl"), "x".repeat(1024));
    expect(largeSessionLoadHint("s2", 1024 * 1024)).toBeNull();
  });

  test("会话不存在不提示也不抛", () => {
    expect(largeSessionLoadHint("nope")).toBeNull();
  });
});
