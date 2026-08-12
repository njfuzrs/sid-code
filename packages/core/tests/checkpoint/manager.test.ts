/**
 * CheckpointManager 集成测试
 * 测试批量快照、新文件删除、restore 等功能
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("CheckpointManager", () => {
  let testDir: string;
  let manager: CheckpointManager;
  let sessionId: string;

  beforeEach(async () => {
    // 创建临时测试目录
    testDir = join(tmpdir(), `checkpoint-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // 每个测试使用唯一的 sessionId
    sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 创建 CheckpointManager
    manager = new CheckpointManager(sessionId, { enabled: true });
    await manager.init();
  });

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("批量快照", () => {
    test("createSnapshot 可以保存多个文件", async () => {
      const file1 = join(testDir, "file1.txt");
      const file2 = join(testDir, "file2.txt");

      writeFileSync(file1, "content1");
      writeFileSync(file2, "content2");

      const snapshotId = await manager.createSnapshot([file1, file2], "write", "batch write");

      expect(snapshotId).toBeTruthy();

      const snapshots = manager.listSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].fileCount).toBe(2);
    });

    test("undo 回滚整组文件", async () => {
      const file1 = join(testDir, "file1.txt");
      const file2 = join(testDir, "file2.txt");

      writeFileSync(file1, "original1");
      writeFileSync(file2, "original2");

      await manager.createSnapshot([file1, file2], "write", "initial");

      // 修改文件
      writeFileSync(file1, "modified1");
      writeFileSync(file2, "modified2");

      await manager.createSnapshot([file1, file2], "edit", "modify");

      // 回滚
      const result = await manager.undo();
      expect(result).toBeTruthy();
      expect(result!.files).toHaveLength(2);

      // 验证文件内容恢复
      expect(readFileSync(file1, "utf-8")).toBe("original1");
      expect(readFileSync(file2, "utf-8")).toBe("original2");
    });
  });

  describe("新文件删除", () => {
    test("undo 新创建的文件时删除该文件", async () => {
      const newFile = join(testDir, "new.txt");

      // 创建快照（文件不存在）
      await manager.createSnapshot([newFile], "write", "create new");

      // 创建文件
      writeFileSync(newFile, "new content");

      // 回滚
      const result = await manager.undo();
      expect(result).toBeTruthy();
      expect(result!.files[0].action).toBe("deleted");

      // 验证文件被删除
      expect(existsSync(newFile)).toBe(false);
    });

    test("undoFile 可以删除指定的新文件", async () => {
      const file1 = join(testDir, "file1.txt");
      const file2 = join(testDir, "new.txt");

      writeFileSync(file1, "existing");

      await manager.createSnapshot([file1, file2], "write", "mixed");

      writeFileSync(file2, "new content");

      // 只回滚 file2
      const result = await manager.undoFile(file2);
      expect(result).toBeTruthy();
      expect(result!.files[0].action).toBe("deleted");

      // file2 被删除，file1 不受影响
      expect(existsSync(file2)).toBe(false);
      expect(existsSync(file1)).toBe(true);
    });
  });

  describe("快照列表", () => {
    test("listSnapshots 返回所有快照摘要", async () => {
      const file = join(testDir, "file.txt");
      writeFileSync(file, "v1");

      await manager.createSnapshot([file], "write", "version 1");

      writeFileSync(file, "v2");
      await manager.createSnapshot([file], "edit", "version 2");

      writeFileSync(file, "v3");
      await manager.createSnapshot([file], "edit", "version 3");

      const snapshots = manager.listSnapshots();
      expect(snapshots).toHaveLength(3);
      expect(snapshots[0].toolName).toBe("write");
      expect(snapshots[1].toolName).toBe("edit");
      expect(snapshots[2].toolName).toBe("edit");
    });

    test("getSnapshotDetail 返回完整快照信息", async () => {
      const file = join(testDir, "file.txt");
      writeFileSync(file, "content");

      const snapshotId = await manager.createSnapshot([file], "write", "test");

      const detail = manager.getSnapshotDetail(snapshotId);
      expect(detail).toBeTruthy();
      expect(detail!.id).toBe(snapshotId);
      expect(detail!.files).toHaveLength(1);
      expect(detail!.files[0].filePath).toBe(file);
    });
  });

  describe("指定版本恢复", () => {
    test("restoreToSnapshot 回滚到指定快照", async () => {
      const file = join(testDir, "file.txt");
      writeFileSync(file, "v1");

      const s1 = await manager.createSnapshot([file], "write", "v1");

      writeFileSync(file, "v2");
      await manager.createSnapshot([file], "edit", "v2");

      writeFileSync(file, "v3");
      await manager.createSnapshot([file], "edit", "v3");

      // 恢复到 s1
      const result = await manager.restoreToSnapshot(s1);
      expect(result).toBeTruthy();
      expect(result!.snapshotsRolledBack).toBe(2);

      // 验证文件内容
      expect(readFileSync(file, "utf-8")).toBe("v1");

      // 验证快照列表只剩 s1
      const snapshots = manager.listSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].id).toBe(s1);
    });

    test("restore 删除快照后新增的文件", async () => {
      const file1 = join(testDir, "file1.txt");
      const file2 = join(testDir, "file2.txt");

      writeFileSync(file1, "v1");
      const s1 = await manager.createSnapshot([file1], "write", "v1");

      // 创建新文件
      await manager.createSnapshot([file2], "write", "new file");
      writeFileSync(file2, "new content");

      // 恢复到 s1
      const result = await manager.restoreToSnapshot(s1);
      expect(result).toBeTruthy();

      // file2 应该被删除
      expect(existsSync(file2)).toBe(false);
      expect(existsSync(file1)).toBe(true);
    });
  });

  describe("配置化", () => {
    test("disabled 时不创建快照", async () => {
      const disabledMgr = new CheckpointManager("test", { enabled: false });
      await disabledMgr.init();

      const file = join(testDir, "file.txt");
      writeFileSync(file, "content");

      const snapshotId = await disabledMgr.createSnapshot([file], "write", "test");
      expect(snapshotId).toBe("");

      const snapshots = disabledMgr.listSnapshots();
      expect(snapshots).toHaveLength(0);
    });

    test("disabled 时 undo 返回 null", async () => {
      const disabledMgr = new CheckpointManager("test", { enabled: false });
      await disabledMgr.init();

      const result = await disabledMgr.undo();
      expect(result).toBeNull();
    });
  });

  describe("旧格式迁移", () => {
    test("加载旧格式索引时自动迁移", async () => {
      // 模拟旧格式索引
      const legacyIndex = {
        sessionId: "legacy",
        createdAt: Date.now(),
        files: {
          "/tmp/file1.txt": {
            filePath: "/tmp/file1.txt",
            entries: [
              {
                filePath: "/tmp/file1.txt",
                timestamp: Date.now(),
                type: "full" as const,
                content: "content1",
                compressed: false,
              },
            ],
          },
        },
      };

      // 写入旧格式索引
      const legacyMgr = new CheckpointManager("legacy", { enabled: true });
      const indexPath = join(legacyMgr["baseDir"], "index.json");
      mkdirSync(legacyMgr["baseDir"], { recursive: true });
      writeFileSync(indexPath, JSON.stringify(legacyIndex));

      // 加载并验证迁移
      await legacyMgr.init();
      const snapshots = legacyMgr.listSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].fileCount).toBe(1);
    });
  });
});
