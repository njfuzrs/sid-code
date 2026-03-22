/**
 * Skill 资源目录扫描
 * 用于 activate 模式展示 Skill 附带的资源文件
 */

import { readdirSync, statSync } from "node:fs";
import { join, basename, sep } from "node:path";

/** 最大文件数限制 */
const MAX_FILES = 200;

/** 忽略的目录 */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "__pycache__"]);

/** 资源类型 */
interface ResourceNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ResourceNode[];
}

/**
 * 扫描 Skill 目录，生成资源目录树
 * @param skillDir Skill 目录路径（SKILL.md 所在目录）
 * @returns 格式化的目录树字符串，如果无资源则返回空字符串
 */
export async function scanSkillResources(skillDir: string): Promise<string> {
  try {
    const entries = readdirSync(skillDir, { withFileTypes: true });
    const resources: ResourceNode[] = [];
    let fileCount = 0;

    // 只扫描 scripts/references/assets 三个资源目录
    const resourceDirs = ["scripts", "references", "assets"];

    for (const dirName of resourceDirs) {
      const entry = entries.find(e => e.name === dirName && e.isDirectory());
      if (!entry) continue;

      const dirPath = join(skillDir, dirName);
      const node = scanDirectory(dirPath, dirName, 0);
      if (node) {
        resources.push(node);
        fileCount += countFiles(node);
        if (fileCount >= MAX_FILES) break;
      }
    }

    if (resources.length === 0) {
      return "";
    }

    // 格式化为树形结构
    const lines: string[] = [];
    for (const resource of resources) {
      formatNode(resource, "", true, lines);
    }

    let result = lines.join("\n");
    if (fileCount >= MAX_FILES) {
      result += "\n... (超过 200 个文件，已截断)";
    }

    return result;
  } catch (error) {
    // 目录不存在或无权限，返回空
    return "";
  }
}

/**
 * 递归扫描目录
 */
function scanDirectory(dirPath: string, name: string, depth: number): ResourceNode | null {
  if (depth > 3) return null; // 最大深度限制

  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return null;

    const entries = readdirSync(dirPath, { withFileTypes: true });
    const children: ResourceNode[] = [];

    for (const entry of entries) {
      // 忽略特定目录和 SKILL.md
      if (IGNORED_DIRS.has(entry.name) || entry.name === "SKILL.md") {
        continue;
      }

      const childPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const childNode = scanDirectory(childPath, entry.name, depth + 1);
        if (childNode) {
          children.push(childNode);
        }
      } else if (entry.isFile()) {
        children.push({
          name: entry.name,
          path: childPath,
          isDirectory: false,
        });
      }
    }

    return {
      name,
      path: dirPath,
      isDirectory: true,
      children: children.length > 0 ? children : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 统计节点下的文件数
 */
function countFiles(node: ResourceNode): number {
  if (!node.isDirectory) return 1;
  if (!node.children) return 0;
  return node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

/**
 * 格式化节点为树形字符串
 * 资源类型说明：
 * - scripts/: 可执行脚本，LLM 通过 bash 工具执行
 * - references/: 参考文档，LLM 通过 read 工具按需读取
 * - assets/: 输出资源（模板、图片等），LLM 在生成输出时使用
 */
function formatNode(
  node: ResourceNode,
  indent: string,
  isLast: boolean,
  lines: string[],
): void {
  const connector = isLast ? "└───" : "├───";
  const suffix = node.isDirectory ? sep : "";

  // 为顶级资源目录添加说明
  let description = "";
  if (indent === "" && node.isDirectory) {
    if (node.name === "scripts") {
      description = " (可执行脚本)";
    } else if (node.name === "references") {
      description = " (参考文档)";
    } else if (node.name === "assets") {
      description = " (输出资源)";
    }
  }

  lines.push(`${indent}${connector}${node.name}${suffix}${description}`);

  if (node.children && node.children.length > 0) {
    const childIndent = indent + (isLast ? "    " : "│   ");
    for (let i = 0; i < node.children.length; i++) {
      const isLastChild = i === node.children.length - 1;
      formatNode(node.children[i], childIndent, isLastChild, lines);
    }
  }
}
