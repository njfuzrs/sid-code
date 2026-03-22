/**
 * 轻量 frontmatter 解析器
 * 不引入 gray-matter 依赖，复用项目已有的 yaml 库
 */

import YAML from "yaml";

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * 解析 markdown 文件的 frontmatter
 * 检测 `---\n` 开头，找到第二个 `---\n`，中间部分用 yaml.parse() 解析
 * 解析失败返回空 frontmatter + 完整内容作为 body
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const trimmed = content.trimStart();

  // 必须以 --- 开头（后面紧跟换行或文件结束）
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  // 找第二个 ---
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return { frontmatter: {}, body: content };
  }

  const rest = trimmed.slice(firstNewline + 1);

  // 找闭合的 ---（可能在行首或前面有换行）
  let closingIndex: number;
  let yamlStr: string;
  let body: string;

  if (rest.startsWith("---")) {
    // 空 frontmatter：紧跟着就是闭合标记
    yamlStr = "";
    body = rest.slice(3).replace(/^\n/, "");
  } else {
    closingIndex = rest.indexOf("\n---");
    if (closingIndex === -1) {
      return { frontmatter: {}, body: content };
    }
    yamlStr = rest.slice(0, closingIndex);
    body = rest.slice(closingIndex + 4).replace(/^\n/, "");
  }

  try {
    const parsed = YAML.parse(yamlStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed, body };
    }
    // YAML 为空或非对象，frontmatter 为空但 body 仍取正文部分
    return { frontmatter: {}, body };
  } catch (error) {
    // YAML 解析失败，回退到简单 key-value 解析
    const simpleFrontmatter = parseSimpleFrontmatter(yamlStr);
    if (simpleFrontmatter && Object.keys(simpleFrontmatter).length > 0) {
      return { frontmatter: simpleFrontmatter, body };
    }
    // 简单解析也失败，返回完整内容作为 body
    return { frontmatter: {}, body: content };
  }
}

/**
 * 简单 frontmatter 解析器（YAML 解析失败时的回退方案）
 * 支持 key: value 格式，支持多行 description（缩进续行）
 */
function parseSimpleFrontmatter(content: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 匹配 "key: value" 格式（key 可以包含字母、数字、连字符、下划线）
    const match = line.match(/^\s*([\w-]+):\s*(.*)$/);
    if (match) {
      const [, key, firstLine] = match;
      const valueLines = [firstLine.trim()];

      // 检查缩进续行（多行值）
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        // 如果下一行以空格或制表符开头且不为空，则为续行
        if (nextLine.match(/^[ \t]+\S/)) {
          valueLines.push(nextLine.trim());
          i++;
        } else {
          break;
        }
      }

      // 合并多行值，过滤空行
      result[key] = valueLines.filter(Boolean).join(" ");
    }
  }

  if (Object.keys(result).length > 0) {
    return result;
  }
  return null;
}
