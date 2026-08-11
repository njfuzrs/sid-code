/**
 * 剪贴板图片读取 + 拖放图片路径识别（P2-6 / P2-7）
 *
 * 背景：sid 的多模态 vision 管道已完备（Read 工具读图 → mediaBlocks → 支持 vision 的
 * provider）。缺的只是"输入侧拿到图片"这一段。本模块补齐两条输入路径：
 *
 * - P2-6 剪贴板截图：paste 事件收到空内容时（终端对图片剪贴板的典型信号），调系统工具
 *   把剪贴板图片落到临时 PNG 文件，返回其路径。上层据此插入 `@<path>` 引用，走 Read。
 *   · macOS：pngpaste（若装了）优先，否则 osascript 兜底。
 *   · Linux：wl-paste（Wayland）或 xclip（X11）。
 *   · Windows：PowerShell Get-Clipboard。
 *
 * - P2-7 拖放：多数终端把文件拖入窗口时会"粘贴文件路径"。若粘贴文本是单个图片文件路径
 *   （扩展名匹配 vision 支持集且文件存在），识别为图片引用。成本远低于剪贴板读取。
 *
 * 所有系统调用都有超时保护与静默失败（返回 null），绝不因外部工具缺失/异常卡住输入。
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { ensureSidTempSubdir } from "@sid-code/shared/utils/temp-dir.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

/** vision 支持的图片扩展名（严格对齐 read.ts / Anthropic vision 四种 + jpg 别名）。 */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** 系统命令超时（ms）：剪贴板读取可能涉及大图编码，给足但有上限。 */
const CLIPBOARD_TIMEOUT_MS = 3000;

/** 生成一个唯一的临时图片文件路径（.sid-code tmp 下的 pasted-images 子目录）。 */
function makeTempImagePath(nowMs: number): string {
  const dir = ensureSidTempSubdir("pasted-images");
  // 不依赖 Math.random（沙箱禁用 + 可复现）；nowMs 已足够唯一（同毫秒双击粘贴概率极低）。
  return join(dir, `clip-${nowMs}.png`);
}

/**
 * 尝试从系统剪贴板读取图片，落到临时 PNG 文件。成功返回文件路径，无图片/失败返回 null。
 * nowMs 由调用方传入（便于测试与避免沙箱禁用的时钟 API）。
 */
export function readClipboardImageToFile(nowMs: number): string | null {
  const log = getLogger();
  const plat = platform();
  const outPath = makeTempImagePath(nowMs);

  try {
    if (plat === "darwin") {
      return readClipboardMacOS(outPath) ? outPath : null;
    }
    if (plat === "linux") {
      return readClipboardLinux(outPath) ? outPath : null;
    }
    if (plat === "win32") {
      return readClipboardWindows(outPath) ? outPath : null;
    }
  } catch (e) {
    log.debug("CLIPBOARD_IMG", `读取剪贴板图片失败（忽略）: ${(e as Error)?.message}`);
  }
  return null;
}

/** macOS：优先 pngpaste，否则 osascript 提取剪贴板 PNG。落盘成功且非空返回 true。 */
function readClipboardMacOS(outPath: string): boolean {
  // pngpaste <file>：装了就用，最稳。
  if (commandExists("pngpaste")) {
    const r = spawnSync("pngpaste", [outPath], { timeout: CLIPBOARD_TIMEOUT_MS });
    if (r.status === 0 && fileHasBytes(outPath)) return true;
  }
  // osascript 兜底：从剪贴板取 «class PNGf» 写文件。剪贴板无图片时脚本报错 → 返回 false。
  const script = `
    set outFile to (POSIX file "${outPath.replace(/"/g, '\\"')}")
    try
      set pngData to the clipboard as «class PNGf»
    on error
      return "no-image"
    end try
    set fh to open for access outFile with write permission
    set eof fh to 0
    write pngData to fh
    close access fh
    return "ok"
  `;
  const r = spawnSync("osascript", ["-e", script], {
    timeout: CLIPBOARD_TIMEOUT_MS,
    encoding: "utf-8",
  });
  const out = (r.stdout ?? "").trim();
  return out === "ok" && fileHasBytes(outPath);
}

/** Linux：Wayland wl-paste / X11 xclip，把剪贴板 image/png 写文件。 */
function readClipboardLinux(outPath: string): boolean {
  // Wayland
  if (commandExists("wl-paste")) {
    // 先看剪贴板是否含 image/png 类型，避免把文本当图片写进去。
    const types = spawnSync("wl-paste", ["--list-types"], {
      timeout: CLIPBOARD_TIMEOUT_MS,
      encoding: "utf-8",
    });
    if ((types.stdout ?? "").includes("image/png")) {
      const r = spawnSync("wl-paste", ["--type", "image/png"], {
        timeout: CLIPBOARD_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (r.status === 0 && r.stdout && r.stdout.length > 0) {
        require("node:fs").writeFileSync(outPath, r.stdout);
        return fileHasBytes(outPath);
      }
    }
  }
  // X11
  if (commandExists("xclip")) {
    const r = spawnSync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout && r.stdout.length > 0) {
      require("node:fs").writeFileSync(outPath, r.stdout);
      return fileHasBytes(outPath);
    }
  }
  return false;
}

/** Windows：PowerShell 取剪贴板图片存 PNG。 */
function readClipboardWindows(outPath: string): boolean {
  const ps = `
    Add-Type -AssemblyName System.Windows.Forms;
    $img = [System.Windows.Forms.Clipboard]::GetImage();
    if ($img -ne $null) {
      $img.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);
      Write-Output 'ok';
    } else { Write-Output 'no-image'; }
  `;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
    timeout: CLIPBOARD_TIMEOUT_MS,
    encoding: "utf-8",
  });
  return (r.stdout ?? "").trim().endsWith("ok") && fileHasBytes(outPath);
}

/** 检查命令是否存在（which/where，超时保护）。 */
function commandExists(cmd: string): boolean {
  const probe = platform() === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { timeout: 1000 });
  return r.status === 0;
}

/** 文件存在且非空。 */
function fileHasBytes(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).size > 0;
  } catch {
    return false;
  }
}

/**
 * P2-7：判断一段粘贴文本是否是"单个图片文件路径"（拖放场景）。
 * 是则返回规范化的绝对/原始路径，否则返回 null。
 * 规则：去除首尾空白与可能的成对引号（终端拖放常给带引号路径）；单行；扩展名在 vision 集；
 * 文件真实存在。多路径（拖多个文件，换行/空格分隔）不在此处理（保守，避免误判普通文本）。
 */
export function detectDroppedImagePath(pasteText: string): string | null {
  let s = pasteText.trim();
  if (!s || s.includes("\n")) return null; // 多行不是单文件拖放
  // 去成对引号
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' || a === "'") && a === b) s = s.slice(1, -1);
  }
  // file:// URI（部分终端拖放给 URI）→ 转本地路径
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\//, ""));
    } catch {
      return null;
    }
  }
  const lower = s.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  if (!IMAGE_EXTS.has(ext)) return null;
  if (!fileHasBytes(s)) return null;
  return s;
}

export { IMAGE_EXTS };
