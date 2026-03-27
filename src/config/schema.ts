/**
 * 配置验证模块
 * 提供轻量级的配置验证，不依赖 Zod 等重型库
 */

import type { Config } from "./config.ts";

/** 验证错误 */
export interface ValidationError {
  path: string;      // 如 "provider" 或 "mcpServers.fetch.timeout"
  message: string;
  value: unknown;
}

/** 验证警告 */
export interface ValidationWarning {
  path: string;
  message: string;
}

/** 验证结果 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/** 有效的 provider 值 */
const VALID_PROVIDERS = new Set(["anthropic", "openai", "ollama"]);

/** 有效的权限模式 */
const VALID_PERMISSION_MODES = new Set([
  "default",
  "always-allow",
  "deny-write",
  "acceptEdits",
  "plan",
  "dontAsk",
  "dangerously-skip-permissions",
]);

/** 有效的 Hook 事件名 */
const VALID_HOOK_EVENTS = new Set([
  "pre_tool_use",
  "post_tool_use",
  "post_tool_use_failure",
  "user_prompt_submit",
  "session_start",
  "session_end",
  "pre_compact",
  "subagent_stop",
  "permission_request",
  "notification",
]);

/** 有效的子代理类型 */
const VALID_SUBAGENT_TYPES = new Set([
  "explore",
  "task",
  "plan",
  "summarize",
]);

/** 有效的 MCP 传输类型 */
const VALID_MCP_TRANSPORTS = new Set(["stdio", "http", "sse"]);

/** 明显的占位符 API Key */
const PLACEHOLDER_PATTERNS = [
  /your[_-]?api[_-]?key/i,
  /replace[_-]?me/i,
  /example/i,
  /test[_-]?key/i,
  /dummy/i,
  /placeholder/i,
  /xxx+/i,
];

/**
 * 验证配置对象
 */
export function validateConfig(config: Config): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // 验证 provider
  if (!VALID_PROVIDERS.has(config.provider)) {
    errors.push({
      path: "provider",
      message: `无效值 "${config.provider}"，有效值为 ${Array.from(VALID_PROVIDERS).join("/")}`,
      value: config.provider,
    });
  }

  // 验证 model
  if (!config.model || typeof config.model !== "string" || config.model.trim() === "") {
    errors.push({
      path: "model",
      message: "模型名称不能为空",
      value: config.model,
    });
  }

  // 验证 maxTokens
  if (typeof config.maxTokens !== "number") {
    errors.push({
      path: "maxTokens",
      message: "必须是数字",
      value: config.maxTokens,
    });
  } else if (config.maxTokens < 1000) {
    errors.push({
      path: "maxTokens",
      message: `值 ${config.maxTokens} 低于最小值 1000`,
      value: config.maxTokens,
    });
  } else if (config.maxTokens > 200000) {
    warnings.push({
      path: "maxTokens",
      message: `值 ${config.maxTokens} 超过推荐最大值 200000`,
    });
  }

  // 验证 permissionMode
  if (!VALID_PERMISSION_MODES.has(config.permissionMode)) {
    errors.push({
      path: "permissionMode",
      message: `无效值 "${config.permissionMode}"，有效值为 ${Array.from(VALID_PERMISSION_MODES).join("/")}`,
      value: config.permissionMode,
    });
  }

  // 验证 API Keys（基础检查）
  if (config.provider === "anthropic") {
    validateApiKey("anthropicKey", config.anthropicKey, errors, warnings);
  } else if (config.provider === "openai") {
    validateApiKey("openaiKey", config.openaiKey, errors, warnings);
  }

  // 验证 mcpServers
  if (config.mcpServers && typeof config.mcpServers === "object") {
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      const prefix = `mcpServers.${serverName}`;

      if (!serverConfig.transport || !VALID_MCP_TRANSPORTS.has(serverConfig.transport)) {
        errors.push({
          path: `${prefix}.transport`,
          message: `无效值 "${serverConfig.transport}"，有效值为 ${Array.from(VALID_MCP_TRANSPORTS).join("/")}`,
          value: serverConfig.transport,
        });
      }

      // stdio 类型必须有 command
      if (serverConfig.transport === "stdio" && !serverConfig.command) {
        errors.push({
          path: `${prefix}.command`,
          message: "stdio 类型的 MCP 服务器必须指定 command",
          value: serverConfig.command,
        });
      }

      // http/sse 类型必须有 url
      if ((serverConfig.transport === "http" || serverConfig.transport === "sse") && !serverConfig.url) {
        errors.push({
          path: `${prefix}.url`,
          message: `${serverConfig.transport} 类型的 MCP 服务器必须指定 url`,
          value: serverConfig.url,
        });
      }

      // 验证 timeout
      if (serverConfig.timeout !== undefined) {
        if (typeof serverConfig.timeout !== "number" || serverConfig.timeout <= 0) {
          errors.push({
            path: `${prefix}.timeout`,
            message: "timeout 必须是正整数",
            value: serverConfig.timeout,
          });
        }
      }

      // 验证 retries
      if (serverConfig.retries !== undefined) {
        if (typeof serverConfig.retries !== "number" || serverConfig.retries < 0) {
          errors.push({
            path: `${prefix}.retries`,
            message: "retries 必须是非负整数",
            value: serverConfig.retries,
          });
        }
      }
    }
  }

  // 验证 hooks
  if (config.hooks && typeof config.hooks === "object") {
    for (const [eventName, hookList] of Object.entries(config.hooks)) {
      if (!VALID_HOOK_EVENTS.has(eventName)) {
        warnings.push({
          path: `hooks.${eventName}`,
          message: `未知的事件名 "${eventName}"，有效值为 ${Array.from(VALID_HOOK_EVENTS).join(", ")}`,
        });
      }

      if (!Array.isArray(hookList)) {
        errors.push({
          path: `hooks.${eventName}`,
          message: "Hook 配置必须是数组",
          value: hookList,
        });
        continue;
      }

      hookList.forEach((hook, index) => {
        const prefix = `hooks.${eventName}[${index}]`;

        // 验证 type
        if (hook.type && hook.type !== "command" && hook.type !== "url") {
          errors.push({
            path: `${prefix}.type`,
            message: `无效值 "${hook.type}"，有效值为 command/url`,
            value: hook.type,
          });
        }

        // command 类型必须有 command 字段
        const hookType = hook.type || "command";
        if (hookType === "command" && !hook.command) {
          errors.push({
            path: `${prefix}.command`,
            message: "command 类型的 Hook 必须指定 command 字段",
            value: hook.command,
          });
        }

        // url 类型必须有 url 字段
        if (hookType === "url" && !hook.url) {
          errors.push({
            path: `${prefix}.url`,
            message: "url 类型的 Hook 必须指定 url 字段",
            value: hook.url,
          });
        }

        // 验证 timeout
        if (hook.timeout !== undefined) {
          if (typeof hook.timeout !== "number" || hook.timeout <= 0) {
            errors.push({
              path: `${prefix}.timeout`,
              message: "timeout 必须是正数",
              value: hook.timeout,
            });
          }
        }
      });
    }
  }

  // 验证 subAgentModels
  if (config.subAgentModels && typeof config.subAgentModels === "object") {
    for (const [agentType, modelName] of Object.entries(config.subAgentModels)) {
      if (!VALID_SUBAGENT_TYPES.has(agentType)) {
        warnings.push({
          path: `subAgentModels.${agentType}`,
          message: `未知的子代理类型 "${agentType}"，有效值为 ${Array.from(VALID_SUBAGENT_TYPES).join(", ")}`,
        });
      }

      if (typeof modelName !== "string" || modelName.trim() === "") {
        errors.push({
          path: `subAgentModels.${agentType}`,
          message: "模型名称不能为空",
          value: modelName,
        });
      }
    }
  }

  // 验证 availableModels
  if (config.availableModels && Array.isArray(config.availableModels)) {
    config.availableModels.forEach((model, index) => {
      const prefix = `availableModels[${index}]`;

      if (!model.name || typeof model.name !== "string" || model.name.trim() === "") {
        errors.push({
          path: `${prefix}.name`,
          message: "模型名称不能为空",
          value: model.name,
        });
      }

      if (model.provider && !VALID_PROVIDERS.has(model.provider)) {
        errors.push({
          path: `${prefix}.provider`,
          message: `无效值 "${model.provider}"，有效值为 ${Array.from(VALID_PROVIDERS).join("/")}`,
          value: model.provider,
        });
      }

      if (model.contextWindow !== undefined) {
        if (typeof model.contextWindow !== "number" || model.contextWindow <= 0) {
          errors.push({
            path: `${prefix}.contextWindow`,
            message: "contextWindow 必须是正整数",
            value: model.contextWindow,
          });
        }
      }

      if (model.maxOutputTokens !== undefined) {
        if (typeof model.maxOutputTokens !== "number" || model.maxOutputTokens <= 0) {
          errors.push({
            path: `${prefix}.maxOutputTokens`,
            message: "maxOutputTokens 必须是正整数",
            value: model.maxOutputTokens,
          });
        }
      }
    });
  }

  // 验证 costLimit
  if (config.costLimit !== undefined) {
    if (typeof config.costLimit !== "number" || config.costLimit <= 0) {
      errors.push({
        path: "costLimit",
        message: "costLimit 必须是正数",
        value: config.costLimit,
      });
    }
  }

  // 验证 checkpoint 配置
  if (config.checkpoint) {
    const cp = config.checkpoint;
    const prefix = "checkpoint";

    if (cp.maxCheckpointsPerFile !== undefined) {
      if (typeof cp.maxCheckpointsPerFile !== "number" || cp.maxCheckpointsPerFile <= 0) {
        errors.push({
          path: `${prefix}.maxCheckpointsPerFile`,
          message: "必须是正整数",
          value: cp.maxCheckpointsPerFile,
        });
      }
    }

    if (cp.maxTotalSizeMb !== undefined) {
      if (typeof cp.maxTotalSizeMb !== "number" || cp.maxTotalSizeMb <= 0) {
        errors.push({
          path: `${prefix}.maxTotalSizeMb`,
          message: "必须是正数",
          value: cp.maxTotalSizeMb,
        });
      }
    }

    if (cp.maxAgeDays !== undefined) {
      if (typeof cp.maxAgeDays !== "number" || cp.maxAgeDays <= 0) {
        errors.push({
          path: `${prefix}.maxAgeDays`,
          message: "必须是正数",
          value: cp.maxAgeDays,
        });
      }
    }

    if (cp.compressThresholdKb !== undefined) {
      if (typeof cp.compressThresholdKb !== "number" || cp.compressThresholdKb < 0) {
        errors.push({
          path: `${prefix}.compressThresholdKb`,
          message: "必须是非负数",
          value: cp.compressThresholdKb,
        });
      }
    }

    if (cp.largeFileThresholdLines !== undefined) {
      if (typeof cp.largeFileThresholdLines !== "number" || cp.largeFileThresholdLines <= 0) {
        errors.push({
          path: `${prefix}.largeFileThresholdLines`,
          message: "必须是正整数",
          value: cp.largeFileThresholdLines,
        });
      }
    }

    if (cp.hugeFileThresholdLines !== undefined) {
      if (typeof cp.hugeFileThresholdLines !== "number" || cp.hugeFileThresholdLines <= 0) {
        errors.push({
          path: `${prefix}.hugeFileThresholdLines`,
          message: "必须是正整数",
          value: cp.hugeFileThresholdLines,
        });
      }
    }
  }

  // 验证 trace 配置
  if (config.trace) {
    if (config.trace.enabled && config.trace.upload) {
      const upload = config.trace.upload;
      if (!upload.url) {
        errors.push({
          path: "trace.upload.url",
          message: "上传 URL 不能为空",
          value: upload.url,
        });
      }
      if (!upload.token) {
        errors.push({
          path: "trace.upload.token",
          message: "上传 token 不能为空",
          value: upload.token,
        });
      }
      if (upload.url && !upload.url.startsWith("http")) {
        warnings.push({
          path: "trace.upload.url",
          message: "URL 应以 http:// 或 https:// 开头",
        });
      }
      if (upload.maxRetries !== undefined && (upload.maxRetries < 1 || upload.maxRetries > 20)) {
        warnings.push({
          path: "trace.upload.maxRetries",
          message: "建议重试次数在 1-20 之间",
        });
      }
    }
    if (config.trace.maxSessionsRetained !== undefined) {
      if (typeof config.trace.maxSessionsRetained !== "number" || config.trace.maxSessionsRetained <= 0) {
        errors.push({
          path: "trace.maxSessionsRetained",
          message: "必须是正整数",
          value: config.trace.maxSessionsRetained,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 验证 API Key
 */
function validateApiKey(
  path: string,
  key: string,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): void {
  if (!key || key.trim() === "") {
    warnings.push({
      path,
      message: "API Key 未设置，可能导致认证失败",
    });
    return;
  }

  // 检查是否是明显的占位符
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(key)) {
      warnings.push({
        path,
        message: `API Key 看起来像占位符 ("${key}")，请替换为真实的 Key`,
      });
      return;
    }
  }

  // 长度检查（大多数 API Key 至少 20 字符）
  if (key.length < 20) {
    warnings.push({
      path,
      message: `API Key 长度过短 (${key.length} 字符)，可能无效`,
    });
  }
}
