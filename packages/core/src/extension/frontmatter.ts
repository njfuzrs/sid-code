/**
 * 轻量 frontmatter 解析器
 * 不引入 gray-matter 依赖，复用项目已有的 yaml 库
 */

import YAML from "yaml";

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
  /**
   * 审计第 4 条：**畸形** frontmatter 的错误说明（正常解析 / 本来就没有 frontmatter 时为 undefined）。
   *
   * 关键区分：「文件不以 `---` 开头」= 用户本就没写 frontmatter，是合法的，`error` 为空；
   * 「以 `---` 开头但找不到闭合 / YAML 完全解析不出来」= 用户**意图**写 frontmatter 但写错了，
   * 此时旧实现把原始 YAML 当正文返回，造成两个后果：
   *   ① `allowed-tools` / `model` 等安全约束随解析失败一起消失，且降级方向**更宽松**
   *      （自定义命令从"fork 子代理受限执行"退化成"inline 注入主对话、无工具限制"）；
   *   ② 原始 YAML 文本被当自然语言指令喂给模型。
   * 两者都是静默的。消费方**必须**检查此字段并 fail-closed（跳过该文件），
   * 不能把"用户的笔误"解释成"另一种合法语义"。
   */
  error?: string;
}

/**
 * 解析 markdown 文件的 frontmatter
 * 检测 `---\n` 开头，找到第二个 `---\n`，中间部分用 yaml.parse() 解析
 *
 * 返回的 `error` 非空表示 frontmatter 畸形（详见 `FrontmatterResult.error`）——
 * 消费方须据此跳过该文件，而不是当作"无 frontmatter"继续加载。
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const trimmed = content.trimStart();

  // 必须以 --- 开头（后面紧跟换行或文件结束）。不以 --- 开头 = 合法的"无 frontmatter"，非错误。
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  // 找第二个 ---
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    // 整个文件只有一行 `---`：以 --- 开头却没有闭合，属畸形
    return { frontmatter: {}, body: content, error: "frontmatter 以 `---` 开头但缺少闭合分隔符" };
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
      // 最常见的笔误形态：少写一行 `---`、写成 `--`、或闭合行末无换行
      return {
        frontmatter: {},
        body: content,
        error: "frontmatter 以 `---` 开头但缺少闭合分隔符",
      };
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
    // 简单解析也失败：分隔符齐全但里面完全不是 key-value，同属畸形——
    // 原始 YAML 会被当正文喂给模型，且约束全丢。
    return {
      frontmatter: {},
      body: content,
      error: `frontmatter YAML 解析失败: ${(error as Error)?.message ?? String(error)}`,
    };
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
