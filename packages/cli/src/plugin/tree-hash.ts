/**
 * 插件目录内容指纹（P5）。
 *
 * 用途：installed.json 里市场插件记一份安装时的指纹，锁定策略生效时加载前复核。
 * 拦的是两种情况：① 市场插件装好后被改了内容（最典型：往 hooks.json 里加一条命令）；
 * ② 手改 installed.json，把一个本地目录挂上 `market` 段冒充市场插件。
 *
 * 算法：遍历目录下全部普通文件（跳过符号链接，市场包本就不允许它），按相对路径排序，
 * 逐个喂 `<相对路径>\0<文件 sha256>\n`，整体再 sha256。路径用 `/` 分隔，跨平台一致。
 * 目录本身不参与（空目录不改变行为）。
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 单个插件目录最多扫多少个文件。与市场包条目上限同量级，超出视为不可信 */
const MAX_FILES = 5000;

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const dir = rel === "" ? root : join(root, ...rel.split("/"));
  const names = await readdir(dir);
  for (const name of names) {
    const childRel = rel === "" ? name : `${rel}/${name}`;
    const st = await lstat(join(dir, name));
    if (st.isSymbolicLink()) {
      // 市场包不允许链接条目；目录里出现链接只可能是装好后被动过，直接让指纹对不上
      out.push(`${childRel}\0symlink`);
    } else if (st.isDirectory()) {
      await walk(root, childRel, out);
    } else if (st.isFile()) {
      out.push(childRel);
    }
    if (out.length > MAX_FILES) throw new Error(`插件目录文件数超过 ${MAX_FILES}`);
  }
}

/** 由「相对路径 → 内容」直接算指纹（安装时用解包条目算，不必再读一遍磁盘） */
export function treeHashFromEntries(files: Array<{ path: string; data: Uint8Array }>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(`${f.path}\0${createHash("sha256").update(f.data).digest("hex")}\n`);
  }
  return h.digest("hex");
}

/** 读磁盘算指纹。目录不存在 / 读失败时抛错，调用方按「校验不通过」处理。 */
export async function computeTreeHash(root: string): Promise<string> {
  const paths: string[] = [];
  await walk(root, "", paths);
  const h = createHash("sha256");
  for (const p of paths.sort()) {
    if (p.endsWith("\0symlink")) {
      h.update(`${p}\n`);
      continue;
    }
    const data = await readFile(join(root, ...p.split("/")));
    h.update(`${p}\0${createHash("sha256").update(data).digest("hex")}\n`);
  }
  return h.digest("hex");
}
