/**
 * N2 门禁：`-c`（loadLatest）不能被「最新但读不出」的文件遮住真会话。
 *
 * 修之前 loadLatest 只取 mtime 第一名、load 失败即返回 null。三种真实会出现的文件
 * （空壳 / 首行坏 / sidechain）都能让 `-c` 报「无会话可恢复」，而 `-r <id>` 正常。
 * 断言落在「拿回的是不是那个真会话、消息几条」，不是「没抛错」。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore, currentProjectSessionDir } from "@sid-code/core/session/store.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";

function mainSessionLines(sessionId: string, n: number): string {
  const lines = [
    JSON.stringify({
      type: "session_start",
      version: "3.0",
      sessionId,
      model: "m",
      provider: "p",
      cwd: "/tmp",
      timestamp: "2026-01-01T00:00:00.000Z",
      uuid: "u0",
      parentUuid: null,
    }),
  ];
  for (let i = 1; i <= n; i++) {
    lines.push(
      JSON.stringify({
        type: "user_message",
        message: { role: "user", content: [{ type: "text", text: `消息${i}` }] },
        timestamp: "2026-01-01T00:00:00.000Z",
        uuid: `u${i}`,
        parentUuid: `u${i - 1}`,
      }),
    );
  }
  return lines.join("\n") + "\n";
}

const SIDECHAIN_CONTENT =
  JSON.stringify({
    type: "sidechain_start",
    sessionId: "S-MAIN",
    agentId: "a1",
    agentType: "explore",
    description: "d",
    model: "m",
    timestamp: "2026-01-01T00:00:00.000Z",
  }) + "\n";

describe("N2：loadLatest 沿 mtime 降序回退，且排除 sidechain", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;
  let dir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-n2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
    dir = currentProjectSessionDir();
    mkdirSync(dir, { recursive: true });
    // 真会话：mtime 更旧。
    const main = join(dir, "S-MAIN.jsonl");
    writeFileSync(main, mainSessionLines("S-MAIN", 2));
    const old = new Date(Date.now() - 60_000);
    utimesSync(main, old, old);
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  const cases: Array<[string, string]> = [
    ["空 .jsonl（materialize 建壳后被 kill）", ""],
    ["首行坏掉", "{ 坏行\n"],
    ["sidechain 文件（首行 sidechain_start）", SIDECHAIN_CONTENT],
  ];

  for (const [label, content] of cases) {
    test(`最新文件是「${label}」⇒ 仍拿回真会话`, async () => {
      writeFileSync(join(dir, "S-MAIN-zz.jsonl"), content);
      const data = await new SessionStore().loadLatest();
      expect(data).not.toBeNull();
      expect(data!.id).toBe("S-MAIN");
      expect(data!.messages.length).toBe(2);
    });
  }

  test("全都读不出 ⇒ 返回 null（回退不臆造会话）", async () => {
    rmSync(join(dir, "S-MAIN.jsonl"));
    writeFileSync(join(dir, "X.jsonl"), "{ 坏\n");
    expect(await new SessionStore().loadLatest()).toBeNull();
  });

  test("sidechain 是唯一文件 ⇒ 返回 null（不把子代理对话当主会话）", async () => {
    rmSync(join(dir, "S-MAIN.jsonl"));
    writeFileSync(join(dir, "S-MAIN-a1.jsonl"), SIDECHAIN_CONTENT);
    expect(await new SessionStore().loadLatest()).toBeNull();
  });
});
