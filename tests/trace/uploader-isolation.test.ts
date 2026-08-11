/**
 * UploadManager 队列路径隔离测试（建议1 补全）
 *
 * 背景：审计文档 P1-5 发现构造器接受 outputDir 选项并用它解析队列条目指向的
 * 文件路径，却把队列文件自身硬编码在全局 sidPaths.uploadQueue()。测试传
 * outputDir:tmpDir 以为隔离了，实际每跑一次就往真实 HOME 追加条目
 * （实测 1216 条 test-sess-001 垃圾）。
 *
 * 本测试断言修复后 retryQueuePath 确实从 outputDir 派生，落在 tmp 目录内，
 * 而非真实 $HOME。
 *
 * 对应审计文档建议1 第三子项：
 * 「传 tmp outputDir 断言队列文件落在 tmp 内」
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { UploadManager } from "@sid-code/core/trace/uploader.ts";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";

describe("UploadManager 队列路径隔离（建议1 补全）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `uploader-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("传 outputDir:tmpDir 时 retryQueuePath 落在 tmpDir 内", () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "test-token",
      outputDir: tmpDir,
    });

    // P1-5 修复后：retryQueuePath 应从 outputDir 派生
    const queuePath = (mgr as any).retryQueuePath as string;

    // 核心断言：队列文件必须落在 tmpDir 内，而非真实 HOME
    expect(queuePath.startsWith(tmpDir)).toBe(true);
    expect(queuePath).toBe(join(tmpDir, ".upload_queue.jsonl"));

    // 确保不落在真实 HOME
    const realHome = join(homedir(), ".sid-code");
    expect(queuePath.startsWith(realHome)).toBe(false);
  });

  test("默认 outputDir 时 retryQueuePath 从默认 trajectories 目录派生", () => {
    // 不传 outputDir，走默认值 sidPaths.trajectories()
    // 此时 retryQueuePath 应从默认 outputDir 派生（而非直接调 sidPaths.uploadQueue）
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "test-token",
    });

    const queuePath = (mgr as any).retryQueuePath as string;
    const outputDir = (mgr as any).opts.outputDir as string;

    // 队列文件应在 outputDir 下，而非全局 sidPaths.uploadQueue()
    expect(queuePath).toBe(join(outputDir, ".upload_queue.jsonl"));
  });

  test("去重：同一 (session_id, file) 不重复追加（P1-6）", () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "test-token",
      outputDir: tmpDir,
    });

    // 通过内部方法触发 appendToRetryQueue（需要 mock uploadFileWithRetry 让它失败入队）
    // 这里直接验证去重逻辑：调用两次 appendToRetryQueue 同一 sessionId+file
    const appendMethod = (mgr as any).appendToRetryQueue.bind(mgr);
    appendMethod("test-sess-dedup", "session.traj");
    appendMethod("test-sess-dedup", "session.traj"); // 应被去重跳过

    const queuePath = (mgr as any).retryQueuePath as string;
    const { readFileSync } = require("fs");
    const content = readFileSync(queuePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // 只应有 1 条（第二次被去重跳过）
    expect(lines.length).toBe(1);
  });
});
