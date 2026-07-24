/**
 * 外部编辑器编辑 prompt（P1-3，对标 cc Ctrl+G）
 *
 * 把当前输入框内容写入临时文件，用 $VISUAL / $EDITOR 打开，用户编辑保存退出后
 * 读回内容回填输入框。编辑器是全屏 TUI（vim/nano/...），必须先让 ink 让出终端：
 * - 调 ink 实例的 enterAlternateScreen() 暂停渲染 + 挂起 stdin + 清屏；
 * - spawn 编辑器（继承 stdio，用户直接交互）；
 * - 编辑器退出后调 exitAlternateScreen() 恢复 ink 全量重绘。
 *
 * 复用 src/ink/ink.tsx 已有的 enter/exitAlternateScreen handoff 能力，不自造终端控制。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import inkInstances from "../../ink/instances.js";
import { getLogger } from "../../debug/logger.ts";

/**
 * 解析要使用的编辑器命令。优先 $VISUAL（全屏编辑器），其次 $EDITOR，
 * 都没有时回退到平台默认（*nix: vi；win32: notepad）。
 * 返回 [命令, ...预置参数]（支持 "code -w" 这类带参数的配置）。
 */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.VISUAL || env.EDITOR || "").trim();
  if (raw) {
    // 简单按空白切分，支持 "code --wait" / "subl -w" 等。
    return raw.split(/\s+/);
  }
  return process.platform === "win32" ? ["notepad"] : ["vi"];
}

export interface ExternalEditResult {
  /** 用户是否成功编辑（编辑器 0 退出）。false = 编辑器不可用/异常，调用方应保留原文。 */
  ok: boolean;
  /** 编辑后的文本（ok=true 时有效；已去除结尾多余换行）。 */
  text: string;
  /** 失败原因（供日志/提示）。 */
  error?: string;
}

/**
 * 用外部编辑器编辑一段文本。阻塞直到编辑器退出。
 *
 * @param initialText 打开时预填入临时文件的内容（当前输入框文本）。
 * @param stdout 用于定位 ink 实例的写流（默认 process.stdout）。
 */
export async function editInExternalEditor(
  initialText: string,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<ExternalEditResult> {
  const log = getLogger();
  const ink = inkInstances.get(stdout);

  // 建临时文件（.md 后缀让编辑器启用 markdown 高亮，贴合 prompt 场景）。
  let dir: string | null = null;
  let filePath = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "sid-prompt-"));
    filePath = join(dir, "prompt.md");
    writeFileSync(filePath, initialText, "utf8");
  } catch (e) {
    return { ok: false, text: initialText, error: `创建临时文件失败: ${String(e)}` };
  }

  const cmd = resolveEditorCommand();
  const bin = cmd[0];
  const args = [...cmd.slice(1), filePath];

  // 让出终端给编辑器（ink 暂停 + 挂起 stdin + 清屏）。
  ink?.enterAlternateScreen();

  const exitCode = await new Promise<number>((resolve) => {
    try {
      const child = spawn(bin, args, { stdio: "inherit" });
      child.on("error", (err) => {
        log.warn("UI:EDITOR", `外部编辑器启动失败: ${String(err)}`);
        resolve(-1);
      });
      child.on("exit", (code) => resolve(code ?? 0));
    } catch (e) {
      log.warn("UI:EDITOR", `spawn 编辑器异常: ${String(e)}`);
      resolve(-1);
    }
  });

  // 恢复 ink 渲染（全量重绘）。
  ink?.exitAlternateScreen();

  if (exitCode !== 0) {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    return {
      ok: false,
      text: initialText,
      error: exitCode === -1 ? `无法启动编辑器 "${bin}"` : `编辑器以非零码退出 (${exitCode})`,
    };
  }

  // 读回编辑结果。
  let edited = initialText;
  try {
    edited = readFileSync(filePath, "utf8");
    // 编辑器常在末尾补一个换行，去掉尾部空白换行（保留内部换行）。
    edited = edited.replace(/\n+$/, "");
  } catch (e) {
    log.warn("UI:EDITOR", `读取编辑结果失败: ${String(e)}`);
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    return { ok: false, text: initialText, error: `读取编辑结果失败: ${String(e)}` };
  }

  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  return { ok: true, text: edited };
}

/**
 * M5：用外部编辑器直接打开一个**已存在的文件**（不经临时文件）。
 * 阻塞直到编辑器退出。用于 /memory 面板编辑 auto-memory 条目（对齐 CC editFileInEditor）。
 *
 * @param filePath 要打开的文件绝对路径。
 * @param stdout   用于定位 ink 实例的写流（默认 process.stdout）。
 * @returns ok=true 表示编辑器 0 退出；否则 error 说明原因。
 */
export async function openFileInExternalEditor(
  filePath: string,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<{ ok: boolean; error?: string }> {
  const log = getLogger();
  const ink = inkInstances.get(stdout);
  const cmd = resolveEditorCommand();
  const bin = cmd[0];
  const args = [...cmd.slice(1), filePath];

  ink?.enterAlternateScreen();
  const exitCode = await new Promise<number>((resolve) => {
    try {
      const child = spawn(bin, args, { stdio: "inherit" });
      child.on("error", (err) => {
        log.warn("UI:EDITOR", `外部编辑器启动失败: ${String(err)}`);
        resolve(-1);
      });
      child.on("exit", (code) => resolve(code ?? 0));
    } catch (e) {
      log.warn("UI:EDITOR", `spawn 编辑器异常: ${String(e)}`);
      resolve(-1);
    }
  });
  ink?.exitAlternateScreen();

  if (exitCode !== 0) {
    return {
      ok: false,
      error: exitCode === -1 ? `无法启动编辑器 "${bin}"` : `编辑器以非零码退出 (${exitCode})`,
    };
  }
  return { ok: true };
}
