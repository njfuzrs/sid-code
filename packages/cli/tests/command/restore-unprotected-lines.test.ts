/**
 * `/restore` 确认面板：未进快照目标的文案必须按 `reason` 分类（P4 后续）。
 *
 * 修之前的洞：面板只读 `bytes` 并按「超过单文件上限 (N.NMB)」统一渲染，
 * 而非普通文件与不可读路径的 `bytes` 恒为 0 ⇒ 目录/设备/ENOTDIR 路径被说成
 * 「超过单文件上限」，并显示毫无意义的 `0.0MB`。这与 `Snapshot.skippedFiles`
 * 字段注释里「展示层据此选文案」的承诺相反，也是同一类「静默的不完整保护」。
 *
 * 抽成纯函数 `formatUnprotectedLines` 就是为了让文案能被这里直接锁住——
 * 走 `RestoreCommand.call` 需要构造整个 CommandContext，成本远大于收益。
 */

import { describe, test, expect } from "bun:test";
import { formatUnprotectedLines } from "../../src/command/commands/restore/restore.ts";

describe("/restore 未进快照目标的文案", () => {
  test("空输入不产出任何行（不能凭空多一个空行）", () => {
    expect(formatUnprotectedLines([])).toEqual([]);
  });

  test("超限文件保持原有文案与 MB 展示（既有行为不回归）", () => {
    const text = formatUnprotectedLines([{ filePath: "/big.bin", bytes: 8 * 1024 * 1024 }]).join(
      "\n",
    );
    expect(text).toContain("另有 1 个文件超过单文件上限");
    expect(text).toContain("/big.bin (8.0MB)");
  });

  test("目录/设备不被说成「超过单文件上限」，也不显示 0.0MB", () => {
    const text = formatUnprotectedLines([
      { filePath: "/dev/null", bytes: 0, reason: "non-regular" },
    ]).join("\n");
    expect(text).toContain("另有 1 个非普通文件");
    expect(text).not.toContain("超过单文件上限");
    expect(text).not.toContain("0.0MB");
  });

  test("无法判定类型的路径单独成组，不说成设备文件", () => {
    const text = formatUnprotectedLines([
      { filePath: "/a/blocker.bin/sub/note.md", bytes: 0, reason: "unreadable" },
    ]).join("\n");
    expect(text).toContain("另有 1 个路径无法判定类型");
    expect(text).not.toContain("非普通文件");
    expect(text).not.toContain("超过单文件上限");
  });

  test("三类混在一起时各成一组，同一路径只出现一次", () => {
    const text = formatUnprotectedLines([
      { filePath: "/big.bin", bytes: 6 * 1024 * 1024 },
      { filePath: "/dir", bytes: 0, reason: "non-regular" },
      { filePath: "/dir", bytes: 0, reason: "non-regular" },
      { filePath: "/bad/x", bytes: 0, reason: "unreadable" },
    ]).join("\n");
    expect(text).toContain("另有 1 个文件超过单文件上限");
    expect(text).toContain("另有 1 个非普通文件");
    expect(text).toContain("另有 1 个路径无法判定类型");
    // 同一路径出现在多个快照里 → 只渲染一次（原实现的 Map 去重语义不能丢）
    expect(text.match(/\/dir/g)?.length).toBe(1);
  });

  test("超过 5 个时截断并提示剩余数量", () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      filePath: `/dir${i}`,
      bytes: 0,
      reason: "non-regular" as const,
    }));
    const text = formatUnprotectedLines(entries).join("\n");
    expect(text).toContain("另有 8 个非普通文件");
    expect(text).toContain("... 还有 3 个");
  });
});
