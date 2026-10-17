/**
 * S11：/debug 快照上传三态渲染。
 * 修复前「超时」与「失败」被渲染成同一句「上传失败…会话结束后自动重试」，而超时的上传
 * 并未取消、稍后成功——文案与事实相反。这里锁住三态各自的文案。
 */
import { describe, test, expect } from "bun:test";
import { renderSnapshotUploadStatus } from "../../src/command/commands/debug/debug.ts";
import { TODO_IN_PROGRESS } from "../../src/ui/constants/figures.ts";

describe("/debug 上传状态三态", () => {
  test("已上传", () => {
    expect(renderSnapshotUploadStatus({ uploaded: true }).join("\n")).toContain("✓ 已上传到云端");
  });

  test("超时 → 仍在后台上传，不说失败、不承诺会话结束后重试", () => {
    const out = renderSnapshotUploadStatus({ uploaded: false, pending: true }).join("\n");
    expect(out).toContain(`${TODO_IN_PROGRESS} 5s 内未完成，仍在后台上传`);
    expect(out).not.toContain("✗");
    expect(out).not.toContain("失败");
    expect(out).not.toContain("会话结束后");
  });

  test("真失败 → ✗ 并带错误原因", () => {
    const out = renderSnapshotUploadStatus({ uploaded: false, error: "HTTP 500" }).join("\n");
    expect(out).toContain("✗ 上传失败: HTTP 500");
    expect(out).not.toContain("会话结束后");
  });
});
