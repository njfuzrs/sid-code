/**
 * G12: outputStyles — 用户可插拔输出风格
 *
 * 对标 claude-code outputStyles：用户在 .sid-code/output-styles/ 或
 * ~/.sid-code/output-styles/ 放置 .md 文件，每个文件即一个"输出风格"——
 * 内容直接作为系统提示词注入（告诉模型"按什么风格输出"）。
 *
 * 文件结构：
 *   ---
 *   name: concise
 *   description: 简洁风格，每次回复不超过 3 句话
 *   ---
 *   你是一个极简风格的助手。
 *   - 每次回复不超过 3 句话
 *   - 不要使用 markdown 标题
 *   - 用短句
 *
 * 选择方式：
 *   settings.json → outputStyle: "concise"（匹配 name 字段）
 *   或 CLI --output-style concise
 *
 * 加载优先级：项目级 > 用户级（同名时项目覆盖全局）。
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { getLogger } from "../debug/logger.ts";

export interface OutputStyleDef {
  /** 风格名（frontmatter name 字段，或不带扩展名的文件名） */
  name: string;
  /** 一句话描述（frontmatter description 字段） */
  description: string;
  /** 风格正文（注入系统提示词） */
  content: string;
  /** 来源路径 */
  sourcePath: string;
}

/**
 * 解析 frontmatter（简版：只提取 name/description，忽略其余 YAML 字段）。
 * 约定：文件以 `---\n` 开头、以 `\n---\n` 结束 frontmatter 块。
 */
function parseFrontmatter(raw: string, filePath: string): OutputStyleDef {
  const defaultName = basename(filePath, ".md");
  let name = defaultName;
  let description = "";
  let content = raw;

  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const frontmatter = raw.slice(4, endIdx); // 跳过首行 "---\n"
      content = raw.slice(endIdx + 4).trim(); // 跳过闭合 "---\n"

      for (const line of frontmatter.split("\n")) {
        const nameMatch = line.match(/^name:\s*(.+)/);
        if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        const descMatch = line.match(/^description:\s*(.+)/);
        if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  return { name, description, content, sourcePath: filePath };
}

/**
 * 从指定目录加载所有 .md 风格文件。
 */
function loadStylesFromDir(dir: string): OutputStyleDef[] {
  if (!existsSync(dir)) return [];
  const log = getLogger();
  const styles: OutputStyleDef[] = [];

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const raw = readFileSync(filePath, "utf-8");
        styles.push(parseFrontmatter(raw, filePath));
      } catch (err) {
        log.debug("OUTPUT_STYLE", `读取失败: ${filePath}: ${err}`);
      }
    }
  } catch (err) {
    log.debug("OUTPUT_STYLE", `扫描目录失败: ${dir}: ${err}`);
  }

  return styles;
}

/**
 * 加载全部可用的输出风格（项目级 > 全局级，同名项目级覆盖）。
 */
export function loadAllOutputStyles(): OutputStyleDef[] {
  const globalDir = join(homedir(), ".sid-code", "output-styles");
  const projectDir = join(process.cwd(), ".sid-code", "output-styles");

  const globalStyles = loadStylesFromDir(globalDir);
  const projectStyles = loadStylesFromDir(projectDir);

  // 项目级覆盖全局级（同 name 去重）
  const merged = new Map<string, OutputStyleDef>();
  for (const s of globalStyles) merged.set(s.name, s);
  for (const s of projectStyles) merged.set(s.name, s); // 覆盖

  return Array.from(merged.values());
}

/**
 * 根据名称查找并返回匹配的风格定义。
 */
export function resolveOutputStyle(styleName: string | undefined): OutputStyleDef | null {
  if (!styleName) return null;
  const all = loadAllOutputStyles();
  return all.find((s) => s.name === styleName) ?? null;
}

/**
 * 获取当前激活的输出风格内容（用于注入系统提示词）。
 * 返回 null 表示未配置或未找到匹配风格。
 */
export function getActiveOutputStyleContent(styleName: string | undefined): string | null {
  const style = resolveOutputStyle(styleName);
  if (!style || !style.content.trim()) return null;

  const log = getLogger();
  log.info("OUTPUT_STYLE", `激活输出风格: "${style.name}" (来源: ${style.sourcePath})`);

  // 包裹标签，让模型明确知道这是输出风格约束
  return `<output-style name="${style.name}">\n${style.content}\n</output-style>`;
}
