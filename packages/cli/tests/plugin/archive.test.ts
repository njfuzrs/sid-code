/**
 * 市场插件包安全解包（P5）：zip slip / 链接 / 设备文件 / gzip 炸弹 / 重复条目。
 * 与服务端 package.py 的拒绝规则各写一份测试（方案 §5.5「两端各写一条」）。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  ArchiveError,
  ARCHIVE_LIMITS,
  extractTarGz,
  normalizeEntryPath,
  parseTarGz,
} from "@sid-code/cli/plugin/archive.ts";
import { buildTar, buildTarGz, pluginPackage } from "./tar-fixture.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sid-archive-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseTarGz：合法包", () => {
  test("普通文件与目录被解出，./ 前缀被去掉", async () => {
    const dest = tmp();
    const files = await extractTarGz(pluginPackage("demo", "1.0.0"), dest);
    expect(files).toEqual(["plugin.json", "skills/hello/SKILL.md"]);
    expect(JSON.parse(readFileSync(join(dest, "plugin.json"), "utf-8")).name).toBe("demo");
  });

  test("pax 扩展头里的长名生效", () => {
    const long = `skills/${"a".repeat(120)}/SKILL.md`;
    const entries = parseTarGz(buildTarGz([{ name: long, data: "x", pax: true }]));
    expect(entries.map((e) => e.path)).toEqual([long]);
  });

  test("系统 tar（macOS bsdtar / GNU tar）打出来的包能解", async () => {
    const src = tmp();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(src, "skills", "a"), { recursive: true });
    writeFileSync(join(src, "plugin.json"), JSON.stringify({ name: "sys", version: "1.0.0" }));
    writeFileSync(join(src, "skills", "a", "SKILL.md"), "hi");
    const out = join(tmp(), "p.tgz");
    // COPYFILE_DISABLE：不让 macOS 往包里塞 ._ AppleDouble 文件
    const proc = Bun.spawnSync(["tar", "czf", out, "-C", src, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    expect(proc.exitCode).toBe(0);
    const paths = parseTarGz(readFileSync(out)).map((e) => e.path);
    expect(paths).toContain("plugin.json");
    expect(paths).toContain("skills/a/SKILL.md");
  });
});

describe("parseTarGz：拒绝整包（fail-closed）", () => {
  const bad: Array<[string, Parameters<typeof buildTarGz>[0]]> = [
    ["`..` 穿越", [{ name: "../evil.sh", data: "x" }]],
    ["中段 `..`", [{ name: "skills/../../evil", data: "x" }]],
    ["绝对路径", [{ name: "/etc/cron.d/evil", data: "x" }]],
    ["pax 名字里藏 ..", [{ name: "../../.bashrc", data: "x", pax: true }]],
    ["盘符", [{ name: "C:/evil", data: "x" }]],
    ["反斜杠", [{ name: "..\\evil", data: "x" }]],
    ["符号链接", [{ name: "link", type: "2", linkname: "/etc/passwd" }]],
    ["硬链接", [{ name: "hard", type: "1", linkname: "/etc/passwd" }]],
    ["字符设备", [{ name: "dev", type: "3" }]],
    ["FIFO", [{ name: "fifo", type: "6" }]],
    [
      "重复条目",
      [
        { name: "a", data: "1" },
        { name: "./a", data: "2" },
      ],
    ],
    [
      "文件与目录同名",
      [
        { name: "a", data: "1" },
        { name: "a/b", data: "2" },
      ],
    ],
  ];
  for (const [label, entries] of bad) {
    test(label, () => {
      expect(() => parseTarGz(buildTarGz(entries))).toThrow(ArchiveError);
    });
  }

  test("符号链接 + 后续条目写穿链接：整包在解析阶段就被拒，磁盘上什么都没写", async () => {
    const dest = tmp();
    const outside = tmp();
    const archive = buildTarGz([
      { name: "plugin.json", data: "{}" },
      { name: "out", type: "2", linkname: outside },
      { name: "out/pwned", data: "x" },
    ]);
    await expect(extractTarGz(archive, dest)).rejects.toThrow(ArchiveError);
    expect(readdirSync(dest)).toEqual([]);
    expect(existsSync(join(outside, "pwned"))).toBe(false);
  });

  test("gzip 炸弹：解压后超上限即中止", () => {
    const huge = Buffer.alloc(ARCHIVE_LIMITS.maxUncompressedBytes + 1024, 0x41);
    const bomb = gzipSync(buildTar([{ name: "big", data: huge }]));
    expect(bomb.length).toBeLessThan(ARCHIVE_LIMITS.maxCompressedBytes);
    expect(() => parseTarGz(bomb)).toThrow(/解压后超过/);
  });

  test("不是 gzip", () => {
    expect(() => parseTarGz(Buffer.from("not a gzip"))).toThrow(/gzip/);
  });

  test("不是 ustar", () => {
    expect(() => parseTarGz(gzipSync(Buffer.alloc(1024, 0x41)))).toThrow(/ustar/);
  });
});

describe("normalizeEntryPath", () => {
  test("规范化", () => {
    expect(normalizeEntryPath("./a/./b/")).toBe("a/b");
    expect(normalizeEntryPath("./")).toBeNull();
    expect(normalizeEntryPath("a//b")).toBe("a/b");
  });
  test("`..` 作为文件名一部分是允许的（不是路径段）", () => {
    expect(normalizeEntryPath("a/b..c")).toBe("a/b..c");
  });
});
