/**
 * 测试用 ustar 写入器：能造出系统 tar 不肯造的恶意条目（`..`、绝对路径、符号链接、设备文件）。
 * 只在测试里用，生产代码不写 tar。
 */

import { gzipSync } from "node:zlib";

export interface FixtureEntry {
  name: string;
  /** '0' 文件 / '5' 目录 / '2' 符号链接 / '1' 硬链接 / '3' 字符设备 ... */
  type?: string;
  data?: string | Buffer;
  linkname?: string;
  /** 用 pax 扩展头写名字（长名 / 绕过 100 字节字段） */
  pax?: boolean;
}

function header(name: string, size: number, type: string, linkname = ""): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, "utf-8");
  h.write("0000644\0", 100, "ascii");
  h.write("0000000\0", 108, "ascii");
  h.write("0000000\0", 116, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  h.write("00000000000\0", 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write(linkname.slice(0, 100), 157, "utf-8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

function pad(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]);
}

export function buildTar(entries: FixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "0";
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    if (e.pax) {
      const rec = ` path=${e.name}\n`;
      let len = rec.length + 1;
      while (`${len}${rec}`.length !== len) len = `${len}${rec}`.length;
      const paxData = Buffer.from(`${len}${rec}`);
      parts.push(header("PaxHeader/x", paxData.length, "x"), pad(paxData));
      parts.push(header("placeholder", type === "0" ? data.length : 0, type, e.linkname));
    } else {
      parts.push(header(e.name, type === "0" ? data.length : 0, type, e.linkname));
    }
    if (type === "0" && data.length > 0) parts.push(pad(data));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

export function buildTarGz(entries: FixtureEntry[]): Buffer {
  return gzipSync(buildTar(entries));
}

/** 一个最小合法插件包 */
export function pluginPackage(
  name: string,
  version: string,
  extra: FixtureEntry[] = [],
  manifestExtra: Record<string, unknown> = {},
): Buffer {
  return buildTarGz([
    { name: "./", type: "5" },
    {
      name: "./plugin.json",
      data: JSON.stringify({ name, version, description: `${name} 测试插件`, ...manifestExtra }),
    },
    { name: "./skills/", type: "5" },
    { name: "./skills/hello/", type: "5" },
    {
      name: "./skills/hello/SKILL.md",
      data: "---\nname: hello\ndescription: 打招呼\n---\n\n说你好",
    },
    ...extra,
  ]);
}
