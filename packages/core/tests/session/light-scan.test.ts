/**
 * C1：会话轻量扫描器与全量扫描器的对照测试。
 *
 * 判据：同一批 fixture 上，`lightScanSessionFiles` 与 `getAllSessionFiles` 对每个文件给出
 * **相同的判定**（excludeReason / id / startTime / lastUpdated），且喂给 identifySessionsToDelete
 * 后得到**同一张待删清单**。删用户数据的判据只能有一套口径，两条扫描路径一旦分叉，
 * 自动清理就会删掉列表里看得见的会话（或者反过来留下垃圾）。
 *
 * 每类 fixture 同时造一份「小文件」和一份「大文件」（> FULL_READ_MAX_BYTES，走流式回放分支），
 * 两条分支都要和全量扫描器对得上。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { getAllSessionFiles, type SessionFileEntry } from "@sid-code/core/session/utils.ts";
import { lightScanSessionFiles, FULL_READ_MAX_BYTES } from "@sid-code/core/session/light-scan.ts";
import { identifySessionsToDelete } from "@sid-code/core/session/cleanup.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

let testDir: string;
let origConfigDir: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `sid-light-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, "sessions", "proj-a"), { recursive: true });
  origConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = testDir;
});

afterEach(() => {
  if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = origConfigDir;
  rmSync(testDir, { recursive: true, force: true });
});

const BIG = "x".repeat(FULL_READ_MAX_BYTES + 1024);

function ts(day: number, sec = 0): string {
  return new Date(Date.UTC(2026, 0, day, 0, 0, sec)).toISOString();
}

const start = (id: string, day: number) =>
  JSON.stringify({
    type: "session_start",
    version: "3",
    sessionId: id,
    model: "m",
    provider: "p",
    cwd: "/w",
    timestamp: ts(day),
  });
const user = (text: string, day: number, sec: number) =>
  JSON.stringify({
    type: "user_message",
    message: { role: "user", content: [{ type: "text", text }] },
    timestamp: ts(day, sec),
  });
const assistant = (text: string, day: number, sec: number) =>
  JSON.stringify({
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(day, sec),
  });
const meta = (key: string, value: unknown, day: number, sec: number) =>
  JSON.stringify({ type: "metadata", key, value, timestamp: ts(day, sec) });
const retract = (n: number, day: number, sec: number) =>
  JSON.stringify({ type: "prompt_retracted", dropCount: n, timestamp: ts(day, sec) });
const end = (day: number, sec: number) =>
  JSON.stringify({
    type: "session_end",
    totalCostUSD: 0,
    totalMessages: 2,
    timestamp: ts(day, sec),
  });

/** 每类形态一个生成器：pad = 是否塞一条超大消息把文件推过阈值 */
const FIXTURES: Record<string, (id: string, pad: boolean) => string[]> = {
  normal: (id, pad) => [
    start(id, 1),
    user(pad ? BIG : "hello", 1, 1),
    assistant("hi", 1, 2),
    meta("summary", "s", 1, 3),
    end(1, 4),
  ],
  // D4：撤回唯一一条（超大）用户输入 → 空会话，不可删
  emptyAfterRetract: (id, pad) => [start(id, 2), user(pad ? BIG : "oops", 2, 1), retract(1, 2, 2)],
  // D4：只有 session_start
  emptyOnly: (id, pad) => [start(id, 3), ...(pad ? [meta("note", BIG, 3, 1)] : [])],
  // D4：子代理会话
  subagent: (id, pad) => [
    start(id, 4),
    meta("kind", "subagent", 4, 1),
    user(pad ? BIG : "q", 4, 2),
    assistant("a", 4, 3),
  ],
  // D9：sidechain
  sidechain: (_id, pad) => [
    JSON.stringify({ type: "sidechain_start", agentId: "x", timestamp: ts(5) }),
    user(pad ? BIG : "q", 5, 1),
  ],
  // N1：首行坏了但有消息 → chain-broken
  chainBroken: (_id, pad) => ['{"type":"session_start","sessionId":', user(pad ? BIG : "q", 6, 1)],
  // 真损坏：没有 session_start 也没有消息
  parseError: (_id, pad) => ['{"garbage":', ...(pad ? [`"${BIG}"`] : [])],
  // 最后一条记录是 metadata：lastUpdated 必须取它的 timestamp
  trailingMeta: (id, pad) => [
    start(id, 7),
    user("q", 7, 1),
    assistant(pad ? BIG : "a", 7, 2),
    meta("session_name", "n", 7, 30),
  ],
};

function writeFixtures(): void {
  const dir = join(sidPaths.sessions(), "proj-a");
  for (const [name, gen] of Object.entries(FIXTURES)) {
    for (const pad of [false, true]) {
      const id = `${name}-${pad ? "big" : "small"}`;
      const file = join(dir, `${id}.jsonl`);
      writeFileSync(file, gen(id, pad).join("\n") + "\n");
      // 统一推到很久以前，让 minRetention 不挡判删
      const old = new Date(Date.UTC(2025, 0, 1));
      utimesSync(file, old, old);
    }
  }
}

/** 只比判删相关的字段 */
function shape(entries: SessionFileEntry[]) {
  return entries
    .map((e) => ({
      file: e.fileName,
      reason: e.excludeReason ?? null,
      id: e.sessionInfo?.id ?? null,
      start: e.sessionInfo?.startTime ?? null,
      last: e.sessionInfo?.lastUpdated ?? null,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

describe("轻量扫描器 ↔ 全量扫描器对照", () => {
  test("大文件确实走了流式分支（否则对照只验证了小文件）", () => {
    for (const [name, gen] of Object.entries(FIXTURES)) {
      const size = Buffer.byteLength(gen(name, true).join("\n"));
      expect(size, `${name} 的大文件 fixture 没超过阈值`).toBeGreaterThan(FULL_READ_MAX_BYTES);
    }
  });

  test("逐条判定一致", async () => {
    writeFixtures();
    const full = await getAllSessionFiles(sidPaths.sessions());
    const light = await lightScanSessionFiles(sidPaths.sessions());
    expect(full.length).toBe(Object.keys(FIXTURES).length * 2);
    expect(shape(light)).toEqual(shape(full));
  });

  test("关键形态的判定值本身（防两边一起错）", async () => {
    writeFixtures();
    const byFile = new Map(
      (await lightScanSessionFiles(sidPaths.sessions())).map((e) => [e.fileName, e]),
    );
    for (const size of ["small", "big"]) {
      expect(byFile.get(`normal-${size}.jsonl`)!.sessionInfo?.id).toBe(`normal-${size}`);
      expect(byFile.get(`emptyAfterRetract-${size}.jsonl`)!.excludeReason).toBe("empty");
      expect(byFile.get(`emptyOnly-${size}.jsonl`)!.excludeReason).toBe("empty");
      expect(byFile.get(`subagent-${size}.jsonl`)!.excludeReason).toBe("subagent");
      expect(byFile.get(`sidechain-${size}.jsonl`)!.excludeReason).toBe("sidechain");
      expect(byFile.get(`chainBroken-${size}.jsonl`)!.excludeReason).toBe("chain-broken");
      expect(byFile.get(`parseError-${size}.jsonl`)!.excludeReason).toBe("parse-error");
      expect(byFile.get(`trailingMeta-${size}.jsonl`)!.sessionInfo?.lastUpdated).toBe(ts(7, 30));
    }
  });

  test("喂给 identifySessionsToDelete 得到同一张待删清单", async () => {
    writeFixtures();
    const retention = { enabled: true, maxAge: "30d", minRetention: "1d" };
    const names = async (entries: SessionFileEntry[]) =>
      (await identifySessionsToDelete(entries, retention)).map((e) => e.fileName).sort();
    const fromFull = await names(await getAllSessionFiles(sidPaths.sessions()));
    const fromLight = await names(await lightScanSessionFiles(sidPaths.sessions()));
    expect(fromLight).toEqual(fromFull);
    // 清单里只能有「过期的正常会话」和「真损坏」，D4/D9/N1 的保护对象一个都不能出现
    for (const n of fromLight) {
      expect(
        n.startsWith("normal-") || n.startsWith("trailingMeta-") || n.startsWith("parseError-"),
      ).toBe(true);
    }
    expect(fromLight.length).toBe(6);
  });
});
