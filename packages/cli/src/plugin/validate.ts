/**
 * 插件 Manifest 验证
 *
 * 不依赖 Zod，使用轻量级手动验证（与 config/schema.ts 风格一致）。
 */

/** 插件名 slug 规则（name 与 dependencies 元素共用同一口径） */
const PLUGIN_NAME_SLUG = /^[a-z0-9][a-z0-9-_]*$/;

/** semver 规则：主.次.修订，可选预发布与构建元数据 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Manifest 验证结果 */
export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 验证 plugin.json 的内容
 * @param manifest 解析后的 JSON（unknown，需做运行时类型检查）
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["plugin.json 必须是 JSON 对象"] };
  }

  const m = manifest as Record<string, unknown>;

  // 必填字段：name
  if (!m.name || typeof m.name !== "string") {
    errors.push("name 字段必填且必须是字符串");
  } else {
    if (!PLUGIN_NAME_SLUG.test(m.name)) {
      errors.push("name 必须是 slug 格式（小写字母、数字、-、_，且以字母或数字开头）");
    }
    if (m.name.length > 64) {
      errors.push("name 不能超过 64 个字符");
    }
  }

  // 必填字段：version（types.ts 约定为 semver 格式）
  if (!m.version || typeof m.version !== "string") {
    errors.push("version 字段必填且必须是字符串");
  } else if (!SEMVER.test(m.version)) {
    errors.push("version 必须是 semver 格式（如 1.0.0）");
  }

  // 必填字段：description
  if (!m.description || typeof m.description !== "string") {
    errors.push("description 字段必填且必须是字符串");
  }

  // 可选字段类型检查
  if (m.author !== undefined && typeof m.author !== "string") {
    errors.push("author 必须是字符串");
  }

  if (m.license !== undefined && typeof m.license !== "string") {
    errors.push("license 必须是字符串");
  }

  if (m.commands !== undefined) {
    if (typeof m.commands !== "string" && !Array.isArray(m.commands)) {
      errors.push("commands 必须是字符串或字符串数组");
    }
  }

  if (m.skills !== undefined) {
    if (typeof m.skills !== "string" && !Array.isArray(m.skills)) {
      errors.push("skills 必须是字符串或字符串数组");
    }
  }

  if (m.agents !== undefined) {
    if (typeof m.agents !== "string" && !Array.isArray(m.agents)) {
      errors.push("agents 必须是字符串或字符串数组");
    }
  }

  if (m.hooks !== undefined && typeof m.hooks !== "string") {
    errors.push("hooks 必须是字符串（hooks.json 的路径）");
  }

  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies)) {
      errors.push("dependencies 必须是字符串数组");
    } else {
      for (const dep of m.dependencies) {
        if (typeof dep !== "string") {
          errors.push(`dependencies 中的每个元素必须是字符串，发现: ${typeof dep}`);
        } else if (!PLUGIN_NAME_SLUG.test(dep)) {
          errors.push(`dependencies 中的 "${dep}" 不是合法插件名（slug 格式）`);
        }
      }
    }
  }

  if (m.mcpServers !== undefined) {
    if (typeof m.mcpServers !== "string" && typeof m.mcpServers !== "object") {
      errors.push("mcpServers 必须是字符串（文件路径）或对象");
    }
  }

  return { valid: errors.length === 0, errors };
}
