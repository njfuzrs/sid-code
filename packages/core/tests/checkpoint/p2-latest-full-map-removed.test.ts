/**
 * N8 门禁：`latestFullMap` 已删除（4 处维护 / 0 处消费的死字段）。
 *
 * 断言落在磁盘 index.json 上：新建 / 淘汰 / 读旧索引 / fork 继承四条写回路径
 * 都不得再落这个字段；淘汰后 restore 仍按线性倒扫找 full 基点，内容正确。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-ckpt-n8-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

function readIndex(sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sidPaths.checkpoints(sessionId), "index.json"), "utf-8"));
}

const newId = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("N8：latestFullMap 不再落盘", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), newId("ckpt-n8"));
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("createSnapshot + 淘汰后：index.json 无该字段，淘汰窗口内 restore 内容正确", async () => {
    const sid = newId("n8-evict");
    const m = new CheckpointManager(sid, { enabled: true, maxCheckpointsPerFile: 3 });
    await m.init();
    const f = join(dir, "a.txt");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      writeFileSync(f, `v${i}\n`);
      ids.push(await m.createSnapshot([f], "write", `e${i}`));
    }
    const idx = readIndex(sid);
    expect("latestFullMap" in idx).toBe(false);
    // 淘汰掉最旧 3 个后，s4 被重锚定为 full：restore 仍能重建出「改动前」的 v3。
    const r = await m.restoreToSnapshot(ids[3]!);
    expect(r).not.toBeNull();
    expect(readFileSync(f, "utf-8")).toBe("v3\n");
  });

  test("旧 index.json 带 latestFullMap：init 后下一次落盘即剥离", async () => {
    const sid = newId("n8-legacy");
    const base = sidPaths.checkpoints(sid);
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "index.json"),
      JSON.stringify({
        sessionId: sid,
        createdAt: Date.now(),
        nextId: 1,
        snapshots: [],
        latestFullMap: { "/x": "s0" },
      }),
    );
    const m = new CheckpointManager(sid, { enabled: true });
    await m.init();
    const f = join(dir, "b.txt");
    writeFileSync(f, "hello\n");
    await m.createSnapshot([f], "write", "e");
    expect("latestFullMap" in readIndex(sid)).toBe(false);
  });

  test("fork 继承旧索引：新会话 index.json 不带该字段", async () => {
    const src = newId("n8-src");
    const base = sidPaths.checkpoints(src);
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "index.json"),
      JSON.stringify({
        sessionId: src,
        createdAt: Date.now(),
        nextId: 2,
        snapshots: [
          {
            id: "s1",
            timestamp: Date.now(),
            toolName: "write",
            toolSummary: "x",
            files: [
              {
                filePath: join(dir, "c.txt"),
                existedBefore: true,
                type: "full",
                content: "c\n",
                compressed: false,
              },
            ],
          },
        ],
        latestFullMap: { [join(dir, "c.txt")]: "s1" },
      }),
    );
    const dst = newId("n8-dst");
    const m = new CheckpointManager(dst, { enabled: true });
    await m.init();
    expect(await m.inheritFrom(src)).toBe(1);
    expect("latestFullMap" in readIndex(dst)).toBe(false);
  });
});
