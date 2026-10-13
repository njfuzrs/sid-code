/**
 * 补传水位（P0-3）测试
 *
 * 锁死方案文档验收判据 2 的四条：
 *   1. 新配置上传后，只补传配置之后产生的会话；
 *   2. resume 一个配置前的会话（刷新目录 mtime）后，它仍不被补传；
 *   3. 换上传地址后，旧历史不发往新地址；
 *   4. 升级时已配置上传的用户，积压照常补传（迁移语义，数量与升级前一致）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureUploadWatermarks,
  getUploadWatermark,
  sessionCreatedAtMs,
  uploadTargetKey,
} from "@sid-code/core/trace/upload-watermark.ts";
import { scanPendingUploads } from "@sid-code/core/trace/backfill.ts";

/** 按本地时间生成会话 id（与 generateSessionId 同格式） */
function idAt(d: Date, suffix: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${suffix}`
  );
}

function mkSession(root: string, id: string, opts: { uploaded?: boolean } = {}): string {
  const dir = join(root, "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.traj"), '{"metadata":{}}');
  writeFileSync(join(dir, "events.jsonl"), '{"event":"SessionStart"}\n');
  if (opts.uploaded) writeFileSync(join(dir, ".uploaded"), "{}");
  const t = (Date.now() - 10 * 60 * 1000) / 1000;
  utimesSync(dir, t, t);
  return dir;
}

const DAY = 24 * 3600 * 1000;
const URL_A = "https://a.example.com/traj";
const URL_B = "https://b.example.com/traj";

describe("补传水位", () => {
  let root: string;
  let statePath: string;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const oldId = idAt(new Date(now - 30 * DAY), "aaaaaaaa");
  const newId = idAt(new Date(now + 5 * 1000), "bbbbbbbb");

  beforeEach(() => {
    root = join(tmpdir(), `wm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "sessions"), { recursive: true });
    statePath = join(root, "state", "upload-watermarks.json");
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  const pendingIds = (wm: number) =>
    scanPendingUploads({ outputDir: root, watermarkMs: wm }).pending.map((p) => p.sessionId);

  test("升级时未配上传、之后才配：只补传配置之后的会话", () => {
    mkSession(root, oldId);
    ensureUploadWatermarks(undefined, { outputDir: root, statePath, nowMs: now }); // 升级首启
    mkSession(root, newId);
    const wm = getUploadWatermark(URL_A, { outputDir: root, statePath, nowMs: now + 10 * DAY });
    // 配置时刻在 newId 之后，所以两者都在水位前
    expect(pendingIds(wm)).toEqual([]);
    const later = idAt(new Date(now + 11 * DAY), "cccccccc");
    mkSession(root, later);
    expect(pendingIds(wm)).toEqual([later]);
    const { stats } = scanPendingUploads({ outputDir: root, watermarkMs: wm });
    expect(stats.beforeWatermark).toBe(2);
  });

  test("resume 旧会话刷新 mtime 后仍不被补传（比较的是创建时间）", () => {
    ensureUploadWatermarks(undefined, { outputDir: root, statePath, nowMs: now - DAY });
    const wm = getUploadWatermark(URL_A, { outputDir: root, statePath, nowMs: now });
    const dir = mkSession(root, oldId);
    // 模拟 resume：目录 mtime 推到水位之后（仍满足 minAgeMs）
    const t = (now + 1000) / 1000;
    utimesSync(dir, t, t);
    expect(pendingIds(wm)).toEqual([]);
  });

  test("换上传地址：A 未传的历史不会发往 B", () => {
    mkSession(root, oldId);
    // 升级时已配 A：迁移语义，A 的水位落在最早未上传会话
    ensureUploadWatermarks(URL_A, { outputDir: root, statePath, nowMs: now });
    const wmA = getUploadWatermark(URL_A, { outputDir: root, statePath, nowMs: now });
    expect(pendingIds(wmA)).toEqual([oldId]);
    // 改配 B：新目标从「现在」起算
    const wmB = getUploadWatermark(URL_B, { outputDir: root, statePath, nowMs: now + DAY });
    expect(pendingIds(wmB)).toEqual([]);
  });

  test("迁移：升级时已配上传，积压数与升级前（无水位）一致", () => {
    mkSession(root, oldId);
    mkSession(root, idAt(new Date(now - 10 * DAY), "dddddddd"));
    mkSession(root, idAt(new Date(now - 40 * DAY), "eeeeeeee"), { uploaded: true });
    const before = scanPendingUploads({ outputDir: root }).pending.length;
    ensureUploadWatermarks(URL_A, { outputDir: root, statePath, nowMs: now });
    const wm = getUploadWatermark(URL_A, { outputDir: root, statePath, nowMs: now + DAY });
    expect(pendingIds(wm).length).toBe(before);
    expect(before).toBe(2);
  });

  test("状态文件已存在时 ensure 不改写已有目标的水位（幂等）", () => {
    mkSession(root, oldId);
    ensureUploadWatermarks(URL_A, { outputDir: root, statePath, nowMs: now });
    const first = readFileSync(statePath, "utf-8");
    ensureUploadWatermarks(URL_A, { outputDir: root, statePath, nowMs: now + 5 * DAY });
    expect(readFileSync(statePath, "utf-8")).toBe(first);
  });

  test("目标键按 origin+path 规范化，尾斜杠不算新目标", () => {
    expect(uploadTargetKey("https://a.example.com/traj/")).toBe(uploadTargetKey(URL_A));
    expect(uploadTargetKey("https://a.example.com/other")).not.toBe(uploadTargetKey(URL_A));
  });
});

describe("会话创建时间解析", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `ct-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("新格式 id 按本地时区解析前缀", () => {
    const d = new Date(2026, 9, 13, 14, 43, 55);
    expect(sessionCreatedAtMs(idAt(d, "55d78fac"), root)).toBe(d.getTime());
  });

  test("旧格式 id 回落 events.jsonl 首行 timestamp", () => {
    writeFileSync(
      join(root, "events.jsonl"),
      '{"event":"SessionStart","timestamp":"2026-09-24T04:19:02.304Z"}\n',
    );
    expect(sessionCreatedAtMs("e13aed18-d011-415e-8f93-4004fa8bba72", root)).toBe(
      Date.parse("2026-09-24T04:19:02.304Z"),
    );
  });

  test("再回落 session.traj 的 start_time", () => {
    writeFileSync(
      join(root, "session.traj"),
      '{"metadata":{"start_time":"2026-09-01T00:00:00.000Z"}}',
    );
    expect(sessionCreatedAtMs("deadbeef", root)).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
  });

  test("都取不到 → null，扫描时按水位前处理（fail-closed）", () => {
    expect(sessionCreatedAtMs("deadbeef", root)).toBeNull();
    const out = join(root, "out");
    const dir = join(out, "sessions", "deadbeef");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.traj"), "{}");
    writeFileSync(join(dir, "events.jsonl"), "not json\n");
    const t = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(dir, t, t);
    const { pending, stats } = scanPendingUploads({ outputDir: out, watermarkMs: 0 });
    expect(pending).toEqual([]);
    expect(stats.beforeWatermark).toBe(1);
  });
});
