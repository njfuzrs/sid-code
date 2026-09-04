#!/usr/bin/env bun
/**
 * fetch-vendor-src.ts — 构建时准备 vendor 源码目录（不入库的第三方代码）
 *
 * 为什么存在：`packages/tui-renderer/src/` 与
 * `packages/cli/src/command/commands/claude-api/reference/` **不入库**（见 .gitignore），
 * 但它们是**编译期依赖**：
 *   · 前者被 `packages/cli/src` 下 102 个文件按 `@sid-code/tui-renderer/*` 导入；
 *   · 后者被 `claude-api.ts` 用 Bun 的 `with { type: "text" }` 内联进单二进制。
 * 因此 fresh clone / CI 上必须先把它们取回来，否则 `bun test` 与 `make build` 都跑不起来
 * —— 实测新仓首批 CI 全红就是这个原因（`Cannot find module '@sid-code/tui-renderer/stringWidth.ts'`）。
 *
 * 机制与 `fetch-ripgrep.ts` **同源**（刻意照抄那套先例，不另创一套），但多一层间接：
 *   1. 真实字节存放在**仓库内的缓存目录** `.vendor-src/<name>/`（不入库、被 ignore）；
 *   2. 规范路径（上面那两个）是**指向缓存的相对 symlink**；
 *   3. 缓存已有 → 直接复用，全程不联网。缺失才下载 tar.gz + sha256 校验。
 *
 * ## 为什么要多这一层 symlink（⑯ 的根治目标）
 *
 * 治的是一次**真实事故**：`git rm --cached` + `.gitignore` 之后，那 125 个文件
 * 曾从磁盘上消失。机理是 `.gitignore` 只挡「未追踪文件不被 add」，
 * **完全不挡「已记录删除的文件不被 checkout 删掉」** —— 实测仓库里有 37+ 个分支
 * 仍把这些路径记为已追踪，切过去再切回来，git 就按索引把工作区文件删了。
 *
 * symlink 把「git 会动的东西」与「真实字节」分开：
 *   · git 能动的只有那个 symlink（几十字节，删了重建即可）；
 *   · 真实字节在 `.vendor-src/`，而该路径在**全部 371 个 ref 里都不存在**
 *     （实测），所以任何 checkout / merge / reset 都不会碰它。
 *
 * 实测两种情形（都在一份临时克隆里验过，不是推断）：
 *   · 普通 `git checkout <仍追踪这些路径的分支>` → git **直接拒绝**并中止
 *     （"请在切换分支前移动或删除"），比静默删除好得多；
 *   · `git checkout -f` 强制切换 → symlink **会**被替换成真目录、切回来后变空，
 *     **但 `.vendor-src/` 里 125 个文件分毫未动** —— 跑一次 `vendor:fetch` 即复原。
 *
 * ⇒ 这条防线的准确边界是**「真实字节不会丢」**，不是「symlink 不会被动」。
 *    别把它说成后者：`-f` 下 symlink 确实会被替换。
 *
 * ## ⚠️ 四个实测踩到的坑（改这个脚本前必读，每条都会静默出错）
 *
 * 1. **缓存必须在仓库内，不能放 `~/.cache/`。** 试过 `~/.cache/sid-code/vendor-src/`，
 *    `make build` 当场失败：`Could not resolve: "react"`。原因是 bun 按 **realpath**
 *    向上找 `node_modules`，而 `~/.cache` 那条链路上一个都没有。放仓库内则
 *    realpath 仍在仓库树里，workspace 解析照常命中。
 *    ⇒ **「挪到仓库外」这个直觉方案在 bun 下不可行**，bun 也没有 `--preserve-symlinks`。
 * 2. **`.gitignore` 的尾斜杠只匹配目录，不匹配 symlink。** 原有两条规则以 `/` 结尾，
 *    换成 symlink 后 `git check-ignore` **不再命中**，两个 symlink 出现在 git status 里
 *    并可能被 `git add -A` 入库。所以规则必须写成**不带尾斜杠**的形态。
 * 3. **`tar -xzf` 不能穿过 symlink 解包。** 服务器 tar 包内是仓库内规范路径
 *    （`packages/tui-renderer/src/...`），直接解包会报
 *    `Cannot extract through symlink` 而**部分失败**。所以下载路径必须
 *    先解到临时目录，再把内容搬进 `.vendor-src/`。
 * 4. **`--pack` 必须加 `tar -h`（跟随 symlink）。** 不加只会把两个 symlink 本身
 *    打进包里 —— 实测包内文件数从 125 变成 **2**，而 tar 退出码是 0、
 *    上传照样成功、sha256 照样算得出来。下一个 fresh clone 才会炸。
 *
 * 服务器布局（nginx root=/var/www/html，与 ripgrep 并列）：
 *   https://www.sid-code.cc/vendor-bin/tui-renderer/<version>/tui-renderer-src-<version>.tar.gz
 *   https://www.sid-code.cc/vendor-bin/tui-renderer/<version>/tui-renderer-src-<version>.tar.gz.sha256
 *
 * 用法：
 *   bun run scripts/fetch-vendor-src.ts               # 缺失则下载，已有则跳过
 *   bun run scripts/fetch-vendor-src.ts --force       # 强制重新下载覆盖
 *   bun run scripts/fetch-vendor-src.ts --check       # 只检查是否齐全，不下载（退出码 0/1）
 *   bun run scripts/fetch-vendor-src.ts --pack        # 反向：把本地目录打包成可上传的 tar.gz
 *   bun run scripts/fetch-vendor-src.ts --print-version
 *
 * 环境变量：
 *   SID_VENDOR_SRC_BASE_URL  下载根地址（默认 <PUBLIC_BASE_URL>/vendor-bin/tui-renderer）
 *   SID_VENDOR_SRC_VERSION   版本（默认见 DEFAULT_VERSION）
 *   PUBLIC_BASE_URL          对外访问地址（与 release.sh / fetch-ripgrep.ts 同名同义）
 *
 * ⚠️ 更新这批 vendor 源码时：改动本地文件 → `--pack` → 上传到服务器新版本目录
 *    → 改 DEFAULT_VERSION → 提交。**不要覆盖已发布版本的 tar.gz**：
 *    已有 CI 缓存与他人本机可能仍在引用它，覆盖会让"同一版本号两份内容"，
 *    而 sha256 校验会把这件事变成一片红。
 */

import { existsSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, writeFile, rm, symlink, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

/**
 * 打包内容的版本。改这里 = 换一份 vendor 源码快照。
 * 用日期而非语义版本：这批文件不是我们维护的库，没有"语义"可言，只有"哪天的快照"。
 */
const DEFAULT_VERSION = "20260904";
const DEFAULT_PUBLIC_BASE_URL = "https://www.sid-code.cc";

/**
 * 需要取回的目录清单（相对仓库根）。
 *
 * ⚠️ 与 .gitignore 里那两条**必须一致**。加一条不入库目录就要同步这里，
 * 否则 CI 会在"某个模块解析不到"上失败，而错误信息完全指不到这个清单。
 */
const VENDOR_DIRS = [
  "packages/tui-renderer/src",
  "packages/cli/src/command/commands/claude-api/reference",
] as const;

/**
 * 真实字节的存放处（相对仓库根）。**必须在仓库内** —— 见文件头坑 1：
 * 放到 `~/.cache/` 会让 bun 按 realpath 找不到 `node_modules`，`make build` 当场失败。
 *
 * 这个路径在全部 371 个 ref 里都不存在（实测），所以 git 的任何 checkout / merge /
 * reset 都不会碰它 —— 这正是 ⑯ 那条防线的全部机理所在。
 * ⚠️ 改名要同步 .gitignore、tests/build/vendor-location.test.ts 与 CONTRIBUTING.md。
 */
const CACHE_DIR = ".vendor-src";

/** 规范路径 → 缓存里对应的子目录名。用短名而非原路径，避免缓存里再套六层目录。 */
const CACHE_NAME: Record<string, string> = {
  "packages/tui-renderer/src": "tui-renderer-src",
  "packages/cli/src/command/commands/claude-api/reference": "claude-api-reference",
};

function cacheAbs(rel: string): string {
  const name = CACHE_NAME[rel];
  if (!name) throw new Error(`VENDOR_DIRS 里的 ${rel} 没有在 CACHE_NAME 里登记`);
  return join(ROOT, CACHE_DIR, name);
}

function resolveVersion(): string {
  return process.env.SID_VENDOR_SRC_VERSION?.trim() || DEFAULT_VERSION;
}

function resolveBaseUrl(): string {
  const explicit = process.env.SID_VENDOR_SRC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const publicBase = (process.env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL).replace(
    /\/$/,
    "",
  );
  return `${publicBase}/vendor-bin/tui-renderer`;
}

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/**
 * 目录存在且非空才算"已有"。
 * 空目录会让 grep/scandir 静默返回 0 命中，比不存在更危险 —— 所以必须查到文件数。
 * 注意 `statSync` 会跟随 symlink，这里正是要的语义（关心的是"能不能读到内容"）。
 */
function dirNonEmpty(abs: string): boolean {
  if (!existsSync(abs)) return false;
  try {
    if (!statSync(abs).isDirectory()) return false;
    return [...new Bun.Glob("**/*").scanSync(abs)].length > 0;
  } catch {
    return false;
  }
}

/** 真实字节在不在缓存里。**这是唯一的事实源** —— 规范路径只是它的一个 symlink。 */
function cachePresent(rel: string): boolean {
  return dirNonEmpty(cacheAbs(rel));
}

/** 规范路径应当指向的相对目标（相对 symlink，仓库整体搬家也不会断）。 */
function linkTarget(rel: string): string {
  return relative(join(ROOT, dirname(rel)), cacheAbs(rel));
}

/** 规范路径是不是一个指向正确目标的 symlink。 */
function linkOk(rel: string): boolean {
  const abs = join(ROOT, rel);
  try {
    if (!lstatSync(abs).isSymbolicLink()) return false;
    return readlinkSync(abs) === linkTarget(rel);
  } catch {
    return false;
  }
}

/**
 * 把规范路径做成指向缓存的 symlink。三种入场状态都要处理：
 *   · 已是正确 symlink            → 什么都不做（幂等，`make build` 每次都会跑到这里）；
 *   · 是真目录且缓存里还没有内容  → **搬进缓存**再建链（这是老克隆的迁移路径）；
 *   · 是真目录/坏链而缓存已有内容 → 删掉它建链（缓存是事实源，不怕删）。
 *
 * ⚠️ 第二种是唯一会移动真实字节的分支，所以用 `rename`（原子）而不是复制后删除：
 * 中途失败时文件要么在旧位置要么在新位置，不会两边都没有。
 */
async function ensureLink(rel: string): Promise<"ok" | "adopted" | "relinked"> {
  const abs = join(ROOT, rel);
  if (linkOk(rel)) return "ok";

  const isRealDir =
    existsSync(abs) && !lstatSync(abs).isSymbolicLink() && statSync(abs).isDirectory();
  const cacheHas = cachePresent(rel);

  await mkdir(join(ROOT, CACHE_DIR), { recursive: true });

  let outcome: "adopted" | "relinked" = "relinked";
  if (isRealDir && dirNonEmpty(abs) && !cacheHas) {
    // 迁移：把现存真目录整体搬进缓存。不复制，避免出现"两份内容谁是真的"。
    await rename(abs, cacheAbs(rel));
    outcome = "adopted";
  } else if (existsSync(abs) || isBrokenLink(abs)) {
    // 缓存已是事实源（或那边是坏链/空目录），规范路径这一侧可以安全清掉重建。
    await rm(abs, { recursive: true, force: true });
  }

  await symlink(linkTarget(rel), abs);
  return outcome;
}

/** 坏链：lstat 得到 symlink，但 existsSync（跟随链接）为 false。 */
function isBrokenLink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink() && !existsSync(abs);
  } catch {
    return false;
  }
}

/**
 * 齐不齐的判据是**缓存里有没有字节**，不是规范路径能不能读。
 * 分开报「字节缺失」与「链没接上」：前者要联网取，后者一条 `symlink` 就修好，
 * 混成一个 "missing" 会让人对着"本地明明有文件"的现象去查网络。
 */
function reportPresence(): { missing: string[]; present: string[]; unlinked: string[] } {
  const missing: string[] = [];
  const present: string[] = [];
  const unlinked: string[] = [];
  for (const d of VENDOR_DIRS) {
    // 老克隆里字节还躺在规范路径上（真目录）——那也算"有字节"，交给 ensureLink 迁移。
    const hasBytes = cachePresent(d) || (!linkOk(d) && dirNonEmpty(join(ROOT, d)));
    if (hasBytes) {
      present.push(d);
      if (!linkOk(d)) unlinked.push(d);
    } else {
      missing.push(d);
    }
  }
  return { missing, present, unlinked };
}

async function runTar(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["tar", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar ${args.join(" ")} 失败（exit ${code}）: ${err.trim()}`);
  }
}

/** 列出 tar 包内的文件（不含目录条目），用于打包后的自证。 */
async function listTar(archive: string): Promise<string[]> {
  const proc = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`tar -tzf ${archive} 失败: ${(await new Response(proc.stderr).text()).trim()}`);
  }
  return out.split("\n").filter((l) => l.trim() !== "" && !l.endsWith("/"));
}

/** 反向操作：把本地目录打包成可上传的 tar.gz + .sha256。 */
async function pack(version: string): Promise<void> {
  const { missing } = reportPresence();
  if (missing.length > 0) {
    throw new Error(`本地缺少这些目录，无法打包:\n  ${missing.join("\n  ")}`);
  }
  const name = `tui-renderer-src-${version}.tar.gz`;
  const out = join("/tmp", name);
  // 确定性打包：清零 owner、固定 ustar 格式，保证同内容同 sha256。
  //
  // ⚠️ `-h`（跟随 symlink）是**必须的**，见文件头坑 4：规范路径现在是 symlink，
  // 不加 -h 只会把两个 symlink 本身打进包（实测 125 个文件变成 2 个），
  // 而 tar 退出码 0、sha256 照样算得出、上传照样成功 —— 下一个 fresh clone 才炸。
  await runTar(
    [
      "-h",
      "--numeric-owner",
      "--owner=0",
      "--group=0",
      "--format=ustar",
      "--no-mac-metadata",
      "-czf",
      out,
      ...VENDOR_DIRS,
    ],
    ROOT,
  );

  // 打完就地自证：包内文件数必须与磁盘上真实文件数一致。
  // 这条断言就是为坑 4 而写的 —— 它把"静默少打 123 个文件"变成当场失败。
  const listed = await listTar(out);
  const onDisk = VENDOR_DIRS.reduce(
    (n, d) => n + [...new Bun.Glob("**/*").scanSync(cacheAbs(d))].length,
    0,
  );
  if (listed.length !== onDisk) {
    throw new Error(
      `打包内容与磁盘不一致：包内 ${listed.length} 个文件，磁盘上 ${onDisk} 个。\n` +
        `若包内只有 2 个，说明 tar 把 symlink 本身打进去了（-h 丢了？见文件头坑 4）。`,
    );
  }
  console.log(`  ✓ 包内 ${listed.length} 个文件（与磁盘一致）`);
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  const sha = sha256Hex(bytes);
  await writeFile(`${out}.sha256`, `${sha}\n`);
  console.log(`  ✓ 已打包 ${out}（${(bytes.byteLength / 1024).toFixed(0)} KB）`);
  console.log(`  sha256: ${sha}`);
  console.log(`\n上传（照 ripgrep 的路子，走 scripts/deploy.env 的凭据）：`);
  console.log(
    `  scp ${out}{,.sha256} <user>@<host>:/var/www/html/vendor-bin/tui-renderer/${version}/`,
  );
}

async function download(version: string, baseUrl: string, force: boolean): Promise<void> {
  const { missing, present } = reportPresence();

  if (missing.length === 0 && !force) {
    // 字节齐全 → 全程不联网。但**仍要接一次链**：
    // `git checkout -f` 会把 symlink 换成空的真目录（实测），此时字节还在缓存里，
    // 只是规范路径断了。这一步就是那种情况下的复原路径，也是老克隆的迁移入口。
    for (const d of present) {
      const r = await ensureLink(d);
      const note =
        r === "adopted"
          ? `已搬入 ${CACHE_DIR}/ 并建立 symlink`
          : r === "relinked"
            ? "symlink 已重建"
            : "本地已有，跳过下载";
      console.log(`  ✓ ${d}（${note}）`);
    }
    return;
  }

  const name = `tui-renderer-src-${version}.tar.gz`;
  const tarUrl = `${baseUrl}/${version}/${name}`;
  const shaUrl = `${tarUrl}.sha256`;

  let expectedSha: string | null = null;
  try {
    const shaResp = await fetch(shaUrl);
    if (shaResp.ok) {
      expectedSha = (await shaResp.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  } catch {
    // .sha256 拉不到不致命，下面按无校验处理并明确告警
  }

  console.log(`  ↓ 下载 ${tarUrl} ...`);
  const resp = await fetch(tarUrl);
  if (!resp.ok) {
    throw new Error(
      `下载失败 ${tarUrl}: HTTP ${resp.status}。\n` +
        `请确认服务器上已上传该版本（用 --pack 打包后 scp 到 vendor-bin/tui-renderer/${version}/）。`,
    );
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`下载到空文件 ${tarUrl}`);

  if (expectedSha) {
    const actual = sha256Hex(bytes);
    if (actual !== expectedSha) {
      throw new Error(`sha256 校验失败: 期望 ${expectedSha}，实际 ${actual}`);
    }
    console.log(`  ✓ sha256 校验通过`);
  } else {
    console.log(`  ⚠️  无 .sha256 校验文件，跳过完整性校验`);
  }

  const tmp = join("/tmp", name);
  await writeFile(tmp, bytes);

  // ⚠️ 不能直接解到 ROOT，见文件头坑 3：包内是仓库内规范路径，而那两个路径现在是
  // symlink，bsdtar 会报 `Cannot extract through symlink` 并**部分失败**。
  // 所以解到临时目录，再把内容搬进缓存 —— 缓存才是真实字节该待的地方。
  const stage = join("/tmp", `vendor-src-stage-${version}-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await runTar(["-xzf", tmp], stage);

  await mkdir(join(ROOT, CACHE_DIR), { recursive: true });
  for (const d of VENDOR_DIRS) {
    const from = join(stage, d);
    if (!dirNonEmpty(from)) {
      throw new Error(`tar 包里没有 ${d}（包内容与 VENDOR_DIRS 不一致？）`);
    }
    // force 或该目录已有旧内容时整体替换，避免新旧混在一起
    //（新版本删掉的文件会以孤儿身份留下来，而 sha256 只校验 tar 包不校验解开后的树）。
    await rm(cacheAbs(d), { recursive: true, force: true });
    await rename(from, cacheAbs(d));
  }
  await rm(stage, { recursive: true, force: true });
  await rm(tmp, { force: true });

  for (const d of VENDOR_DIRS) await ensureLink(d);

  const after = reportPresence();
  if (after.missing.length > 0 || after.unlinked.length > 0) {
    throw new Error(
      `解包后仍不齐:\n  字节缺失 ${after.missing.join(", ") || "无"}\n` +
        `  链未接上 ${after.unlinked.join(", ") || "无"}`,
    );
  }
  for (const d of VENDOR_DIRS) {
    const n = [...new Bun.Glob("**/*").scanSync(join(ROOT, d))].length;
    console.log(`  ✓ ${d} → ${CACHE_DIR}/${CACHE_NAME[d]}（${n} 个文件，经 symlink 可读）`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const version = resolveVersion();

  if (argv.includes("--print-version")) {
    console.log(version);
    return;
  }

  if (argv.includes("--check")) {
    // 两种不齐要分开报，成因和解法完全不同：
    //   · 字节缺失 → 要联网取（fresh clone / 换了版本号）；
    //   · 链没接上 → 字节都在，一条 symlink 就修好（多半是 `git checkout -f` 打断的）。
    // 合成一个 "missing" 会让人对着"文件明明在磁盘上"的现象去查网络问题。
    const { missing, present, unlinked } = reportPresence();
    for (const d of present) {
      console.log(unlinked.includes(d) ? `  ⚠️ ${d} 字节在，但 symlink 未接上` : `  ✓ ${d}`);
    }
    for (const d of missing) console.log(`  ✗ ${d} 字节缺失`);
    if (missing.length > 0 || unlinked.length > 0) {
      if (missing.length > 0) console.error(`\nvendor 源码不齐（缺 ${missing.length} 个）。`);
      if (unlinked.length > 0) {
        console.error(`${unlinked.length} 个规范路径不是指向 ${CACHE_DIR}/ 的 symlink。`);
      }
      console.error(`跑 bun run vendor:fetch 修复（字节已在时不联网）。`);
      process.exit(1);
    }
    console.log(
      `vendor 源码齐全，且规范路径均为指向 ${CACHE_DIR}/ 的 symlink（version=${version}）。`,
    );
    return;
  }

  if (argv.includes("--pack")) {
    await pack(version);
    return;
  }

  console.log(`fetch-vendor-src: version=${version} baseUrl=${resolveBaseUrl()}`);
  await download(version, resolveBaseUrl(), argv.includes("--force"));
}

await main();
