/**
 * 持久 Shell 会话 — Shell 环境快照
 *
 * 对标 claude-code 的 ShellSnapshot.ts。核心思路：
 *   不维护长生命周期 shell 进程，而是在会话启动时跑一次登录 shell，
 *   把用户 .zshrc/.bashrc 里的 aliases / functions / options / PATH 抓出来
 *   存成一个快照 .sh 文件。之后每次执行 bash 命令前先 `source` 这个快照，
 *   把用户 shell 环境重新注入当前子进程，看起来就像同一个 shell 一直在跑。
 *
 * 与 cwd 追踪（bash.ts 内）组合，实现"跨命令保留 cwd + aliases/functions 可用"。
 *
 * 设计要点：
 * - Windows 不支持（powershell 无法 source POSIX 脚本），调用方需自行跳过。
 * - 快照创建失败不阻断 bash 工具，降级为无快照 + 登录 shell 模式。
 * - 快照文件写入 ~/.sid-code/shell-snapshots/，会话退出时清理。
 *
 * See: docs/bugfixes/todo/p0-2/持久Shell会话-补齐分析.md
 */

import { execFile } from "child_process";
import { mkdirSync, unlinkSync, existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { sidPaths } from "../../config/paths.ts";
import { registerCleanup } from "@sid-code/shared/utils/graceful-shutdown.ts";
import { getLogger } from "../../debug/logger.ts";

/** 快照创建超时（对标 claude-code 的 10 秒） */
const SNAPSHOT_CREATION_TIMEOUT_MS = 10_000;

/** execFile 输出缓冲上限（1MB，对标 claude-code） */
const SNAPSHOT_MAX_BUFFER = 1024 * 1024;

/** 模块级单例：同一进程中多个 BashTool 实例共享同一个快照创建 Promise（避免并发写同一文件竞态） */
let snapshotCreatePromise: Promise<string | undefined> | null = null;

/**
 * POSIX 单引号转义：把字符串包成可安全放进 shell 单引号的形式。
 *
 * 规则：用单引号包裹整体，内部每个 `'` 替换为 `'\''`
 *   （闭合单引号 → 转义单引号 → 重新开单引号）。
 * 这是 POSIX 通用做法，对 `$`、空格、`;`、反引号等一切特殊字符都安全，
 * 不依赖任何正则猜测。命令本身含单引号是最常见的破点，必须用它兜住。
 *
 * 例：  it's a "test"   →   'it'\''s a "test"'
 */
export function escapeForShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 根据 shell 路径确定用户配置文件（对标 claude-code getConfigFile）。
 *   zsh  → ~/.zshrc
 *   bash → ~/.bashrc
 *   其它 → ~/.profile
 */
function getConfigFile(shellPath: string): string {
  const fileName = shellPath.includes("zsh")
    ? ".zshrc"
    : shellPath.includes("bash")
      ? ".bashrc"
      : ".profile";
  return join(homedir(), fileName);
}

/**
 * 生成"抓取用户 aliases/functions/options"的 shell 脚本片段（对标 getUserSnapshotContent）。
 *
 * zsh 用 typeset / setopt，bash 用 declare / shopt。
 * 抓取结果统一追加到 $SNAPSHOT_FILE。
 */
function getUserSnapshotContent(shellPath: string): string {
  const isZsh = shellPath.includes("zsh");

  // 函数抓取：zsh 用 `typeset +f` 列名再 `typeset -f` 取体；bash 用 `declare -f`。
  // 过滤补全函数（单下划线前缀 _xxx，但保留 __xxx），避免污染。
  const functionsBlock = isZsh
    ? `
# ── Functions (zsh) ──
echo "# Functions" >> "$SNAPSHOT_FILE"
typeset +f 2>/dev/null | grep -vE '^_[^_]' | while IFS= read -r func; do
  typeset -f -- "$func" >> "$SNAPSHOT_FILE" 2>/dev/null
done`
    : `
# ── Functions (bash) ──
echo "# Functions" >> "$SNAPSHOT_FILE"
declare -F 2>/dev/null | sed 's/^declare -f //' | grep -vE '^_[^_]' | while IFS= read -r func; do
  declare -f -- "$func" >> "$SNAPSHOT_FILE" 2>/dev/null
done`;

  // 选项抓取：zsh setopt / bash shopt
  const optionsBlock = isZsh
    ? `
# ── Shell Options (zsh) ──
echo "# Shell Options" >> "$SNAPSHOT_FILE"
setopt 2>/dev/null | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"`
    : `
# ── Shell Options (bash) ──
echo "# Shell Options" >> "$SNAPSHOT_FILE"
shopt -p 2>/dev/null | head -n 1000 >> "$SNAPSHOT_FILE"`;

  // 别名抓取：先 unalias -a（避免函数体内冻结别名），再写当前别名定义。
  // 注意：unalias 写在函数抓取之后、别名写入之前，对标 claude-code。
  const aliasesBlock = `
# ── Aliases ──
echo "# Aliases" >> "$SNAPSHOT_FILE"
alias 2>/dev/null | sed 's/^alias //' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`;

  return `${functionsBlock}
${optionsBlock}
${aliasesBlock}`;
}

/**
 * 生成"sid-code 自身注入"的 shell 脚本片段（对标 getClaudeCodeSnapshotContent，精简版）。
 *
 * MVP 只固化 PATH（保证后续命令与当前进程 PATH 一致）。
 * 不做 rg/find/grep shadow（sid 的 grep/glob 是独立工具，不依赖 shell 命令）。
 */
function getSidCodeSnapshotContent(): string {
  // PATH 用单引号转义，防止路径含空格/特殊字符破坏脚本
  const currentPath = process.env.PATH || "";
  return `
# ── sid-code injected ──
export PATH=${escapeForShell(currentPath)}`;
}

/**
 * 组装完整快照脚本（对标 getSnapshotScript）。
 *
 * 流程：
 *   1. source 用户配置文件（< /dev/null 防止交互式提示卡住）
 *   2. 创建/清空快照文件（>| 强制覆盖，绕过 noclobber）
 *   3. 写入 unalias -a（清除别名，避免函数体冻结）
 *   4. 抓取用户 functions/options/aliases
 *   5. 写入 sid-code 注入部分（PATH）
 */
function getSnapshotScript(shellPath: string, snapshotFile: string): string {
  const configFile = getConfigFile(shellPath);
  const quotedSnapshot = escapeForShell(snapshotFile);
  const quotedConfig = escapeForShell(configFile);

  return `
SNAPSHOT_FILE=${quotedSnapshot}
# source 用户配置（容错：配置可能不存在或报错，不阻断快照）
[ -f ${quotedConfig} ] && source ${quotedConfig} < /dev/null 2>/dev/null || true

# 初始化快照文件（>| 强制覆盖，绕过 noclobber）
echo "# sid-code shell snapshot" >| "$SNAPSHOT_FILE"
echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"
${getUserSnapshotContent(shellPath)}
${getSidCodeSnapshotContent()}
`;
}

/** 当前会话的快照文件路径（用于 cleanup） */
let activeSnapshotPath: string | undefined;

/**
 * 创建并保存 shell 快照。
 *
 * @param shellPath 用户 shell 路径（如 /bin/zsh）
 * @returns 快照文件绝对路径；失败或 Windows 返回 undefined（调用方降级处理）
 */
export async function createAndSaveSnapshot(shellPath: string): Promise<string | undefined> {
  // 模块级单例：多个 BashTool 实例并发构造时，只创建一次快照，避免并发写同一文件破坏快照内容
  if (snapshotCreatePromise) return snapshotCreatePromise;

  const log = getLogger();

  // Windows 不支持（powershell 无法 source POSIX 脚本）
  if (platform() === "win32") {
    log.debug("BASH", "Windows 平台跳过 shell 快照创建");
    return undefined;
  }

  // 发起创建（先占位 Promise，防止并发调用重入）
  snapshotCreatePromise = doCreateSnapshot(shellPath, log);
  return snapshotCreatePromise;
}

/** 实际执行快照创建（由单例保护，保证同一进程只跑一次） */
async function doCreateSnapshot(
  shellPath: string,
  log: ReturnType<typeof getLogger>,
): Promise<string | undefined> {
  try {
    const snapshotDir = sidPaths.shellSnapshots();
    mkdirSync(snapshotDir, { recursive: true });

    // 文件名带 shell 类型 + pid（不用 Date.now/Math.random，保持确定性可测试）
    const shellName = shellPath.includes("zsh")
      ? "zsh"
      : shellPath.includes("bash")
        ? "bash"
        : "sh";
    const snapshotFile = join(snapshotDir, `snapshot-${shellName}-${process.pid}.sh`);

    const script = getSnapshotScript(shellPath, snapshotFile);

    await new Promise<void>((resolve, reject) => {
      execFile(
        shellPath,
        ["-c", "-l", script],
        {
          env: {
            ...process.env,
            SHELL: shellPath,
            GIT_EDITOR: "true",
            SID_CODE: "1",
          },
          timeout: SNAPSHOT_CREATION_TIMEOUT_MS,
          maxBuffer: SNAPSHOT_MAX_BUFFER,
        },
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        },
      );
    });

    // 验证文件确实生成
    if (!existsSync(snapshotFile)) {
      log.debug("BASH", "快照脚本执行完成但未生成文件，降级为无快照");
      return undefined;
    }

    activeSnapshotPath = snapshotFile;
    // 注册会话退出时清理
    registerCleanup(() => {
      cleanupSnapshot();
    });

    log.debug("BASH", `shell 快照已创建: ${snapshotFile}`);
    return snapshotFile;
  } catch (err: any) {
    log.debug("BASH", `创建 shell 快照失败，降级为无快照: ${err?.message || err}`);
    return undefined;
  }
}

/** 清理当前会话的快照文件（会话退出时调用） */
export function cleanupSnapshot(): void {
  // 重置单例：清理后快照文件已不存在，需允许后续重新创建（会话退出兜底 + 测试隔离）。
  // 无条件重置，覆盖"创建失败从未设置 activeSnapshotPath"的情况。
  snapshotCreatePromise = null;
  if (!activeSnapshotPath) return;
  try {
    unlinkSync(activeSnapshotPath);
  } catch {
    /* 文件可能已不存在，忽略 */
  }
  activeSnapshotPath = undefined;
}
