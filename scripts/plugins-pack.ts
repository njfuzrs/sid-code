#!/usr/bin/env bun
/**
 * 仓内插件打包：plugins/<name>/ → tar.gz + 静态市场 index（内置 skill 下沉方案 §6.1）。
 *
 * 产物（默认 dist/plugins/，dist/ 已在 .gitignore）：
 *   index.json                               与 agent-backend 同一份契约：
 *                                            {schema:1, name:"sid-code", plugins:[{name, version, sha256,
 *                                             size, artifact, components, versions}]}
 *   artifacts/<name>/<version>.tar.gz        artifact 相对 index 解析（market.ts resolveArtifactUrl）
 *
 * 用法：
 *   bun run scripts/plugins-pack.ts                 # 打包到 dist/plugins/
 *   bun run scripts/plugins-pack.ts --out <dir>
 *   bun run scripts/plugins-pack.ts --check         # 只校验能打包 + 能被客户端解析，不写盘
 *
 *   bun run scripts/plugins-pack.ts --release-prep <name> --remote-index <file> --out <dir>
 *                                                   # 发布前置：单插件打包 + 合并远端 index
 *
 * 本脚本**只打包不发布**。上传到 www.sid-code.cc 是 scripts/plugins-release.sh，
 * 由维护者本机跑（CI 不持有服务器写凭据，方案 §7）。
 *
 * 为什么自己写 ustar 而不是调系统 `tar`：
 * - 产物要**字节级确定**（同一份源码 → 同一个 sha256），否则「版本不可覆盖」的判据无从谈起。
 *   系统 tar 会写入 mtime / uid / uname，macOS bsdtar 还会塞 `._*` 与 pax 扩展属性；
 * - 客户端 archive.ts 只接受普通文件与目录，这里写出来的就只有这两种，和解包规则一一对应。
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const PLUGINS_ROOT = join(REPO_ROOT, "plugins");
/** 官方市场名（P2 的多市场里官方市场就叫这个） */
export const OFFICIAL_MARKET_NAME = "sid-code";

/** 不进包的路径：测试目录是仓内共享的，不属于任何一个插件 */
const NON_PLUGIN_DIRS = new Set(["tests"]);
/** 与服务端 package.py / 客户端 archive.ts 同口径的上限 */
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

export interface PluginComponents {
  skills: string[];
  commands: string[];
  agents: string[];
  hooks: string[];
  mcpServers: never[];
}

export interface PackedPlugin {
  name: string;
  version: string;
  description: string;
  archive: Buffer;
  sha256: string;
  size: number;
  files: string[];
  components: PluginComponents;
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

// ─── ustar 写入 ───────────────────────────────────────────────────────

function writeField(buf: Buffer, offset: number, len: number, value: string): void {
  const bytes = Buffer.from(value, "utf-8");
  if (bytes.length > len) throw new PackError(`tar 头字段超长: ${value}`);
  bytes.copy(buf, offset);
}

function octal(n: number, len: number): string {
  // len 字节里放 len-1 位八进制 + NUL
  return n.toString(8).padStart(len - 1, "0");
}

/** 把路径拆成 ustar 的 prefix(155) + name(100)；拆不开就拒绝（插件路径远短于此） */
function splitPath(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name };
  }
  throw new PackError(`路径过长，ustar 放不下: ${path}`);
}

function tarHeader(path: string, type: "file" | "dir", size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  const { prefix, name } = splitPath(type === "dir" ? `${path}/` : path);
  writeField(h, 0, 100, name);
  writeField(h, 100, 8, octal(type === "dir" ? 0o755 : 0o644, 8));
  writeField(h, 108, 8, octal(0, 8)); // uid
  writeField(h, 116, 8, octal(0, 8)); // gid
  writeField(h, 124, 12, octal(size, 12));
  writeField(h, 136, 12, octal(0, 12)); // mtime 固定为 0：产物字节级确定
  h.fill(0x20, 148, 156); // 校验和先按空格计
  h[156] = (type === "dir" ? "5" : "0").charCodeAt(0);
  writeField(h, 257, 6, "ustar\0");
  writeField(h, 263, 2, "00");
  writeField(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeField(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** 条目（已排序）→ tar.gz。目录条目显式写出，与 python tarfile / archive.ts 都兼容。 */
export function buildTarGz(entries: Array<{ path: string; data?: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const dirs = new Set<string>();
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!dirs.has(d)) {
        dirs.add(d);
        chunks.push(tarHeader(d, "dir", 0));
      }
    }
    const data = e.data ?? Buffer.alloc(0);
    chunks.push(tarHeader(e.path, "file", data.length));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // 两个全零结束块
  // level 9 + 无文件名 / mtime：gzip 头也是确定的
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

// ─── 插件收集 ─────────────────────────────────────────────────────────

function collectFiles(root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const abs = join(current, entry.name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      // 客户端与服务端都整包拒绝链接条目：在这里就挡住，别等上传才 422
      throw new PackError(`插件里不允许符号链接: ${relative(REPO_ROOT, abs)}`);
    }
    if (st.isDirectory()) collectFiles(root, abs, out);
    else if (st.isFile()) out.push(relative(root, abs).split(sep).join("/"));
    else throw new PackError(`只允许普通文件与目录: ${relative(REPO_ROOT, abs)}`);
  }
}

/** 列出 plugins/ 下的插件目录名（含 plugin.json 的一级子目录） */
export function listPluginDirs(root: string = PLUGINS_ROOT): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NON_PLUGIN_DIRS.has(d.name))
    .filter((d) => {
      try {
        return statSync(join(root, d.name, "plugin.json")).isFile();
      } catch {
        return false;
      }
    })
    .map((d) => d.name)
    .sort();
}

function computeComponents(files: string[]): PluginComponents {
  const skills = files
    .filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f))
    .map((f) => f.split("/")[1]!)
    .sort();
  const mdUnder = (root: string) =>
    files
      .filter((f) => f.startsWith(`${root}/`) && f.endsWith(".md"))
      .map((f) => f.slice(root.length + 1, -3).replace(/\//g, ":"))
      .sort();
  return {
    skills,
    commands: mdUnder("commands"),
    agents: mdUnder("agents"),
    hooks: [],
    mcpServers: [],
  };
}

/** 打包单个插件目录。校验规则与服务端 inspect_package 对齐（能在这里拦的就别留到上传）。 */
export function packPlugin(dir: string): PackedPlugin {
  const dirName = dir.split(sep).pop()!;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8"));
  } catch (err: any) {
    throw new PackError(`${dirName}/plugin.json 解析失败: ${err?.message ?? err}`);
  }
  const { name, version, description } = manifest as Record<string, string>;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new PackError(`${dirName}: name 必须是 slug: ${String(name)}`);
  }
  if (name !== dirName)
    throw new PackError(`${dirName}: plugin.json 的 name(${name}) 与目录名不一致`);
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    throw new PackError(`${name}: version 必须是 semver: ${String(version)}`);
  }
  if (typeof description !== "string" || !description.trim()) {
    throw new PackError(`${name}: description 必填`);
  }
  // 本期官方插件只带 skill：hooks / MCP 会在员工机器上执行命令或连外部地址，
  // 引入它们之前要先有 P2 的「变更需确认」自动更新策略（方案 §6.2 第 5 条）。
  for (const key of ["hooks", "mcpServers"]) {
    if (key in manifest) throw new PackError(`${name}: 官方插件暂不允许声明 ${key}`);
  }

  const files: string[] = [];
  collectFiles(dir, dir, files);
  files.sort();
  if (files.some((f) => f === "hooks.json"))
    throw new PackError(`${name}: 官方插件暂不允许 hooks.json`);
  if (files.length > MAX_ENTRIES) throw new PackError(`${name}: 文件数超过 ${MAX_ENTRIES}`);

  const archive = buildTarGz(files.map((p) => ({ path: p, data: readFileSync(join(dir, p)) })));
  if (archive.length > MAX_PACKAGE_BYTES) throw new PackError(`${name}: 包超过 20 MiB`);
  const components = computeComponents(files);
  if (components.skills.length === 0)
    throw new PackError(`${name}: 没有任何 skills/<名字>/SKILL.md`);

  return {
    name,
    version,
    description,
    archive,
    sha256: createHash("sha256").update(archive).digest("hex"),
    size: archive.length,
    files,
    components,
  };
}

export function artifactPath(p: { name: string; version: string }): string {
  return `artifacts/${p.name}/${p.version}.tar.gz`;
}

/** 生成与后端同契约的 index。versions 只含当前版本：历史版本由 P2 的发布脚本在服务器侧追加。 */
export function buildIndex(packed: PackedPlugin[]) {
  return {
    schema: 1,
    name: OFFICIAL_MARKET_NAME,
    plugins: packed.map((p) => ({
      name: p.name,
      kind: "skill",
      description: p.description,
      maintainer: "sid-code",
      version: p.version,
      sha256: p.sha256,
      size: p.size,
      artifact: artifactPath(p),
      components: p.components,
      versions: [{ version: p.version, sha256: p.sha256, size: p.size }],
    })),
  };
}

// ─── 发布（P2，scripts/plugins-release.sh 调用）─────────────────────────

type IndexJson = ReturnType<typeof buildIndex>;
type IndexEntry = IndexJson["plugins"][number];

/**
 * 把一个新打的插件版本合并进**服务器上现有的** index，返回新 index。
 *
 * 版本不可覆盖：目标版本已经出现在该插件的 versions 里就拒绝 —— 哪怕字节一样也拒，
 * 「重发一次同版本」本身就说明有人在绕过版本号，应该先升版本。
 * 历史版本保留各自的 artifact 地址（静态市场带 .tar.gz，客户端 pickVersion 认这个字段）。
 * 新版本必须比当前最新版本高：发一个比线上还旧的版本当 latest，等于静默回滚所有自动更新用户。
 */
export function mergeIntoIndex(remote: unknown, p: PackedPlugin): IndexJson {
  const base: IndexJson =
    remote && typeof remote === "object" && Array.isArray((remote as IndexJson).plugins)
      ? (remote as IndexJson)
      : { schema: 1, name: OFFICIAL_MARKET_NAME, plugins: [] };
  if (base.name !== OFFICIAL_MARKET_NAME) {
    throw new PackError(`远端 index 的 name 是 ${String(base.name)}，不是 ${OFFICIAL_MARKET_NAME}`);
  }
  const fresh = buildIndex([p]).plugins[0]!;
  const current = base.plugins.find((x) => x.name === p.name);
  const plugins = base.plugins.filter((x) => x.name !== p.name);
  let versions: Array<Record<string, unknown>> = [];
  if (current) {
    versions = (current.versions ?? []).map((v) => ({ ...v }));
    if (versions.some((v) => v.version === p.version)) {
      throw new PackError(
        `${p.name}@${p.version} 已发布过，版本不可覆盖（请先升 plugin.json 的 version）`,
      );
    }
    if (Bun.semver.order(p.version, current.version) <= 0) {
      throw new PackError(
        `${p.name}@${p.version} 不高于线上最新 ${current.version}，拒绝发布（会让自动更新用户被静默回滚）`,
      );
    }
    // 旧条目可能缺 artifact（P1 的 index 没写），补上它当时的地址
    for (const v of versions) {
      if (typeof v.artifact !== "string")
        v.artifact = artifactPath({ name: p.name, version: String(v.version) });
    }
  }
  const entry: IndexEntry = {
    ...fresh,
    versions: [
      { version: p.version, sha256: p.sha256, size: p.size, artifact: artifactPath(p) } as never,
      ...(versions as never[]),
    ],
  };
  plugins.push(entry);
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { schema: 1, name: OFFICIAL_MARKET_NAME, plugins };
}

/**
 * `--release-prep <name> --remote-index <file> --out <dir>`：
 * 打包单个插件 + 与远端 index 合并，产物写到 out（index.json + artifacts/<name>/<ver>.tar.gz），
 * 最后一行 stdout 打印 `__PREP__ <name> <version> <sha256> <artifact>` 给 shell 解析。
 */
function releasePrep(argv: string[]): number {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const name = arg("--release-prep");
  const remoteFile = arg("--remote-index");
  const out = arg("--out");
  if (!name || !out) {
    console.error("用法: --release-prep <name> --remote-index <file|-> --out <dir>");
    return 2;
  }
  try {
    if (!listPluginDirs().includes(name))
      throw new PackError(`plugins/${name} 不存在或没有 plugin.json`);
    const p = packPlugin(join(PLUGINS_ROOT, name));
    let remote: unknown = undefined;
    if (remoteFile && remoteFile !== "-") {
      const raw = readFileSync(remoteFile, "utf-8").trim();
      if (raw) remote = JSON.parse(raw);
    }
    const index = mergeIntoIndex(remote, p);
    const target = join(out, artifactPath(p));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, p.archive);
    writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    console.log(`__PREP__ ${p.name} ${p.version} ${p.sha256} ${artifactPath(p)}`);
    return 0;
  } catch (err: any) {
    console.error(`✗ ${err?.message ?? err}`);
    return 1;
  }
}

export function packAll(root: string = PLUGINS_ROOT): PackedPlugin[] {
  const names = listPluginDirs(root);
  if (names.length === 0) throw new PackError(`${root} 下没有任何插件`);
  return names.map((n) => packPlugin(join(root, n)));
}

function main(argv: string[]): number {
  if (argv.includes("--release-prep")) return releasePrep(argv);
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const outDir =
    outIdx >= 0 && argv[outIdx + 1]
      ? resolve(argv[outIdx + 1]!)
      : join(REPO_ROOT, "dist", "plugins");

  let packed: PackedPlugin[];
  try {
    packed = packAll();
  } catch (err: any) {
    console.error(`✗ ${err?.message ?? err}`);
    return 1;
  }
  const index = buildIndex(packed);

  for (const p of packed) {
    console.log(
      `  ${p.name}@${p.version}  ${p.size} 字节  sha256=${p.sha256.slice(0, 12)}…  skills=${p.components.skills.join(",")}`,
    );
  }
  if (check) {
    console.log(`✓ ${packed.length} 个插件可打包（--check，未写盘）`);
    return 0;
  }
  for (const p of packed) {
    const target = join(outDir, artifactPath(p));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, p.archive);
  }
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`✓ ${packed.length} 个插件 → ${relative(REPO_ROOT, outDir) || outDir}/`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
