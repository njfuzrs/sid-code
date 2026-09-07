/**
 * 团队记忆同步引擎（对标 claude-code teamMemorySync/index.ts，去 HTTP/OAuth）
 *
 * sid 无后端，改用「共享目录」做同步介质。引擎在三方之间做合并：
 *   - local：本地团队记忆目录 ~/.sid-code/projects/<key>/team-memory/
 *   - shared：配置的共享远端目录 teamMemory.dir（网络盘 / 同步盘）
 *   - base：上次成功同步时记录的每条记忆 sha256（manifest，存本地不同步）
 *
 * 三方合并规则（逐 key 比较 local / shared / base 三个 hash）：
 *   - local == shared            → 已一致，更新 base 即可
 *   - 仅 local 变更(shared==base) → push：local → shared
 *   - 仅 shared 变更(local==base) → pull：shared → local
 *   - 双方都变更且不同            → 冲突：mtime 较新者获胜，败者另存 .conflict 副本不丢数据
 *   - 一侧删除 + 另一侧未改        → 传播删除
 *   - 一侧删除 + 另一侧改动        → 复活改动方（改动优先于删除）
 *
 * 安全（**双向**，P2-14）：
 *   - push 前对每个本地条目跑 scanForSecrets，命中的文件**跳过**同步
 *     （绝不外泄到共享目录），结果里记录被跳过的文件（仅 ruleId，不含明文）。
 *   - pull 前对每个**共享**条目同样跑 scanForSecrets，命中的 key **整轮隔离**：
 *     既不落到本地，也不参与删除传播（见下面 `quarantined` 的说明）。
 *     此前 pull 侧完全不扫，共享目录内容被当作可信输入直接落盘 → 进本地
 *     MEMORY.md → 进每个会话的 system prompt。push 侧那道闸门在这个方向上
 *     不起作用：它防的是「我泄给别人」，不防「别人泄给我」。
 *
 * checksum 增量：仅当 hash 变化才读写，避免每次全量复制。
 */

import { createHash } from "crypto";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { readdir, stat, unlink, readFile, writeFile } from "fs/promises";
import { getLogger } from "../../debug/logger.ts";
import { scanForSecrets, type SecretMatch } from "./secret-scanner.ts";
import { getTeamMemPath, resolveSharedTeamDir, type TeamMemoryOptions } from "./paths.ts";

/** 单个记忆条目的最大字节数（超限跳过，防超大文件拖垮同步） */
const MAX_FILE_SIZE_BYTES = 250_000;

/** 同步状态 manifest 文件名（存本地，不参与同步） */
const SYNC_STATE_FILE = ".team-memory-sync.json";

/** 因含 secret 被跳过的文件（path 相对团队记忆目录；仅记录 ruleId，不含明文） */
export interface SkippedSecretFile {
  path: string;
  ruleId: string;
  label: string;
}

/** 同步结果 */
export interface TeamMemorySyncResult {
  success: boolean;
  /** 从 shared 拉到 local 的文件数 */
  pulled: number;
  /** 从 local 推到 shared 的文件数 */
  pushed: number;
  /** 传播的删除数（两端合计） */
  deleted: number;
  /** 检测到的冲突数 */
  conflicts: number;
  /** 因含 secret 跳过 push 的**本地**文件（防外泄） */
  skippedSecrets: SkippedSecretFile[];
  /**
   * 因含 secret 被拒绝 pull 的**共享**文件（防凭证反向流入，P2-14）。
   *
   * 与 `skippedSecrets` 分开两个字段而不是合成一个：两者的处置动作与用户该做的事
   * 相反 —— 前者是「你自己的记忆别外泄，请你清理」，后者是
   * 「共享盘里有人放了凭证，请去提醒那个人」。合成一个字段就分不出该找谁。
   */
  blockedIncomingSecrets: SkippedSecretFile[];
  /** 失败原因（success=false 时） */
  error?: string;
  /** 失败类型（供 watcher 判断是否永久失败） */
  errorType?: "disabled" | "no_shared_dir" | "io" | "unknown";
}

/** base manifest：key → sha256（上次同步时两端一致的内容哈希） */
type SyncManifest = Record<string, string>;

/** 计算内容的 `sha256:<hex>` */
export function hashContent(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

/** 目录内一个记忆条目（.md 文件） */
interface MemEntry {
  /** 文件名（相对目录，作为 key） */
  key: string;
  /** 内容 */
  content: string;
  /** sha256:<hex> */
  hash: string;
  /** mtime 毫秒（冲突时比较新旧） */
  mtimeMs: number;
}

/**
 * 读取一个目录下的所有记忆 .md 文件（跳过 MEMORY.md 索引、超大文件、隐藏文件）。
 * @param scanSecrets 为 true 时对命中 secret 的条目记入 skipped 并从结果剔除（push 用）
 */
async function readEntries(
  dir: string,
  scanSecrets: boolean,
  skipped: SkippedSecretFile[],
): Promise<Map<string, MemEntry>> {
  const out = new Map<string, MemEntry>();
  if (!existsSync(dir)) return out;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }

  for (const filename of names) {
    // 只同步 .md 记忆条目；跳过 MEMORY.md 索引（各端本地重建）、隐藏文件、冲突副本
    if (!filename.endsWith(".md")) continue;
    if (filename === "MEMORY.md") continue;
    if (filename.startsWith(".")) continue;
    if (filename.includes(".conflict-")) continue;

    const filePath = join(dir, filename);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_SIZE_BYTES) {
        getLogger().warn(
          "TEAMMEM",
          `跳过超大记忆文件 ${filename} (${st.size} > ${MAX_FILE_SIZE_BYTES}B)`,
        );
        continue;
      }
      const content = await readFile(filePath, "utf8");

      if (scanSecrets) {
        const matches: SecretMatch[] = scanForSecrets(content);
        if (matches.length > 0) {
          // 命中 secret：不外泄到共享目录，仅记录 ruleId（不含明文）
          skipped.push({ path: filename, ruleId: matches[0].ruleId, label: matches[0].label });
          continue;
        }
      }

      out.set(filename, {
        key: filename,
        content,
        hash: hashContent(content),
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // 跳过损坏/读不出的文件
    }
  }
  return out;
}

/** 读取本地 manifest（base hash），损坏/缺失返回空 */
async function readManifest(localDir: string): Promise<SyncManifest> {
  const p = join(localDir, SYNC_STATE_FILE);
  if (!existsSync(p)) return {};
  try {
    const text = await readFile(p, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as SyncManifest;
  } catch {
    /* 损坏当空处理 */
  }
  return {};
}

/** 写本地 manifest */
async function writeManifest(localDir: string, manifest: SyncManifest): Promise<void> {
  const p = join(localDir, SYNC_STATE_FILE);
  await writeFile(p, JSON.stringify(manifest, null, 2), "utf8");
}

/** 安全写入一个记忆文件（确保目录存在） */
async function writeEntry(dir: string, key: string, content: string): Promise<void> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, key), content, "utf8");
}

/** 删除一个记忆文件（不存在则忽略） */
async function deleteEntry(dir: string, key: string): Promise<void> {
  try {
    await unlink(join(dir, key));
  } catch {
    /* 已不存在 */
  }
}

/**
 * 执行一次双向同步（local ↔ shared，base 为上次同步快照）。
 *
 * 幂等：内容已一致时不读写、只刷新 manifest。
 */
export async function syncTeamMemory(
  opts: TeamMemoryOptions,
  cwd: string = process.cwd(),
): Promise<TeamMemorySyncResult> {
  const log = getLogger();
  const empty: TeamMemorySyncResult = {
    success: false,
    pulled: 0,
    pushed: 0,
    deleted: 0,
    conflicts: 0,
    skippedSecrets: [],
    blockedIncomingSecrets: [],
  };

  if (!opts?.enabled) {
    return { ...empty, error: "团队记忆未启用", errorType: "disabled" };
  }
  const sharedDir = resolveSharedTeamDir(opts);
  if (!sharedDir) {
    return { ...empty, error: "未配置合法的共享目录 teamMemory.dir", errorType: "no_shared_dir" };
  }

  const localDir = getTeamMemPath(cwd);

  try {
    if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true });
    if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });

    const skippedSecrets: SkippedSecretFile[] = [];
    // P2-14：**两端都扫**。local 侧防外泄（命中不 push），shared 侧防反向流入
    // （命中不 pull）。此前 shared 侧传 false —— 共享目录是多人可写的，
    // 「用户显式配置的目录」只说明它不是任意攻击者可写，不等于里面每个字节可信。
    const blockedIncomingSecrets: SkippedSecretFile[] = [];
    const localEntries = await readEntries(localDir, true, skippedSecrets);
    const sharedEntries = await readEntries(sharedDir, true, blockedIncomingSecrets);
    const base = await readManifest(localDir);

    /**
     * 被隔离的共享 key：本轮**整个跳过**，不只是"不写本地"。
     *
     * 为什么不能只是从 sharedEntries 里剔除就完事 —— 剔除后该 key 在合并循环里
     * 长得和「共享侧已删除」一模一样，于是会走到删除传播分支，把我本地那份
     * 好端端的记忆删掉。**一个含 secret 的共享文件不该有删我本地文件的权力。**
     * 同理也不能让它走 push 分支：那会用我的版本覆盖共享侧，等于替对方
     * "修好"了他的文件，而他的 secret 到底要怎么处理只有他知道。
     */
    const quarantined = new Set(blockedIncomingSecrets.map((s) => s.path));

    // 所有涉及的 key（local ∪ shared ∪ base）
    const allKeys = new Set<string>([
      ...localEntries.keys(),
      ...sharedEntries.keys(),
      ...Object.keys(base),
    ]);

    let pulled = 0,
      pushed = 0,
      deleted = 0,
      conflicts = 0;
    const nextManifest: SyncManifest = {};

    for (const key of allKeys) {
      // P2-14：共享侧含 secret → 本轮两个方向都不动这个 key。
      // base 快照原样留存：等对方清理掉 secret 之后，正常规则自然接上
      // （丢掉 base 会让下一轮变成「双方都改」而造出一次假冲突）。
      if (quarantined.has(key)) {
        if (base[key]) nextManifest[key] = base[key];
        continue;
      }

      const local = localEntries.get(key);
      const shared = sharedEntries.get(key);
      const baseHash = base[key];

      const localHash = local?.hash;
      const sharedHash = shared?.hash;

      // 1. 两端一致（含都不存在）：仅记录 manifest
      if (localHash === sharedHash) {
        if (localHash) nextManifest[key] = localHash;
        continue;
      }

      const localChanged = localHash !== baseHash; // 含本地删除（localHash undefined）
      const sharedChanged = sharedHash !== baseHash;

      // 2. 仅本地变更 → push local → shared（含删除传播）
      if (localChanged && !sharedChanged) {
        if (local) {
          await writeEntry(sharedDir, key, local.content);
          nextManifest[key] = local.hash;
          pushed++;
        } else {
          // 本地删除且远端未改 → 删除远端
          await deleteEntry(sharedDir, key);
          deleted++;
        }
        continue;
      }

      // 3. 仅远端变更 → pull shared → local（含删除传播）
      if (sharedChanged && !localChanged) {
        if (shared) {
          await writeEntry(localDir, key, shared.content);
          nextManifest[key] = shared.hash;
          pulled++;
        } else {
          // 远端删除且本地未改 → 删除本地
          await deleteEntry(localDir, key);
          deleted++;
        }
        continue;
      }

      // 4. 双方都变更
      // 4a. 一侧删除 + 另一侧改动 → 复活改动方（改动优先于删除）
      if (!local && shared) {
        await writeEntry(localDir, key, shared.content);
        nextManifest[key] = shared.hash;
        pulled++;
        conflicts++;
        log.warn("TEAMMEM", `冲突：本地删除但远端改动，复活远端版本 ${key}`);
        continue;
      }
      if (local && !shared) {
        await writeEntry(sharedDir, key, local.content);
        nextManifest[key] = local.hash;
        pushed++;
        conflicts++;
        log.warn("TEAMMEM", `冲突：远端删除但本地改动，复活本地版本 ${key}`);
        continue;
      }

      // 4b. 双方都改且内容不同 → mtime 新者获胜，败者另存 .conflict 副本不丢数据
      if (local && shared) {
        conflicts++;
        const ts = Math.max(local.mtimeMs, shared.mtimeMs) | 0;
        const conflictName = key.replace(/\.md$/, `.conflict-${ts}.md`);
        if (local.mtimeMs >= shared.mtimeMs) {
          // 本地较新：本地胜，远端旧版另存到两端的 conflict 副本，再推本地
          await writeEntry(localDir, conflictName, shared.content);
          await writeEntry(sharedDir, key, local.content);
          await writeEntry(sharedDir, conflictName, shared.content);
          nextManifest[key] = local.hash;
          pushed++;
          log.warn("TEAMMEM", `冲突：本地较新获胜 ${key}，远端旧版另存 ${conflictName}`);
        } else {
          // 远端较新：远端胜，本地旧版另存，再拉远端
          await writeEntry(localDir, conflictName, local.content);
          await writeEntry(localDir, key, shared.content);
          await writeEntry(sharedDir, conflictName, local.content);
          nextManifest[key] = shared.hash;
          pulled++;
          log.warn("TEAMMEM", `冲突：远端较新获胜 ${key}，本地旧版另存 ${conflictName}`);
        }
      }
    }

    await writeManifest(localDir, nextManifest);

    // 本地目录被改动过 → 重建本地 MEMORY.md 索引。
    //
    // 索引是注入侧的唯一事实源（store.getTeamIndexContent 只读该文件、无扫目录
    // fallback），而上面四条改本地的路径（pull / 远端删除传播 / 冲突复活 / 冲突远端
    // 获胜）都只写条目文件。不在此重建，则：
    //   - 全新端索引恒 null → 团队记忆段落整段不进 system prompt（等同功能未上线）
    //   - 老端索引陈旧 → 只见自己写的，见不到同事的
    //   - 删除传播后索引留悬空指针 → 模型照索引 Read 必然失败
    // rebuild 是全目录扫描，一次补齐全部（含冲突副本已被其自身规则排除）。
    // pushed-only 的轮次不重建：本地未变，索引已由 saveTeamMemory 维护。
    if (pulled || deleted || conflicts) {
      try {
        const { rebuildTeamIndex } = await import("./store.ts");
        await rebuildTeamIndex(localDir);
      } catch (e: any) {
        // 索引重建失败不推翻已成功的同步（条目文件已落盘），仅告警
        log.warn("TEAMMEM", `本地 MEMORY.md 索引重建失败（条目已同步）: ${e?.message ?? e}`);
      }
    }

    if (skippedSecrets.length > 0) {
      const labels = Array.from(new Set(skippedSecrets.map((s) => s.label))).join(", ");
      log.warn(
        "TEAMMEM",
        `${skippedSecrets.length} 个文件含 secret(${labels})，已跳过同步（未外泄到共享目录）`,
      );
    }
    // P2-14：反向流入必须**点名告知**，不能只是静默不 pull。
    // 静默隔离的形态是「同事说他共享了，我这边就是看不到」——查不出原因；
    // 而这条告警指向的动作在对方那边（请他清理），所以必须说出是哪个文件。
    if (blockedIncomingSecrets.length > 0) {
      const labels = Array.from(new Set(blockedIncomingSecrets.map((s) => s.label))).join(", ");
      const names = blockedIncomingSecrets.map((s) => s.path).join(", ");
      log.warn(
        "TEAMMEM",
        `共享目录中 ${blockedIncomingSecrets.length} 个文件含 secret(${labels})，已拒绝拉取到本地: ${names}。` +
          `请让写入方移除凭证后重新共享——凭证若拉进本地记忆，会随 MEMORY.md 索引常驻每个会话的系统提示词。`,
      );
      // 防线触发计数（P1-12 指标 ③）：恒 0 的曲线本身是信号。
      // 只记类型与来源，不记路径、不记命中内容。
      try {
        const { logMemoryGuard } = await import("../../analytics/events.ts");
        for (const _ of blockedIncomingSecrets) {
          logMemoryGuard({ kind: "secret_rejected", via: "team_pull", scope: "team" });
        }
      } catch {
        /* 埋点失败不影响同步 */
      }
    }
    if (pulled || pushed || deleted || conflicts) {
      log.info(
        "TEAMMEM",
        `同步完成：拉 ${pulled} / 推 ${pushed} / 删 ${deleted} / 冲突 ${conflicts}`,
      );
    }

    return {
      success: true,
      pulled,
      pushed,
      deleted,
      conflicts,
      skippedSecrets,
      blockedIncomingSecrets,
    };
  } catch (err: any) {
    log.warn("TEAMMEM", `同步失败: ${err?.message ?? err}`);
    return { ...empty, error: err?.message ?? String(err), errorType: "io" };
  }
}

/** 仅拉取（启动时初始 pull 的语义包装，复用全量同步） */
export async function pullTeamMemory(
  opts: TeamMemoryOptions,
  cwd?: string,
): Promise<TeamMemorySyncResult> {
  return syncTeamMemory(opts, cwd);
}

/** 仅推送语义包装（watcher debounce 后调用，复用全量同步保证一致性） */
export async function pushTeamMemory(
  opts: TeamMemoryOptions,
  cwd?: string,
): Promise<TeamMemorySyncResult> {
  return syncTeamMemory(opts, cwd);
}

/** 导出供测试 */
export { SYNC_STATE_FILE, MAX_FILE_SIZE_BYTES, readManifest };
