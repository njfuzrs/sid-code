/**
 * 粘贴截图回收测试（D18）
 *
 * 粘贴的截图写到 `{sidTemp}/pasted-images/`（`packages/cli/src/ui/utils/clipboard-image.ts`），
 * 此前全仓没有任何代码删它，而文档曾承诺「会话结束后清理」。截图可能含敏感内容，
 * 所以这里两侧都断言：超 7 天的删、7 天内的留（只断言"删了"对"删太多"是盲的）。
 *
 * 隔离：`SID_CODE_TMPDIR` 指向 mkdtemp 目录，并重置 temp-dir 的记忆化缓存 ——
 * 否则会扫到真实 /tmp/sid-code-<uid>/ 并删掉用户真实的截图。
 * mtime 一律用 utimesSync 推到过去，不用 maxAge=0（mtime 是浮点，刚写的文件差值可能为负）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStartupHousekeeping } from "@sid-code/core/config/startup-housekeeping.ts";
import { getSidTempDir, __resetSidTempDirCache } from "@sid-code/shared/utils/temp-dir.ts";

let tmpHome: string;
let tmpBase: string;
let prevConfigDir: string | undefined;
let prevTmpDir: string | undefined;

function ageBy(path: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 24 * 3600_000);
  utimesSync(path, t, t);
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-housekeeping-pasted-home-"));
  tmpBase = mkdtempSync(join(tmpdir(), "sid-housekeeping-pasted-tmp-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevTmpDir = process.env.SID_CODE_TMPDIR;
  process.env.SID_CONFIG_DIR = tmpHome;
  process.env.SID_CODE_TMPDIR = tmpBase;
  __resetSidTempDirCache();
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevTmpDir === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = prevTmpDir;
  __resetSidTempDirCache();
  for (const d of [tmpHome, tmpBase]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("粘贴截图回收（阈值 7 天，按 mtime 判）", () => {
  test("临时根目录确实被重定向到测试目录（防止误删真实截图）", () => {
    expect(getSidTempDir().startsWith(realpathSync(tmpBase))).toBe(true);
  });

  test("超 7 天的删、7 天内的留", () => {
    const dir = join(getSidTempDir(), "pasted-images");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, "paste-old.png");
    const fresh = join(dir, "paste-new.png");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    ageBy(stale, 8);
    ageBy(fresh, 6);

    runStartupHousekeeping(Date.now());

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh), "7 天内的截图被删了 —— 用户可能还要在本周会话里引用").toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  test("不递归删子目录", () => {
    const dir = join(getSidTempDir(), "pasted-images");
    const sub = join(dir, "subdir");
    mkdirSync(sub, { recursive: true });
    const inner = join(sub, "x.png");
    writeFileSync(inner, "x");
    ageBy(inner, 30);
    ageBy(sub, 30);

    runStartupHousekeeping(Date.now());

    expect(existsSync(inner)).toBe(true);
  });

  test("目录不存在时不抛异常", () => {
    expect(existsSync(join(getSidTempDir(), "pasted-images"))).toBe(false);
    expect(() => runStartupHousekeeping(Date.now())).not.toThrow();
  });
});
