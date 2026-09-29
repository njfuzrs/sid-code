/**
 * N13 门禁：二进制文件的快照必须字节级往返。
 *
 * 修之前整条链路按 UTF-8 文本读写（`file.text()` → 存 string → `Bun.write(string)`），
 * 非法字节被有损替换成 U+FFFD：13 字节 PNG 头回滚成 23 字节垃圾，且不抛错。
 * 所有用例按生产时序：先 createSnapshot，再改文件（见 p0-undo-restore-semantics.test.ts 头注释）。
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { CheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** 文档 N13.3 那个样本：PNG 魔数 + NUL + 0xff 0xfe + 非法 UTF-8 续字节。 */
const PNG_HEAD = Buffer.from("89504e470001fffe800a00c328", "hex");

let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-ckpt-n13-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("N13：二进制快照字节级往返", () => {
  let dir: string;
  let mgr: CheckpointManager;

  beforeEach(async () => {
    dir = join(tmpdir(), `ckpt-n13-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    mgr = new CheckpointManager(`n13-${Date.now()}-${Math.random().toString(36).slice(2)}`, {
      enabled: true,
    });
    await mgr.init();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("bash rm 二进制 → /undo ⇒ 字节完全一致（修之前变成 23 字节 U+FFFD 垃圾）", async () => {
    const f = join(dir, "logo.png");
    writeFileSync(f, PNG_HEAD);
    await mgr.createSnapshot([f], "bash", "rm ./logo.png");
    rmSync(f);

    const r = await mgr.undo();
    expect(r).not.toBeNull();
    const back = readFileSync(f);
    expect(back.length).toBe(PNG_HEAD.length);
    expect(back.equals(PNG_HEAD)).toBe(true);
  });

  test("大二进制走压缩路径同样字节一致", async () => {
    const f = join(dir, "data.bin");
    const big = Buffer.alloc(64 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 131) & 0xff;
    writeFileSync(f, big);
    await mgr.createSnapshot([f], "bash", "rm ./data.bin");
    writeFileSync(f, Buffer.from("被覆盖"));

    const snap = mgr.getSnapshotDetail(mgr.listSnapshots()[0]!.id)!;
    expect(snap.files[0]).toMatchObject({ type: "full", binary: true, compressed: true });

    await mgr.undo();
    expect(readFileSync(f).equals(big)).toBe(true);
  });

  test("二进制多次改动 + restoreToSnapshot ⇒ 回到目标时刻的字节（不做 diff）", async () => {
    const f = join(dir, "a.bin");
    const v1 = Buffer.from([0x89, 0x00, 0xff, 0x01]);
    const v2 = Buffer.from([0x89, 0x00, 0xff, 0x02, 0x03]);
    writeFileSync(f, v1);
    const s1 = await mgr.createSnapshot([f], "bash", "cp x a.bin");
    writeFileSync(f, v2);
    await mgr.createSnapshot([f], "bash", "cp y a.bin");
    writeFileSync(f, Buffer.from([0x00]));

    for (const s of mgr.listSnapshots()) {
      const d = mgr.getSnapshotDetail(s.id)!;
      expect(d.files.every((x) => x.type === "full" && x.binary === true)).toBe(true);
    }

    const r = await mgr.restoreToSnapshot(s1);
    expect(r!.failedFiles).toEqual([]);
    expect(readFileSync(f).equals(v1)).toBe(true);
  });

  /** 文本 → 二进制 → 文本 三态，返回首个快照 id。 */
  async function textBinaryText(f: string): Promise<string> {
    writeFileSync(f, "纯文本\n第二行\n");
    const s1 = await mgr.createSnapshot([f], "write", "x.dat");
    writeFileSync(f, PNG_HEAD);
    await mgr.createSnapshot([f], "bash", "cp logo x.dat");
    writeFileSync(f, "又变回文本\n");
    return s1;
  }

  test("文本 → 二进制切换：/undo 回到二进制字节", async () => {
    const f = join(dir, "x.dat");
    await textBinaryText(f);
    await mgr.undo();
    expect(readFileSync(f).equals(PNG_HEAD)).toBe(true);
  });

  test("二进制 → 文本切换：restoreToSnapshot 回到文本（跨二进制条目重建）", async () => {
    const f = join(dir, "x.dat");
    const s1 = await textBinaryText(f);
    const r = await mgr.restoreToSnapshot(s1);
    expect(r!.failedFiles).toEqual([]);
    expect(readFileSync(f, "utf-8")).toBe("纯文本\n第二行\n");
  });

  test("文本文件保持原有行为：第二次存 diff，且字节往返（含 BOM）", async () => {
    const f = join(dir, "t.ts");
    const withBom = "﻿const a = 1;\n";
    writeFileSync(f, withBom);
    await mgr.createSnapshot([f], "edit", "t.ts");
    writeFileSync(f, "﻿const a = 2;\n");
    await mgr.createSnapshot([f], "edit", "t.ts");
    writeFileSync(f, "﻿const a = 3;\n");

    const [first, second] = mgr.listSnapshots().map((s) => mgr.getSnapshotDetail(s.id)!);
    expect(first!.files[0]).toMatchObject({ type: "full" });
    expect(first!.files[0]!.binary).toBeUndefined();
    expect(second!.files[0]!.type).toBe("diff");

    await mgr.undo();
    expect(readFileSync(f, "utf-8")).toBe("﻿const a = 2;\n");
    await mgr.undo();
    expect(readFileSync(f).equals(Buffer.from(withBom, "utf-8"))).toBe(true);
  });
});
