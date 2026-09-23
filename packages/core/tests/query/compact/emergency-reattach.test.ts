/**
 * P2-22：emergency / blocking 截断的轻量文件恢复（只给路径清单，不带正文）
 *
 * 缺陷：`isBlocking` 与 `case "emergency"` 调 `emergencyTruncate()` 后只走 settleCompaction，
 * 完全没有恢复动作。重注入 50K 正文对这条路径不合适（刚截断腾出的空间立刻塞回去，
 * 下一轮必然再截断，而截断是有损的），但「最近文件路径列表」这种轻量恢复也没有 ——
 * 用户体感仍是断片。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEmergencyFilePathReattach,
  POST_COMPACT_MAX_FILES,
} from "../../../src/query/compact/reattach-files.ts";
import {
  REATTACH_FILE_PREFIX,
  REATTACH_ORIGIN,
} from "../../../src/query/compact/reattach-markers.ts";

/** 最小 tracker 替身：本函数只用 getRecentFiles。 */
function fakeTracker(files: string[]) {
  return { getRecentFiles: (limit: number) => files.slice(0, limit) } as any;
}

describe("buildEmergencyFilePathReattach", () => {
  it("无最近文件 → 空数组（不注入空壳消息）", () => {
    expect(buildEmergencyFilePathReattach(fakeTracker([]))).toEqual([]);
  });

  it("列出最近文件路径，且**不含任何文件正文**（紧急路径必须省 token）", () => {
    const msgs = buildEmergencyFilePathReattach(fakeTracker(["/a/x.ts", "/a/y.ts"]));
    expect(msgs).toHaveLength(1);
    const text = msgs[0].content[0].type === "text" ? msgs[0].content[0].text : "";
    expect(text).toContain("/a/x.ts");
    expect(text).toContain("/a/y.ts");
    // 关键区别：代码围栏是正文注入的标志，这条路径一个字节正文都不该有
    expect(text).not.toContain("```");
    // 并且要明确告诉模型「正文没恢复，需要就自己 read」，否则它会以为文件已在上下文里
    expect(text).toMatch(/正文未随本条消息恢复|直接 read/);
  });

  it("带 REATTACH 标记（TUI 隐藏 + 下次压缩前被 strip 剥离）", () => {
    const msgs = buildEmergencyFilePathReattach(fakeTracker(["/a/x.ts"]));
    const text = msgs[0].content[0].type === "text" ? msgs[0].content[0].text : "";
    expect(text.startsWith(REATTACH_FILE_PREFIX)).toBe(true);
    expect(msgs[0]._meta?.origin).toBe(REATTACH_ORIGIN);
  });

  it("受 maxFiles 上限约束（默认与 post-compact 同一个常量）", () => {
    const many = Array.from({ length: 20 }, (_, i) => `/f/${i}.ts`);
    const msgs = buildEmergencyFilePathReattach(fakeTracker(many));
    const text = msgs[0].content[0].type === "text" ? msgs[0].content[0].text : "";
    const listed = text.split("\n").filter((l) => l.startsWith("- "));
    expect(listed).toHaveLength(POST_COMPACT_MAX_FILES);
  });

  it("只产 user 消息 —— 角色交替由调用方按历史末尾补 ack", () => {
    const msgs = buildEmergencyFilePathReattach(fakeTracker(["/a/x.ts"]));
    expect(msgs.every((m) => m.role === "user")).toBe(true);
  });
});

describe("P2-22：两条截断路径都接线，且判据与横幅同源", () => {
  const loopSrc = readFileSync(join(import.meta.dir, "../../../src/query/loop.ts"), "utf-8");

  it("blocking 与 emergency 两处都调 emergencyFileReattach", () => {
    expect(loopSrc).toContain('emergencyFileReattach?.({ trigger: "threshold_blocking" })');
    expect(loopSrc).toContain('emergencyFileReattach?.({ trigger: "threshold_emergency" })');
  });

  it("app.ts 用 buildEmergencyFilePathReattach（而不是会读盘的 buildReattachFileMessages）", () => {
    const appSrc = readFileSync(join(import.meta.dir, "../../../../cli/src/app.ts"), "utf-8");
    const fn = appSrc.slice(
      appSrc.indexOf("private runEmergencyFileReattach"),
      appSrc.indexOf("private postCompactTraceSink"),
    );
    expect(fn).toContain("buildEmergencyFilePathReattach");
    expect(fn).not.toContain("buildReattachFileMessages");
  });
});
