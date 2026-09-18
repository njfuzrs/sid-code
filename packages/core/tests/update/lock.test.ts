/**
 * 自动更新 — mkdir 锁 + stale 回收单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock } from "@sid-code/core/update/lock.ts";

describe("lock", () => {
  let tmpHome: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sid-update-lock-"));
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = tmpHome;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("首次抢锁成功", () => {
    // 先创建 updates 父目录（lock 模块假设它已存在）
    mkdirSync(join(tmpHome, "updates"), { recursive: true });
    const handle = acquireLock();
    expect(handle).not.toBeNull();
    expect(existsSync(handle!.lockDir)).toBe(true);
    handle!.release();
    expect(existsSync(handle!.lockDir)).toBe(false); // 释放后锁目录删除
  });

  test("锁已被持有 → 第二次抢锁失败", () => {
    // 先创建 updates 父目录
    mkdirSync(join(tmpHome, "updates"), { recursive: true });
    const handle1 = acquireLock();
    expect(handle1).not.toBeNull();

    const handle2 = acquireLock();
    expect(handle2).toBeNull(); // 锁已被持有

    handle1!.release();
  });

  test("锁 stale（>30min）→ 重抢成功", () => {
    const lockDir = join(tmpHome, "updates", "lock");
    mkdirSync(lockDir, { recursive: true });

    // 写一个 31 分钟前的 meta
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const meta = {
      pid: 99999,
      startedAt: staleTime,
      host: "test-host",
    };
    writeFileSync(join(lockDir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });

    const handle = acquireLock();
    expect(handle).not.toBeNull(); // stale 锁被回收，重抢成功
    handle!.release();
  });

  test("锁未 stale（<30min）→ 重抢失败", () => {
    const lockDir = join(tmpHome, "updates", "lock");
    mkdirSync(lockDir, { recursive: true });

    // 写一个 10 分钟前的 meta
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const meta = {
      pid: 99999,
      startedAt: recentTime,
      host: "test-host",
    };
    writeFileSync(join(lockDir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });

    const handle = acquireLock();
    expect(handle).toBeNull(); // 锁未 stale，抢锁失败
  });

  test("meta.json 缺失 → 视为 stale，重抢成功", () => {
    const lockDir = join(tmpHome, "updates", "lock");
    mkdirSync(lockDir, { recursive: true });
    // 只创建锁目录，不写 meta.json

    const handle = acquireLock();
    expect(handle).not.toBeNull(); // meta 缺失，视为 stale
    handle!.release();
  });

  test("meta.startedAt 非法 → 视为 stale，重抢成功", () => {
    const lockDir = join(tmpHome, "updates", "lock");
    mkdirSync(lockDir, { recursive: true });

    const meta = {
      pid: 99999,
      startedAt: "invalid-date",
      host: "test-host",
    };
    writeFileSync(join(lockDir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });

    const handle = acquireLock();
    expect(handle).not.toBeNull(); // 非法日期，视为 stale
    handle!.release();
  });

  test("释放锁后 meta.json 一并删除", () => {
    // 先创建 updates 父目录
    mkdirSync(join(tmpHome, "updates"), { recursive: true });
    const handle = acquireLock();
    expect(handle).not.toBeNull();

    const metaPath = join(handle!.lockDir, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    handle!.release();
    expect(existsSync(handle!.lockDir)).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
  });
});
