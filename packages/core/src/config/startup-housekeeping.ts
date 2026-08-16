/**
 * 启动期配置目录"管家"任务（P1-2 + P2-1）
 *
 * 集中启动期幂等维护工作，均为 fire-and-forget、失败不阻塞启动：
 * 1. ensureConfigGitignore() —— 生成配置目录自身的 .gitignore（见 ensure-gitignore.ts）
 * 2. cleanupLegacyToolResults() —— 清理修复前老代码遗留的 tool-results 污染目录
 * 3. ensureRuntimeFilesGitignored() —— 把项目 .sid-code/ 下的运行时文件注册进全局 gitignore
 * 4. 按"清理水位线"节流触发过期数据清理 —— 避免每次启动都扫全盘。水位线内含：
 *    trajectories 旧 session / tool-outputs / tmp masked-outputs，
 *    以及孤儿 shell 快照、孤儿 task 输出、过期 checkpoints（后三项见下方"为什么需要兜底"）
 *
 * 项目 .sid-code/ 的 gitignore 策略（对标 claude-code，详见 lock.ts 文件头注）：
 * ┌────────────────────────────┬──────────┬────────────────────────────────┐
 * │ 文件                       │ 类型     │ Gitignore                       │
 * ├────────────────────────────┼──────────┼────────────────────────────────┤
 * │ scheduled_tasks.lock       │ 运行时锁 │ ✅ 全局 gitignore（本次修复）  │
 * │ settings.local.json        │ 本地配置 │ ✅ 写入时 fire-and-forget      │
 * │ permissions.local.yaml     │ 本地配置 │ ⬜ 读取不写入，暂不处理        │
 * │ scheduled_tasks.json       │ 团队配置 │ ❌ 不忽略（允许团队共享提交）  │
 * │ settings.json              │ 团队配置 │ ❌ 不忽略（允许团队共享提交）  │
 * │ commands/ skills/ agents/  │ 用户创建 │ ❌ 不忽略（用户显式初始化）    │
 * └────────────────────────────┴──────────┴────────────────────────────────┘
 *
 * 清理水位线机制（对标定期 GC）：
 * - 在 ~/.sid-code/.last-cleanup 记录上次清理的时间戳
 * - 距上次清理不足 CLEANUP_INTERVAL_MS（默认 24h）则跳过，零开销
 * - 到期则跑一轮轻量清理：删除明显过期的运行时数据目录的 stale 条目，
 *   随后刷新水位线
 *
 * 注意：本模块不做激进删除——只清理"明确过期且可安全重建"的运行时数据
 *（trajectories 旧 session、tmp、旧 tool-results、孤儿 shell 快照 / task 输出 / checkpoints）。
 * settings 与记忆由各自模块管理，本模块一概不碰。
 *
 * ## 为什么"各模块自己有清理策略"还需要这个启动期兜底（2026-08-16）
 *
 * 实测盘上 209MB，其中三块的清理逻辑**代码全在、调用全 0**。三种失效形态各不相同，
 * 但同一个根因：**清理的触发条件比清理本身更容易失效**。
 *
 * 1. `checkpoints/`（34MB）—— 清理挂在**懒加载对象的 init** 里。
 *    `CheckpointManager.cleanupOldSessions()`（`checkpoint/manager.ts:926`）实现完整，
 *    唯一调用点是 `init()` 末尾（`manager.ts:184`），而 `init()` 只在
 *    `getCheckpointManager()` 首次创建实例时跑（`manager.ts:1031`）。那个工厂的生产
 *    触发点全是懒加载的：`query/tool-executor.ts:444`（仅当本轮真要改文件）、
 *    `cli/app.ts:573`（仅 rewind）、`cli/app.ts:2694`（仅分叉）、
 *    `command/builtins.ts:483/534/600`（仅 /undo、/restore、/checkpoints）。
 *    于是**一个只读会话（问答、看代码、跑测试）从头到尾不触发清理**。
 *    实测 651 个超 30 天的目录躺在盘上没被删。
 *    （另一个默认值 `maxTotalSizeMb=200` 也永不触发：盘上只有 34MB。）
 *
 * 2. `shell-snapshots/`（52MB / 379 个）—— 清理挂在**退出钩子**里。
 *    `cleanupSnapshot()` 由 `registerCleanup()` 注册（`tool/bash/shell-snapshot.ts:239`），
 *    只在正常退出时跑。崩溃 / `kill -9` / SIGKILL / 被 harness 掐掉都不跑 → 快照永久残留。
 *    归因已实证到行：抽查最新 3 个文件名里的 pid（41542 / 41387 / 36664）**全部已退出**。
 *    且此前**没有任何启动期兜底**去回收上一次的残留。
 *    多 agent 并行会放大它：实测 20 分钟涨 4 个（仓库里随时有别的 agent 在跑 bash 工具）。
 *
 * 3. `tasks/`（21MB / 5621 个）—— 同 2 的形态：`evictTaskOutput()`
 *    （`task/disk-output.ts:175`）只在驱逐路径上删磁盘文件，进程异常退出就留下。
 *    残留时间跨度 6月8 → 8月4。
 *
 * 可复用的验收判据：**新增清理逻辑不能以"单测过"结案**，要问「在一个不使用该功能的
 * 真实会话里，它会被触发吗」。上面三处都是单测过、真实会话零触发。
 */

import { existsSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "./paths.ts";
import { ensureConfigGitignore } from "./ensure-gitignore.ts";
import { addFileGlobRuleToGitignore } from "./gitignore.ts";
import { cleanupPersistedOutputs } from "../context/tool-result-storage.ts";
import { getSidTempDir } from "@sid-code/shared/utils/temp-dir.ts";

/** 清理触发间隔：24 小时 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** trajectories 内 session 目录的过期阈值：30 天 */
const TRAJECTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * shell 快照的孤儿回收阈值：24 小时。
 *
 * ## 为什么必须按 mtime 判、**绝不能**按 pid 存活判
 *
 * 文件名是 `snapshot-<shell>-<pid>.sh`（`tool/bash/shell-snapshot.ts:204`），
 * 看着很适合"pid 不在了就删"。但这个判据在本仓的**多 agent 并行**常态下是错的：
 * 另一个 sid-code 进程的**活跃** pid，在本进程眼里同样「不是我的 pid」——
 * 删掉它正在 `source` 的快照，会让那个进程的 shell 环境（aliases/functions/PATH）
 * 在下次 bash 调用时静默失效。
 *
 * 按 mtime 超期判则是安全的：快照在创建时写一次，之后只被读。一个 24h 前写的快照，
 * 要么其进程已退出（孤儿），要么那个会话已经跑了 24h 以上 —— 后者即便被删，
 * 消费侧是 `source <file> 2>/dev/null || true`（`tool/bash.ts:523`），
 * 文件不存在只是降级为无快照，不报错、不中断命令。代价可接受，误删活跃 pid 不可接受。
 */
const SHELL_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** task `.output` 文件的孤儿回收阈值：7 天（与 tool-outputs 同口径） */
const TASK_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * checkpoints 孤儿会话目录的兜底回收阈值：30 天。
 *
 * 刻意与 `CheckpointManager` 自己的 `maxAgeDays` 默认值（30）**保持一致** ——
 * 本函数是那套策略的兜底触发者，不是第二套策略。写小了会删掉用户还能 `/undo` 的历史，
 * 写大了则兜不住。两个数字必须一起改（门禁见 startup-housekeeping.test.ts）。
 */
const CHECKPOINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 需要在全局 gitignore 中隐藏的运行时产物（非配置、非用户创建）。
 *
 * 判定标准——只列**纯运行时、可安全重建、绝不该入库**的东西：
 * - worktrees/：隔离工作区（几十 MB/个，git 二次工作树，重建即得）
 * - scheduled_tasks.lock：进程锁
 * - session-config.json：本进程 worktree session 状态
 * - swarm/、tasks/：Swarm 团队运行时邮箱与任务态
 * - tool-results/：历史遗留污染目录（新代码已改写 ~/.sid-code/，此处兜底老仓库）
 *
 * 刻意**不**列入（团队可共享，允许提交）：
 * settings.json / scheduled_tasks.json / commands/ / skills/ / agents/ / output-styles/
 *
 * 为什么必须有这一层：用户仓库的 .gitignore 是**用户的文件**，我们无权擅自修改；
 * 但也不能假设用户已经配好了忽略规则。写全局 gitignore（~/.config/git/ignore）
 * 让这些产物在该用户的所有仓库里默认隐身——既不碰用户文件，又不依赖用户先做配置。
 */
const RUNTIME_FILES_TO_GITIGNORE = [
  ".sid-code/worktrees/",
  ".sid-code/scheduled_tasks.lock",
  ".sid-code/session-config.json",
  ".sid-code/swarm/",
  ".sid-code/tasks/",
  ".sid-code/tool-results/",
];

/**
 * 执行启动期管家任务。应在 loadConfig 之后、主循环之前调用一次。
 *
 * @param now 当前时间戳（ms）。显式传入便于测试；默认 Date.now()。
 * @param opts.selfSessionId **本会话 id，强烈建议传**。checkpoint 清理会 rmSync
 *   别的会话目录，而本会话自己的 `registerSession()` 比本函数晚跑
 *  （`cli.ts:2212` vs `cli.ts:1157`）—— 不传则 `--resume` 一个 30 天前的旧会话时，
 *   会把用户正要恢复的那个会话的 checkpoint 删掉。详见 cleanupStaleCheckpoints 注释。
 */
export function runStartupHousekeeping(
  now: number = Date.now(),
  opts: { selfSessionId?: string } = {},
): void {
  // 1. 配置目录 .gitignore（独立幂等，与清理无关，始终尝试）
  ensureConfigGitignore();

  // 2. 一次性清理修复前老代码遗留的 tool-results 目录
  //    背景：早期 result-storage.ts 使用裸相对路径 ".sid-code/tool-results"，
  //    会在 cwd 下创建污染目录。修复后路径已改为 ~/.sid-code/trajectories/…，
  //    但修复前跑出的旧目录不会自动消失。此处做幂等清理：检测到即删。
  try {
    cleanupLegacyToolResults();
  } catch (err) {
    getLogger().debug("CLEANUP", `旧 tool-results 清理跳过: ${err}`);
  }

  // 3. 注册项目 .sid-code/ 下的运行时文件到全局 gitignore
  //    对标 claude-code 的 addFileGlobRuleToGitignore 机制，确保
  //    scheduled_tasks.lock 等纯运行时文件在所有项目中自动被 git 忽略，
  //    用户不会在 git status 里看到它们（fire-and-forget，不阻塞启动）。
  try {
    ensureRuntimeFilesGitignored();
  } catch (err) {
    getLogger().debug("CLEANUP", `运行时文件 gitignore 注册跳过: ${err}`);
  }

  // 4. 按水位线节流的过期清理
  try {
    if (!shouldRunCleanup(now)) return;
    const removed = cleanupStaleTrajectories(now);
    // 5. 精细文件级清理：对未过期的 session 中的 tool-outputs 文件按 7 天阈值清理
    const outputsCleaned = cleanupStaleToolOutputs();
    // 6. 清理 /tmp 下过期的 masked-outputs 临时文件
    const maskedCleaned = cleanupStaleMaskedOutputs();
    // 7-9. 孤儿运行时数据兜底回收（各模块自己的清理只挂在正常路径上，见文件头注释）
    const snapshotsCleaned = cleanupOrphanedShellSnapshots(now);
    const taskOutputsCleaned = cleanupOrphanedTaskOutputs(now);
    const checkpointsCleaned = cleanupStaleCheckpoints(now, opts.selfSessionId);
    writeWatermark(now);
    if (removed > 0) {
      getLogger().info("CLEANUP", `启动清理：移除 ${removed} 个过期 trajectory 会话目录`);
    }
    if (outputsCleaned > 0) {
      getLogger().info("CLEANUP", `启动清理：移除 ${outputsCleaned} 个过期工具输出文件`);
    }
    if (maskedCleaned > 0) {
      getLogger().info("CLEANUP", `启动清理：移除 ${maskedCleaned} 个过期遮罩输出文件`);
    }
    if (snapshotsCleaned > 0) {
      getLogger().info("CLEANUP", `启动清理：回收 ${snapshotsCleaned} 个孤儿 shell 快照`);
    }
    if (taskOutputsCleaned > 0) {
      getLogger().info("CLEANUP", `启动清理：回收 ${taskOutputsCleaned} 个孤儿 task 输出文件`);
    }
    if (checkpointsCleaned > 0) {
      getLogger().info(
        "CLEANUP",
        `启动清理：移除 ${checkpointsCleaned} 个过期 checkpoint 会话目录`,
      );
    }
  } catch (err) {
    getLogger().debug("CLEANUP", `启动清理跳过: ${err}`);
  }
}

/** 距上次清理是否已超过间隔（水位线不存在视为需要清理） */
function shouldRunCleanup(now: number): boolean {
  try {
    const path = sidPaths.lastCleanup();
    if (!existsSync(path)) return true;
    const last = parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (!Number.isFinite(last)) return true;
    return now - last >= CLEANUP_INTERVAL_MS;
  } catch {
    return true;
  }
}

/** 刷新清理水位线为当前时间 */
function writeWatermark(now: number): void {
  try {
    writeFileSync(sidPaths.lastCleanup(), String(now), { mode: 0o644 });
  } catch {
    // 写水位线失败不致命：最坏下次启动再尝试清理
  }
}

/**
 * 清理 trajectories/sessions 下超过 TRAJECTORY_MAX_AGE_MS 的会话目录。
 * 返回移除的目录数。
 */
function cleanupStaleTrajectories(now: number): number {
  const sessionsRoot = join(sidPaths.trajectories(), "sessions");
  if (!existsSync(sessionsRoot)) return 0;

  let removed = 0;
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessionsRoot, entry.name);
    try {
      const stat = statSync(dir);
      if (now - stat.mtimeMs > TRAJECTORY_MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // 单个目录失败不影响其它
    }
  }
  return removed;
}

/**
 * 精细文件级清理：遍历未过期的 session 目录，对 tool-outputs 子目录内的文件按 7 天阈值清理。
 * 返回清理的文件总数。
 */
function cleanupStaleToolOutputs(): number {
  const sessionsRoot = join(sidPaths.trajectories(), "sessions");
  if (!existsSync(sessionsRoot)) return 0;

  let totalCleaned = 0;
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      cleanupPersistedOutputs(entry.name);
      // cleanupPersistedOutputs 内部按 7 天阈值删过期文件，但不返回计数
      // 这里只能粗略计数：检查 tool-outputs 目录是否被清空删除来判断
      const toolOutputsDir = join(sessionsRoot, entry.name, "tool-outputs");
      if (!existsSync(toolOutputsDir)) totalCleaned++;
    } catch {
      // 单个 session 清理失败不影响其它
    }
  }
  return totalCleaned;
}

/**
 * 清理 /tmp 下过期的 masked-outputs 临时目录。
 * ToolOutputMaskingService 遮罩时将完整输出保存到 /tmp/sid-code-{uid}/sessions/{sessionId}/masked-outputs/，
 * 系统重启会清理 /tmp，但长运行服务器上不会自动消失。按 7 天阈值清理过期文件。
 */
function cleanupStaleMaskedOutputs(): number {
  let totalCleaned = 0;
  try {
    const tempSessionsRoot = join(getSidTempDir(), "sessions");
    if (!existsSync(tempSessionsRoot)) return 0;

    const now = Date.now();
    const MAX_AGE = 7 * 24 * 3600_000; // 7 天

    for (const sessionEntry of readdirSync(tempSessionsRoot, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue;
      const maskedDir = join(tempSessionsRoot, sessionEntry.name, "masked-outputs");
      if (!existsSync(maskedDir)) continue;

      try {
        const files = readdirSync(maskedDir);
        let removedInDir = 0;
        for (const file of files) {
          const filePath = join(maskedDir, file);
          try {
            const stat = statSync(filePath);
            if (now - stat.mtimeMs > MAX_AGE) {
              rmSync(filePath, { force: true });
              removedInDir++;
              totalCleaned++;
            }
          } catch {
            /* 单文件失败跳过 */
          }
        }
        // 清空后删除目录本身
        if (removedInDir > 0) {
          try {
            const remaining = readdirSync(maskedDir);
            if (remaining.length === 0) rmSync(maskedDir, { force: true });
          } catch {
            /* 目录删除失败不致命 */
          }
        }
      } catch {
        /* 单个 session 目录失败跳过 */
      }
    }
  } catch {
    // temp dir 不存在或无权限，跳过
  }
  return totalCleaned;
}

/**
 * 回收孤儿 shell 快照（`~/.sid-code/shell-snapshots/snapshot-<shell>-<pid>.sh`）。
 *
 * 判据是 **mtime 超期**，刻意不看 pid 存活 —— 理由见 SHELL_SNAPSHOT_MAX_AGE_MS 的注释：
 * 并行 agent 的活跃 pid 在本进程眼里同样「不是我的」，按 pid 判会误删别人正在用的快照。
 *
 * 只删 `.sh` 文件、不递归、不删目录本身：目录是 `doCreateSnapshot()` 每次 mkdir 的目标，
 * 留着零成本；而限定后缀可避免将来有人在该目录放别的东西时被连带删掉。
 *
 * @returns 删除的文件数
 */
function cleanupOrphanedShellSnapshots(now: number): number {
  const dir = sidPaths.shellSnapshots();
  if (!existsSync(dir)) return 0;

  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;
    const file = join(dir, entry.name);
    try {
      if (now - statSync(file).mtimeMs > SHELL_SNAPSHOT_MAX_AGE_MS) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // 单个文件失败（并发删除、权限）不影响其余
    }
  }
  return removed;
}

/**
 * 回收孤儿 task 输出文件（`~/.sid-code/tasks/<taskId>.output`）。
 *
 * `evictTaskOutput()`（`task/disk-output.ts:175`）只在驱逐路径上删文件，
 * 进程异常退出则留下。实测 5621 个残留、跨度两个月。
 *
 * 同样按 mtime 判：taskId 不含 pid，本来就无从判断"谁的"。
 * 7 天前写的输出文件不可能还有活跃 task 在 append —— 而即便有，
 * 消费侧 `readTaskOutputTail()` 对读失败返回 null（`disk-output.ts:166`），
 * 降级为"看不到历史输出"，不会抛错。
 *
 * @returns 删除的文件数
 */
function cleanupOrphanedTaskOutputs(now: number): number {
  const dir = sidPaths.tasks();
  if (!existsSync(dir)) return 0;

  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".output")) continue;
    const file = join(dir, entry.name);
    try {
      if (now - statSync(file).mtimeMs > TASK_OUTPUT_MAX_AGE_MS) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // 单个文件失败不影响其余
    }
  }
  return removed;
}

/**
 * 兜底回收过期的 checkpoint 会话目录。
 *
 * ## 与 CheckpointManager.cleanupOldSessions() 的关系
 *
 * 这里**不是第二套策略**，是同一策略的第二个触发者：阈值与它的 `maxAgeDays` 默认值
 * 对齐（都是 30 天）。它自己那条路径打不到只读会话（挂在懒加载 init 里，
 * 详见文件头注释第 1 条），所以需要一个与"用不用 checkpoint 功能"无关的触发点。
 *
 * ## 并行安全：为什么必须排除活跃会话，且**只**靠 mtime 不够
 *
 * `rmSync` 删的是**别的会话**的目录。`cleanupOldSessions()` 靠
 * `session === this.sessionId` 跳过自己，但跳不过「另一个正在跑的会话」——
 * 本仓多 agent 并行是常态。单靠 mtime 在这里不足以兜住一种真实情形：
 * 一个已经跑了 30 天以上的长会话，其 checkpoint 目录 mtime 可能停在很早
 *（只在真改文件时才写），却仍然活着并随时可能被 `/undo` 用到。
 *
 * 所以判据是 **mtime 超期 且 不在活跃会话注册表里 且 不是本会话**。
 * `listActiveSessions()`（`session/concurrent.ts:79`）按 pid 存活过滤，返回真正在跑的会话 ——
 * 注意这里用 pid 是安全的，因为方向相反：**pid 活着 → 保留**（宁可多留），
 * 而不是"pid 死了 → 删"（那才是误删别人快照的错法）。
 *
 * ## 为什么还要单独传 `selfSessionId`，注册表不够
 *
 * 有一个真实的时序缺口：本函数由 `runStartupHousekeeping()` 调用，接线在
 * `cli.ts:1157`，而**本会话自己**的 `registerSession()` 要到 `cli.ts:2212` 才跑。
 * 那之间本会话不在注册表里。平时无害（新会话的 checkpoint 目录还不存在或很新），
 * 但 `--resume` 一个 30 天前的旧会话时就致命：目录 mtime 超期、又还没注册，
 * 于是清理会把**用户正要恢复的那个会话**的 checkpoint 删掉。
 * 所以显式传入本会话 id 兜住这一段。
 *
 * ## 关于"拿不到活跃列表"这件事的诚实说明
 *
 * `listActiveSessions()` 内部把读失败吞掉并返回 `[]`（`concurrent.ts:81/88`），
 * 所以本函数**分不清**「真的没有活跃会话」与「目录读不了」—— 想做真正的 fail-closed
 * 需要改那个函数的签名（让它能报告失败），那是另一个 PR 的事。
 * 当前的实际保护来自另外两层：`selfSessionId` 兜住本会话，30 天阈值兜住
 * "刚跑过的会话不会被删"（活跃会话的目录 mtime 几乎必然在 30 天内）。
 * 这里刻意不写"fail-closed"三个字 —— 那会让下一个人以为这条路径已经安全了。
 *
 * @param now 当前时间戳
 * @param selfSessionId 本会话 id（见上方时序说明）。缺省时只靠注册表，
 *   适用于不知道会话 id 的调用方（如纯维护脚本）。
 * @returns 删除的目录数
 */
function cleanupStaleCheckpoints(now: number, selfSessionId?: string): number {
  const root = sidPaths.checkpointsRoot();
  if (!existsSync(root)) return 0;

  // 活跃会话集合。异常时退化为"只保护本会话"，而不是整轮放弃 ——
  // 注意 listActiveSessions 自己吞异常返回 []，所以这个 catch 实际很难命中，
  // 留着是防它将来改成会抛的实现（那时这里不该把整轮清理带崩）。
  let activeIds = new Set<string>();
  try {
    const { listActiveSessions } = require("../session/concurrent.ts");
    activeIds = new Set<string>(
      listActiveSessions().map((s: { sessionId: string }) => s.sessionId),
    );
  } catch (err) {
    getLogger().debug("CLEANUP", `活跃会话列表不可用，仅保护本会话: ${err}`);
  }
  if (selfSessionId) activeIds.add(selfSessionId);

  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (activeIds.has(entry.name)) continue; // 有进程在跑，绝不碰
    const dir = join(root, entry.name);
    try {
      if (now - statSync(dir).mtimeMs > CHECKPOINT_MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // 单个目录失败不影响其余
    }
  }
  return removed;
}

/**
 * 一次性清理修复前老代码遗留的 .sid-code/tool-results/ 污染目录。
 *
 * 背景（详见 docs/bugfixes/double_checked/点sid-code目录污染项目git工作区-路径策略不一致分析.md）：
 * 早期 result-storage.ts 使用裸相对路径 ".sid-code/tool-results"，会在用户当前
 * 所在的任意项目目录下创建 .sid-code/tool-results/ 目录。修复（2026-06-11）已将
 * 落盘路径改为 ~/.sid-code/trajectories/sessions/{sessionId}/tool-outputs/，但修复前
 * 跑出的旧目录不会自动消失。
 *
 * 本函数在启动时检测当前 cwd 下是否存在 .sid-code/tool-results/ 目录，
 * 存在则递归删除。幂等：不存在则无操作。fire-and-forget：失败不阻塞启动。
 */
function cleanupLegacyToolResults(): void {
  const legacyDir = join(process.cwd(), ".sid-code", "tool-results");
  if (!existsSync(legacyDir)) return;

  const log = getLogger();
  try {
    rmSync(legacyDir, { recursive: true, force: true });
    log.info("CLEANUP", `已清理旧 tool-results 目录: ${legacyDir}`);
  } catch (err: any) {
    log.debug("CLEANUP", `清理旧 tool-results 目录失败: ${err?.message ?? err}`);
  }
}

/**
 * 将项目 .sid-code/ 下的运行时文件注册到全局 gitignore。
 *
 * 设计对标 claude-code：只操作全局 gitignore（~/.config/git/ignore），
 * 不修改项目自己的 .gitignore。写入前用 git check-ignore 判重，
 * 非 git 仓库直接跳过。fire-and-forget，不阻塞启动。
 *
 * 适用范围：纯运行时文件（scheduled_tasks.lock）。
 * 不包含：团队可共享配置（scheduled_tasks.json / settings.json）、
 * 用户显式创建的目录（commands/ skills/ agents/）。
 */
function ensureRuntimeFilesGitignored(): void {
  for (const file of RUNTIME_FILES_TO_GITIGNORE) {
    void addFileGlobRuleToGitignore(file);
  }
}
