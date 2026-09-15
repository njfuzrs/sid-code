/**
 * 自动更新 — 通知读写单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writePendingNotice,
  consumePendingNotice,
  formatNoticeText,
  type PendingNotice,
} from "@sid-code/core/update/notify.ts";

describe("notify", () => {
  let tmpHome: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sid-update-notify-"));
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = tmpHome;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("无通知时 consumePendingNotice 返回 null", () => {
    const notice = consumePendingNotice();
    expect(notice).toBeNull();
  });

  test("writePendingNotice + consumePendingNotice 往返", () => {
    const notice: PendingNotice = {
      type: "updated",
      fromVersion: "0.1.602",
      toVersion: "0.1.603",
      createdAt: "2026-09-14T12:00:00.000Z",
    };
    writePendingNotice(notice);

    const consumed = consumePendingNotice();
    expect(consumed).not.toBeNull();
    expect(consumed!.type).toBe("updated");
    expect(consumed!.fromVersion).toBe("0.1.602");
    expect(consumed!.toVersion).toBe("0.1.603");
  });

  test("consumePendingNotice 消费后清空（同一条通知只展示一次）", () => {
    const notice: PendingNotice = {
      type: "available",
      toVersion: "0.1.603",
      createdAt: "2026-09-14T12:00:00.000Z",
    };
    writePendingNotice(notice);

    const first = consumePendingNotice();
    expect(first).not.toBeNull();

    const second = consumePendingNotice();
    expect(second).toBeNull(); // 已消费，第二次返回 null
  });

  test("formatNoticeText — updated 类型", () => {
    const notice: PendingNotice = {
      type: "updated",
      fromVersion: "0.1.602",
      toVersion: "0.1.603",
      createdAt: "2026-09-14T12:00:00.000Z",
    };
    const text = formatNoticeText(notice);
    expect(text).toContain("v0.1.603");
    expect(text).toContain("v0.1.602");
    expect(text).toContain("自动更新");
  });

  test("formatNoticeText — available 类型", () => {
    const notice: PendingNotice = {
      type: "available",
      toVersion: "0.1.604",
      createdAt: "2026-09-14T12:00:00.000Z",
    };
    const text = formatNoticeText(notice);
    expect(text).toContain("v0.1.604");
    expect(text).toContain("sid-code update");
  });

  test("formatNoticeText — failed 类型", () => {
    const notice: PendingNotice = {
      type: "failed",
      fromVersion: "0.1.602",
      toVersion: "0.1.603",
      createdAt: "2026-09-14T12:00:00.000Z",
    };
    const text = formatNoticeText(notice);
    expect(text).toContain("自动更新失败");
    expect(text).toContain("0.1.603"); // 括号内无 v 前缀
    expect(text).toContain("v0.1.602"); // 当前版本有 v 前缀
    expect(text).toContain("last-update.log");
  });

  test("formatNoticeText — failed 类型无 toVersion", () => {
    const notice: PendingNotice = {
      type: "failed",
      fromVersion: "0.1.602",
      createdAt: "2026-09-14T12:00:00.000Z",
    };
    const text = formatNoticeText(notice);
    expect(text).toContain("未知原因");
  });
});
