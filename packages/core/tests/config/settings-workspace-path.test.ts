/**
 * P8：getSettings(workspacePath) 不能被 cwd 的会话缓存吞掉参数。
 *
 * 旧实现有会话缓存就直接返回，缓存键不含 workspacePath ——
 * worktree/config.ts 传 gitRoot 实际拿到的是 cwd 那份设置，零报错。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getSettings, getSettingsForSource } from "@sid-code/core/config/settings/settings.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";

const prevConfigDir = process.env.SID_CONFIG_DIR;
const prevCwd = process.cwd();

let root: string;
let cwdDir: string;
let otherDir: string;

function writeProjectSettings(dir: string, model: string): void {
  mkdirSync(join(dir, ".sid-code"), { recursive: true });
  writeFileSync(join(dir, ".sid-code", "settings.json"), JSON.stringify({ model }));
}

describe("P8 getSettings(workspacePath) 尊重参数", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sid-p8-"));
    process.env.SID_CONFIG_DIR = join(root, "home");
    mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
    cwdDir = join(root, "cwd");
    otherDir = join(root, "other");
    writeProjectSettings(cwdDir, "model-cwd");
    writeProjectSettings(otherDir, "model-other");
    process.chdir(cwdDir);
    resetSettingsCache();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    resetSettingsCache();
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test("会话缓存已建立后，传别的目录仍读到那个目录的设置", () => {
    expect(getSettings().settings.model).toBe("model-cwd");
    expect(getSettings(otherDir).settings.model).toBe("model-other");
  });

  test("先读别的目录不污染 cwd 的缓存", () => {
    expect(getSettings(otherDir).settings.model).toBe("model-other");
    expect(getSettings().settings.model).toBe("model-cwd");
    expect(getSettingsForSource("projectSettings").settings?.model).toBe("model-cwd");
  });

  test("传 cwd 本身仍走缓存口径（结果与无参一致）", () => {
    expect(getSettings(cwdDir).settings.model).toBe("model-cwd");
  });
});
