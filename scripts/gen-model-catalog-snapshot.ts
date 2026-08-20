#!/usr/bin/env bun
/**
 * 编译期模型目录快照生成（D4 §5.3）。
 *
 * ── 要解决的问题 ─────────────────────────────────────────────────────
 *
 * 首次安装、完全离线（国内很常见的场景）时，能力缓存是空的：`syncExternalCatalogs`
 * 是 fire-and-forget，失败静默，用户能拿到的只有 90 条内置注册表 + 兜底猜测。
 * 编译期把 models.dev 镜像的一份快照打进二进制，冷启动零网络也能拿到全量目录。
 *
 * ── 选型：opencode 路线（编译期注入），字段裁剪（§5.3 建议）───────────
 *
 * 镜像单条原始记录有 21 个字段，我们只消费 4 个（`limit.context` / `limit.output` /
 * `reasoning` / `reasoning_options`）。裁剪掉其余 17 个字段能把体积压到几百 KB，
 * 而不是把 2.3MB 原始 JSON 整份打进二进制（那是 oh-my-pi 路线，会让每次再生产生
 * 巨大 diff，与仓库「保持 review 可读」的习惯冲突，§5.3 已论证过两条路线的取舍）。
 *
 * 复用 `model-capabilities.ts` 已导出的纯函数（parseModelsDev + voteEntries）而不是
 * 重新写一套解析/投票逻辑：快照与运行时同步用的必须是**同一套**规则，否则「快照给的窗口」
 * 与「运行时同步后的窗口」在同一个模型上不一致，会把「快照被覆盖」误判成「数据不一致的 bug」。
 *
 * ── 失败处理：绝不 fail build（§5.3 配套事 1）──────────────────────
 *
 * 离线开发必须仍能构建。拉取失败时：
 *   - 若 vendor 目录已有一份旧快照（比如上次成功生成过），原样保留，不覆盖；
 *   - 否则写一个空快照占位（`{ generatedAt: 0, models: {} }`），保证
 *     `bun build --compile` 不因缺文件报错，运行时按「快照为空」自然退化到
 *     磁盘缓存 + 联网同步这两层。
 *
 * 用法：
 *   bun run scripts/gen-model-catalog-snapshot.ts              # 生成快照（供 make build）
 *   bun run scripts/gen-model-catalog-snapshot.ts --print-path  # 只打印目标路径，不联网
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __parsersForTest,
  __voteEntriesForTest,
  type ModelCapabilityEntry,
} from "../packages/core/src/llm/model-capabilities.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** 固定嵌入路径：与 rg-embed 同一套约定（构建脚本落成，运行时 `with {type:"file"}` 引用）。 */
export const SNAPSHOT_PATH = join(
  REPO_ROOT,
  "packages",
  "core",
  "vendor",
  "model-catalog-snapshot.json",
);

/** 主源 URL——与 model-capabilities.ts 的 CATALOG_SOURCES[0] 保持同一个源（见文件头注释）。 */
const SNAPSHOT_SOURCE_URL = "https://models.opencode.ai/api.json";
const FETCH_TIMEOUT_MS = 15_000;
/** 与运行时 fetchCatalog 同一套体积上限（32MiB，见 model-capabilities.ts 的 32MiB 注释）。 */
const MAX_BYTES = 32 * 1024 * 1024;

/** 裁剪后写进快照的字段——只保留 lookupCapability 真正会读的四个。 */
interface TrimmedEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
  effortValues?: string[];
  supportsReasoning?: boolean;
}

interface SnapshotFile {
  /** 生成时间戳（ms）。运行时用它与磁盘缓存的 catalog_synced_at 比较，旧的不覆盖新的
   *  （§5.3 配套事 2，对标 pi 的 localGeneratedAt）。 */
  generatedAt: number;
  /** 源 URL，供排障时确认这份快照对应哪个上游（不参与任何匹配逻辑）。 */
  sourceUrl: string;
  models: Record<string, TrimmedEntry>;
}

function trim(entry: ModelCapabilityEntry): TrimmedEntry {
  const out: TrimmedEntry = {};
  if (entry.contextWindow !== undefined) out.contextWindow = entry.contextWindow;
  if (entry.maxOutputTokens !== undefined) out.maxOutputTokens = entry.maxOutputTokens;
  if (entry.effortValues !== undefined) out.effortValues = entry.effortValues;
  if (entry.supportsReasoning !== undefined) out.supportsReasoning = entry.supportsReasoning;
  return out;
}

async function fetchBody(url: string, timeoutMs: number): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    if (!resp.ok) {
      console.warn(`  ⚠ 快照源 HTTP ${resp.status}：${url}`);
      return null;
    }
    // 与运行时同一套上限：这是构建机上的一次性拉取，同样不该无限信任响应体积。
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      console.warn(`  ⚠ 快照源响应超过 ${MAX_BYTES} 字节，丢弃：${url}`);
      return null;
    }
    return new TextDecoder().decode(buf);
  } catch (e) {
    console.warn(`  ⚠ 快照源拉取失败: ${String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 生成时间戳注入点——避免脚本里直接调用 Date.now()，方便未来做可复算的快照 diff。 */
function nowMs(): number {
  return Date.now();
}

async function main(): Promise<void> {
  const printPathOnly = process.argv.includes("--print-path");
  if (printPathOnly) {
    console.log(SNAPSHOT_PATH);
    return;
  }

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });

  const text = await fetchBody(SNAPSHOT_SOURCE_URL, FETCH_TIMEOUT_MS);
  if (text === null) {
    // 失败：保留已有快照（若有），否则落一个空占位。两种情况都不 fail build。
    if (existsSync(SNAPSHOT_PATH)) {
      console.warn(`  ⚠ 快照拉取失败，保留已有快照 → ${SNAPSHOT_PATH}`);
      return;
    }
    const empty: SnapshotFile = { generatedAt: 0, sourceUrl: SNAPSHOT_SOURCE_URL, models: {} };
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(empty), "utf8");
    console.warn(`  ⚠ 快照拉取失败，落空占位 → ${SNAPSHOT_PATH}（离线构建不受影响）`);
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.warn(`  ⚠ 快照源返回非 JSON，视为失败: ${String(e)}`);
    if (!existsSync(SNAPSHOT_PATH)) {
      const empty: SnapshotFile = { generatedAt: 0, sourceUrl: SNAPSHOT_SOURCE_URL, models: {} };
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(empty), "utf8");
    }
    return;
  }

  // 复用运行时同一套 parse + vote：单源本身就有「同一模型多 provider 多条」的形态
  // （见 model-capabilities.ts 头部注释），必须先投票收敛成一条，不能直接摊平进快照。
  const parsed = __parsersForTest.modelsDev(raw);
  const models: Record<string, TrimmedEntry> = {};
  let voted = 0;
  for (const [name, entries] of Object.entries(parsed)) {
    const candidates = entries.map((entry) => ({ entry, source: "models-dev-opencode" }));
    const merged = __voteEntriesForTest(candidates);
    if (!merged) continue;
    models[name] = trim(merged);
    voted++;
  }

  const snapshot: SnapshotFile = {
    generatedAt: nowMs(),
    sourceUrl: SNAPSHOT_SOURCE_URL,
    models,
  };
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), "utf8");
  const sizeKb = Math.round(Buffer.byteLength(JSON.stringify(snapshot)) / 1024);
  console.log(`  ✓ 快照已生成：${voted} 条模型 / ${sizeKb}KB → ${SNAPSHOT_PATH}`);
}

main().catch((e) => {
  // 与 fetch-ripgrep.ts 同一套原则：构建脚本失败绝不能让 make build 整体炸掉。
  // Makefile 里这一行前导 `-`（忽略退出码），这里再兜底落空占位，两道防线。
  console.warn(`  ⚠ 快照生成异常，继续构建: ${String(e)}`);
  if (!existsSync(SNAPSHOT_PATH)) {
    mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
    const empty: SnapshotFile = { generatedAt: 0, sourceUrl: SNAPSHOT_SOURCE_URL, models: {} };
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(empty), "utf8");
  }
});
