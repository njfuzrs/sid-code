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
  } catch {
    // YAML 解析失败，返回完整内容作为 body
    return { frontmatter: {}, body: content };
  }
}
