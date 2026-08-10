/**
 * TrustManager 测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TrustManager } from "../../src/extension/trust.ts";

describe("TrustManager", () => {
  let testDir: string;
  let manager: TrustManager;

  beforeEach(() => {
    testDir = join(tmpdir(), `trust-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    manager = new TrustManager();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("computeHash 应该返回一致的 SHA-256 hash", () => {
    const content = "test content";
    const hash1 = manager.computeHash(content);
    const hash2 = manager.computeHash(content);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex 长度
  });

  test("computeHash 对不同内容返回不同 hash", () => {
    const hash1 = manager.computeHash("content 1");
    const hash2 = manager.computeHash("content 2");

    expect(hash1).not.toBe(hash2);
  });

  test("isTrusted 对未信任的文件返回 false", async () => {
    const isTrusted = await manager.isTrusted(
      "/path/to/file.md",
      "content",
      "/project",
    );

    expect(isTrusted).toBe(false);
  });

  test("trust 后 isTrusted 返回 true", async () => {
    const filePath = "/path/to/file.md";
    const content = "test content";
    const projectDir = "/project";

    await manager.trust(filePath, content, projectDir);
    const isTrusted = await manager.isTrusted(filePath, content, projectDir);

    expect(isTrusted).toBe(true);
  });

  test("内容变更后 isTrusted 返回 false", async () => {
    const filePath = "/path/to/file.md";
    const projectDir = "/project";

    await manager.trust(filePath, "original content", projectDir);
    const isTrusted = await manager.isTrusted(filePath, "modified content", projectDir);

    expect(isTrusted).toBe(false);
  });

  test("trustBatch 应该批量记录信任", async () => {
    const projectDir = "/project";
    const files = [
      { filePath: "/path/to/file1.md", content: "content 1" },
      { filePath: "/path/to/file2.md", content: "content 2" },
    ];

    await manager.trustBatch(files, projectDir);

    const trusted1 = await manager.isTrusted(files[0].filePath, files[0].content, projectDir);
    const trusted2 = await manager.isTrusted(files[1].filePath, files[1].content, projectDir);

    expect(trusted1).toBe(true);
    expect(trusted2).toBe(true);
  });

  test("不同项目的信任记录应该隔离", async () => {
    const filePath = "/path/to/file.md";
    const content = "content";

    await manager.trust(filePath, content, "/project1");

    const trusted1 = await manager.isTrusted(filePath, content, "/project1");
    const trusted2 = await manager.isTrusted(filePath, content, "/project2");

    expect(trusted1).toBe(true);
    expect(trusted2).toBe(false);
  });

  test("removeTrust 应该移除项目的所有信任记录", async () => {
    const projectDir = "/project";
    const filePath = "/path/to/file.md";
    const content = "content";

    await manager.trust(filePath, content, projectDir);
    expect(await manager.isTrusted(filePath, content, projectDir)).toBe(true);

    await manager.removeTrust(projectDir);
    expect(await manager.isTrusted(filePath, content, projectDir)).toBe(false);
  });
});
