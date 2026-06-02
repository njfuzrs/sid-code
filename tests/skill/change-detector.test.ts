/**
 * Skill 文件监听热重载测试（Task 4）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillChangeDetector } from "../../src/skill/change-detector.ts";

describe("SkillChangeDetector", () => {
  test("监听不存在的目录不报错且不启动", () => {
    const detector = new SkillChangeDetector({ onChange: () => {} });
    detector.watchDirs([join(tmpdir(), "does-not-exist-xyz")]);
    expect(detector.isWatching()).toBe(false);
    detector.stop();
  });

  test("SKILL.md 变更触发防抖重载", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-watch-"));
    mkdirSync(join(dir, "my-skill"), { recursive: true });

    let fired = 0;
    let changedDirs: string[] = [];
    const detector = new SkillChangeDetector({
      debounceMs: 50,
      onChange: (dirs) => {
        fired++;
        changedDirs = dirs;
      },
    });
    detector.watchDirs([dir]);

    if (detector.isWatching()) {
      // 写入 .md 文件触发变更
      writeFileSync(join(dir, "my-skill", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody");
      // 等待防抖窗口
      await new Promise((r) => setTimeout(r, 250));
      expect(fired).toBeGreaterThanOrEqual(1);
      expect(changedDirs).toContain(dir);
    }

    detector.stop();
    expect(detector.isWatching()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("stop 后清理状态", () => {
    const detector = new SkillChangeDetector({ onChange: () => {} });
    const dir = mkdtempSync(join(tmpdir(), "skill-watch-stop-"));
    detector.watchDirs([dir]);
    detector.stop();
    expect(detector.isWatching()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
