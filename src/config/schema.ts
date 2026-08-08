/**
 * 配置验证模块
 * 提供轻量级的配置验证，不依赖 Zod 等重型库
 */

import type { Config } from "./config.ts";
import { getActiveAgentTypes } from "../agent/agent-definition.ts";
import { normalizeBaseURL } from "../llm/endpoint-key.ts";
// VALID_HOOK_EVENTS 从这两个事实源派生，见其定义处的注释（手写清单会漂移出假告警）。
import { HookEventName, LEGACY_EVENT_MAP } from "../hook/types.ts";

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

/**
 * 有效的 provider 值。
 *
 * ⚠️ 新增值必须同步 `src/llm/registry.ts` 的 `createProvider()` 分派——**少改一处的两个
 * 方向都是静默故障**：这里放开而 registry 不认 → 启动后抛「未知的 Provider」；
 * registry 认而这里不放开 → 配置校验阶段就被拦死，registry 的分支永远走不到。
 *
 * 后者刚刚真实发生过（2026-08-08）：`replay` 在 registry 里接好了、31 个单测全绿，
 * 但跑真实 CLI 直接报「无效值 "replay"」——因为单测是自己 new ProviderRegistry，
 * **绕过了配置校验层**。这与本仓库缺陷清单 P0-3（OtlpExporter 写完但配置层不可达）
 * 是同一个形态，也是「光看测试全绿不等于功能可用」的又一个实例。
 *
 * `replay`（缺陷清单 P2-11 录制回放）不发任何网络请求，只读本地 raw.jsonl 重放，
 * 因此不需要 apiKey / baseURL 校验。
 */
const VALID_PROVIDERS = new Set(["anthropic", "openai", "ollama", "replay"]);

/** 有效的权限模式
 *  - "manual"：CC 别名，等价 "default"（在 config.ts 归一层映射为 default）
 *  - "auto"：分类器自动裁决模式，可经 --permission-mode auto 显式进入（需分类器可用） */
const VALID_PERMISSION_MODES = new Set([
  "default",
  "manual",
  "always-allow",
  "deny-write",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
  "dangerously-skip-permissions",
]);

/**
 * 有效的 Hook 事件名：**从 hook 层的事实源派生**，不再手写清单。
 *
 * 为什么必须派生：这里曾是一份手写的 12 条 snake_case 清单，而 registry 真正认的是
 * `HookEventName` 枚举（37 个成员）+ `LEGACY_EVENT_MAP`（25 条 snake_case 别名）两者的并集
 * ——`resolveEventName()` 对两种写法都返回有效事件。两边一漂移就产生**假告警**：
 * 用户按 `ref/hooks.md`（从枚举生成的权威参考页）写 `"PreToolUse"`，hook 实际能正常触发，
 * 却会收到一条 `未知的事件名 "PreToolUse"` 的警告，然后去怀疑自己配错了。
 * 反过来，枚举里新增事件时也不会有人记得回来同步这份清单。
 *
 * 校验的语义是「这个名字 registry 认不认」，而 registry 认什么由 hook 层定义，
 * 所以这里唯一正确的做法是引用它，而不是抄它。
 *
 * 注意：能通过校验 ≠ 该事件有调用点会触发。枚举里有一批标注「预留：有 fire 方法但无调用点」
 * 的事件，配了不会被触发——那是 `ref/hooks.md` 的「会不会触发」列要回答的问题，
 * 与本校验（名字合不合法）是两个独立维度，别混为一谈。
 */
const VALID_HOOK_EVENTS = new Set<string>([
  ...Object.values(HookEventName),
  ...Object.keys(LEGACY_EVENT_MAP),
]);

/** 有效的子代理类型：从活跃 agent registry 派生（含 built-in + custom + plugin）。
 *  额外允许 "default"：subAgentModels 的兜底键，作用于所有未单独指定的类型。
 *  改为函数：动态 agent 在启动后期才注册，模块级常量求值太早拿不到。 */
function getValidSubagentTypes(): Set<string> {
  return new Set<string>(["default", ...getActiveAgentTypes()]);
}

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
    let message = `无效值 "${config.provider}"，有效值为 ${Array.from(VALID_PROVIDERS).join("/")}`;
    // provider 由 resolveCurrentModelConfig 按 config.model === availableModels[].name 匹配回填，
    // 从不由用户直接填写。所以 provider 为空的最常见诱因不是"值本身填错"，而是重命名/改错了
    // availableModels 条目的 name 后，忘记同步顶层 model（或 fallbackModel/subAgentModels）里的旧引用，
    // 导致按名查找落空、从未回填。这里补一句定位提示，避免误诊为 provider 校验规则本身有问题。
    if (config.model && config.availableModels?.length) {
      const found = config.availableModels.some(m => m.name === config.model);
      if (!found) {
        const available = config.availableModels.map(m => m.name).join(", ");
        message += `；模型 "${config.model}" 未在 availableModels 中找到（可用: ${available}）。` +
          `如果重命名过 availableModels 条目，请同步更新顶层 model / fallbackModel / subAgentModels 中的引用`;
      }
    }
    errors.push({
      path: "provider",
      message,
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

  // 验证 maxTokens（单次输出上限，非上下文窗口）
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
  } else {
    // 阈值取当前模型自己声明的上下文窗口，而不是硬编码 200000。
    // 输出上限唯一真正不合理的情形是"超过模型上下文窗口"（物理上不可能输出比窗口还多）。
    // 拿不到模型窗口时不告警 —— maxTokens 多由系统按模型 max_output_tokens 自动推导，
    // 用一个无关的硬编码数去警告系统自己的正确推导，只会制造首屏噪音。
    const currentModel = config.availableModels?.find(m => m.name === config.model);
    const ctxWindow = currentModel?.contextWindow;
    if (typeof ctxWindow === "number" && ctxWindow > 0 && config.maxTokens > ctxWindow) {
      warnings.push({
        path: "maxTokens",
        message: `输出上限 ${config.maxTokens} 超过模型 "${config.model}" 的上下文窗口 ${ctxWindow}`,
      });
    }
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

        // 验证 type（G5：新增 prompt/agent 两种 LLM 层 hook）
        const VALID_HOOK_TYPES = ["command", "url", "prompt", "agent"];
        if (hook.type && !VALID_HOOK_TYPES.includes(hook.type)) {
          errors.push({
            path: `${prefix}.type`,
            message: `无效值 "${hook.type}"，有效值为 ${VALID_HOOK_TYPES.join("/")}`,
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

        // prompt / agent 类型必须有 prompt 字段
        if ((hookType === "prompt" || hookType === "agent") && !hook.prompt) {
          errors.push({
            path: `${prefix}.prompt`,
            message: `${hookType} 类型的 Hook 必须指定 prompt 字段`,
            value: hook.prompt,
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
    const validSubagentTypes = getValidSubagentTypes();
    for (const [agentType, modelName] of Object.entries(config.subAgentModels)) {
      if (!validSubagentTypes.has(agentType)) {
        warnings.push({
          path: `subAgentModels.${agentType}`,
          message: `未知的子代理类型 "${agentType}"，有效值为 ${Array.from(validSubagentTypes).join(", ")}`,
        });
      }

      if (typeof modelName !== "string" || modelName.trim() === "") {
        errors.push({
          path: `subAgentModels.${agentType}`,
          message: "模型名称不能为空",
          value: modelName,
        });
      } else if (config.availableModels?.length && !config.availableModels.some(m => m.name === modelName)) {
        // 非致命：registry.getSpawnConfigForSubAgent 找不到时会静默退回主 provider 配置，
        // 但仍把这个不存在的模型名发给网关，多半在运行时才报"模型不可用"，难定位。
        // 提前告警，指向最可能的诱因（重命名 availableModels 条目后忘记同步这里）。
        warnings.push({
          path: `subAgentModels.${agentType}`,
          message: `模型 "${modelName}" 未在 availableModels 中找到，运行时会退回主 provider 配置但仍使用该模型名请求网关，可能导致"模型不可用"报错。如果重命名过 availableModels 条目，请同步更新这里的引用`,
        });
      }
    }
  }

  // 验证模型引用类字段：fallbackModel / classifierModel / goal.evaluatorModel 均应
  // 能在 availableModels 中找到，否则运行时会静默退回主 provider 但仍携带该模型名请求
  // 网关，消费点分别是 app.ts（fallback）/ cli.ts（classifier）/ query/loop.ts（goal 评估）。
  // 不加任何功能开关前置条件（如 enableLLMClassifier）——尽早暴露配置漂移，好过等真正
  // 启用功能那一刻才发现模型名早已失效，体验上和静默没有本质区别。
  const modelRefFields: Array<{ path: string; value: string | undefined; hint: string }> = [
    { path: "fallbackModel", value: config.fallbackModel, hint: "降级功能不会生效（app.ts 静默忽略）" },
    { path: "classifierModel", value: config.classifierModel, hint: "启用 enableLLMClassifier 后会携带此模型名请求网关" },
    { path: "goal.evaluatorModel", value: config.goal?.evaluatorModel, hint: "/goal 评估会携带此模型名请求网关" },
  ];
  for (const ref of modelRefFields) {
    if (ref.value && ref.value.trim() !== "" &&
        config.availableModels?.length && !config.availableModels.some(m => m.name === ref.value)) {
      warnings.push({
        path: ref.path,
        message: `模型 "${ref.value}" 未在 availableModels 中找到，${ref.hint}，可能导致"模型不可用"报错。如果重命名过 availableModels 条目，请同步更新这里的引用`,
      });
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

  // availableModels 重复检查：判重键 = (name + 归一化端点)。
  // 「同名 + 同端点」= 纯冗余（resolveCurrentModelConfig 的 find 只命中第一条，其余配置永不生效）。
  // 「同名 + 不同端点」= 用户想配双渠道但配法不对（第二条无法通过任何 UI 选中），需引导到
  //   「不同 name + 相同 modelId」的正确写法，见下方第二块与 llm/wire-model.ts。
  if (config.availableModels?.length) {
    const keyCount = new Map<string, { name: string; count: number }>();
    for (const m of config.availableModels) {
      if (!m.name) continue;
      const key = `${m.name}\x00${normalizeBaseURL(m.baseURL)}`;
      const prev = keyCount.get(key);
      if (prev) prev.count++;
      else keyCount.set(key, { name: m.name, count: 1 });
    }
    for (const { name, count } of keyCount.values()) {
      if (count > 1) {
        warnings.push({
          path: "availableModels",
          message: `模型 "${name}" 在同一端点下重复出现 ${count} 次，按名查找只命中第一条，其余同名同端点条目的配置永远不会被使用（同名不同端点见下条告警）`,
        });
      }
    }

    // 「同名 + 不同端点」：计价侧确实按 (model, endpoint) 复合键区分（resolvePricing），
    // 但**选择侧全是按名 find-first**——resolveCurrentModelConfig(config.ts)、`/model <name>`
    // 校验、fallback / 子代理 provider 解析，全都只认名字。于是第二条永远切不过去，
    // 它自带的 base_url / api_key 是死配置（用户以为配了双渠道，实际只有第一条生效）。
    // 这不是"合法多渠道"，而是**无法通过任何 UI 或命令选中**的配置，必须告警。
    //
    // ⚠ 建议文案必须同时给出 modelId，否则用户照做会撞下一个坑：`name` 既是本地查找键、
    // 又被直接当作请求体的 model 字段发给厂商，光改名 → 厂商收到 "xxx-gateway" → 400/404。
    // 正确配法是「不同 name（本地唯一，可被选中）+ 相同 modelId（厂商真名，发到线上）」，
    // 解析入口见 llm/wire-model.ts。此前只建议改名，是**不完整的建议**，已修正。
    const byName = new Map<string, Set<string>>();
    for (const m of config.availableModels) {
      if (!m.name) continue;
      const ep = normalizeBaseURL(m.baseURL);
      const set = byName.get(m.name) ?? new Set<string>();
      set.add(ep);
      byName.set(m.name, set);
    }
    for (const [name, endpoints] of byName) {
      if (endpoints.size > 1) {
        warnings.push({
          path: "availableModels",
          message: `模型 "${name}" 配了 ${endpoints.size} 个不同端点，但模型选择（/model、fallback、子代理）一律按名匹配第一条，` +
            `其余端点条目及其 base_url / api_key 永远不会生效。正确配法：给每条取**不同的 name**（如 ` +
            `${name}-gateway / ${name}-official）让两条都能被选中，再各自加 "model_id": "${name}" ` +
            `指回厂商真实模型名——只改 name 不加 model_id 会把别名当模型名发给厂商，导致请求报错`,
        });
      }
    }

    // model_id 自检。注意取值一律先判类型再 trim：settings.json 是用户手写的，
    // `"model_id": 123` 完全可能出现，而 Zod 的 .passthrough() 不校验 snake_case 原始键
    // （归一化在它之后），脏值能一路到这里。直接 .trim() 会抛 TypeError，而本函数在
    // loadConfig 链上 —— 抛出即整个进程起不来。故就地容错 + 出可读告警。
    for (const m of config.availableModels) {
      const rawWire: unknown = (m as { modelId?: unknown }).modelId;
      const alias = typeof m.name === "string" ? m.name.trim() : "";

      // ① 类型错：明确告知该字段被忽略（否则用户以为配了却毫无效果，还找不到原因）
      if (rawWire !== undefined && typeof rawWire !== "string") {
        warnings.push({
          path: "availableModels",
          message: `模型 "${alias || "(未命名)"}" 的 model_id 必须是字符串，当前是 ${typeof rawWire}，该字段已被忽略（回退用 name 发请求）`,
        });
        continue;
      }

      const wire = typeof rawWire === "string" ? rawWire.trim() : "";

      // ② 空串/纯空白：等价于没配，明说一声免得以为生效了
      if (typeof rawWire === "string" && !wire) {
        warnings.push({
          path: "availableModels",
          message: `模型 "${alias || "(未命名)"}" 的 model_id 是空字符串，等价于未配置（回退用 name 发请求），建议删掉该字段`,
        });
        continue;
      }

      // ③ 与 name 完全相同 = 白配（等价于不配）。纯降噪：有人会以为「配了 model_id
      //    就等于配了双渠道」，而真正的双渠道前提是 name 不同。把注意力拉回 name。
      if (alias && wire && alias === wire) {
        warnings.push({
          path: "availableModels",
          message: `模型 "${alias}" 的 model_id 与 name 完全相同，等价于不配（model_id 缺省即取 name），可以删掉。` +
            `注意：多渠道靠「name 各不相同」区分，只加 model_id 不改 name 仍然只有第一条生效`,
        });
      }
    }

    // 同名多条却给了**不同** model_id：矛盾配置。选择侧 find-first 只认第一条，
    // 于是第二条的 model_id 永远不生效——用户以为「同名+不同 model_id」能区分两个渠道，
    // 实际只有第一条在跑。这比单纯同名更值得单独提示（他确实动过 model_id，说明是刻意配的）。
    const wireByName = new Map<string, Set<string>>();
    for (const m of config.availableModels) {
      const alias = typeof m.name === "string" ? m.name.trim() : "";
      const rawWire: unknown = (m as { modelId?: unknown }).modelId;
      if (!alias || typeof rawWire !== "string") continue;
      const wire = rawWire.trim();
      if (!wire) continue;
      const set = wireByName.get(alias) ?? new Set<string>();
      set.add(wire);
      wireByName.set(alias, set);
    }
    for (const [alias, wires] of wireByName) {
      if (wires.size > 1) {
        warnings.push({
          path: "availableModels",
          message: `模型名 "${alias}" 重复出现且各条的 model_id 不同（${Array.from(wires).join(" / ")}），` +
            `但按名查找只命中第一条，其余条目的 model_id 永远不生效。多渠道必须让 **name 各不相同**` +
            `（如 ${alias}-a / ${alias}-b），再各自配自己的 model_id`,
        });
      }
    }
  }

  // availableModels 逐条检查模板占位符 Key（如 team-defaults.json 用的 __YOUR_API_KEY__）：
  // 上面 validateApiKey 只查当前激活模型解析到顶层的 anthropicKey/openaiKey，覆盖不到
  // "现在没被选中、以后可能被 /model 切过去"的其它条目——/model 切换（app.ts setModel）
  // 只重建 provider，不会重新跑 validateConfig，静默切到另一个占位符 Key 的模型会复现
  // 同一个坑。这里用 __xxx__ 这种模板专用形状精确匹配（真实 Key 不会长这样，零误判），
  // errors 级别确保启动横幅置顶展示——一键安装装完不填真实 Key，发消息 100% 认证失败，
  // 不是"可能"，应该跟 provider/model 缺失一样显眼（但 path 特意不用 "provider"/"model"，
  // 不触发 config.ts 里那条按 path 精确匹配的致命 throw，仍然允许先进 TUI 再让用户去改）。
  const TEMPLATE_PLACEHOLDER_PATTERN = /^__.+__$/;
  if (config.availableModels?.length) {
    const placeholderModels = config.availableModels.filter(
      m => m.provider !== "ollama" && m.apiKey && TEMPLATE_PLACEHOLDER_PATTERN.test(m.apiKey)
    );
    if (placeholderModels.length > 0) {
      const detail = placeholderModels.map(m => `${m.name}(${m.apiKey})`).join(", ");
      errors.push({
        path: "availableModels",
        message: `以下模型的 apiKey 仍是模板占位符，发消息时会认证失败：${detail}。请编辑 settings.json 替换为真实 Key`,
        value: placeholderModels.map(m => m.apiKey),
      });
    }
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

  // 验证 quota（配额管控增强版；注意与顶层 costLimit 是不同字段，互不影响）
  if (config.quota) {
    const q = config.quota;
    if (q.costLimit !== undefined && (typeof q.costLimit !== "number" || q.costLimit <= 0)) {
      warnings.push({ path: "quota.costLimit", message: "必须是正数" });
    }
    if (q.requestsPerMinute !== undefined && (typeof q.requestsPerMinute !== "number" || q.requestsPerMinute <= 0)) {
      warnings.push({ path: "quota.requestsPerMinute", message: "必须是正数" });
    }
    if (q.tokensPerMinute !== undefined && (typeof q.tokensPerMinute !== "number" || q.tokensPerMinute <= 0)) {
      warnings.push({ path: "quota.tokensPerMinute", message: "必须是正数" });
    }

    if (Array.isArray(q.budgetRules)) {
      const VALID_BUDGET_PERIODS = new Set(["session", "hourly", "daily", "weekly", "monthly"]);
      const VALID_BUDGET_ACTIONS = new Set(["alert", "downgrade", "block"]);
      const seenRuleIds = new Set<string>();

      q.budgetRules.forEach((rule, index) => {
        const prefix = `quota.budgetRules[${index}]`;

        if (!rule.id || rule.id.trim() === "") {
          warnings.push({ path: `${prefix}.id`, message: "不能为空" });
        } else if (seenRuleIds.has(rule.id)) {
          warnings.push({ path: `${prefix}.id`, message: `与其它规则重复 ("${rule.id}")` });
        } else {
          seenRuleIds.add(rule.id);
        }

        if (!rule.name || rule.name.trim() === "") {
          warnings.push({ path: `${prefix}.name`, message: "不能为空" });
        }

        if (!VALID_BUDGET_PERIODS.has(rule.period)) {
          warnings.push({
            path: `${prefix}.period`,
            message: `无效值 "${rule.period}"，有效值为 ${Array.from(VALID_BUDGET_PERIODS).join("/")}`,
          });
        }

        if (typeof rule.limit_usd !== "number" || rule.limit_usd <= 0) {
          warnings.push({ path: `${prefix}.limit_usd`, message: "必须是正数，否则该预算规则无意义" });
        }

        if (rule.action !== undefined && !VALID_BUDGET_ACTIONS.has(rule.action)) {
          warnings.push({
            path: `${prefix}.action`,
            message: `无效值 "${rule.action}"，有效值为 ${Array.from(VALID_BUDGET_ACTIONS).join("/")}`,
          });
        }

        // 关键检查：budget-tracker.ts 用字符串精确匹配用量事件的 model 字段，
        // scope.model 一旦引用失效的模型名，这条预算规则会永久静默失效——
        // 用户以为设了限额，实际从未生效，属于财务/安全相关的真实风险。
        if (rule.scope?.model && config.availableModels?.length &&
            !config.availableModels.some(m => m.name === rule.scope!.model)) {
          warnings.push({
            path: `${prefix}.scope.model`,
            message: `模型 "${rule.scope.model}" 未在 availableModels 中找到，此预算规则永远不会命中用量匹配，等同于已失效。如果重命名过 availableModels 条目，请同步更新这里的引用`,
          });
        }

        const th = rule.thresholds;
        if (th) {
          for (const [key, val] of Object.entries(th)) {
            if (val !== undefined && (typeof val !== "number" || val <= 0)) {
              warnings.push({ path: `${prefix}.thresholds.${key}`, message: "必须是正数（0-1 之间的比例，如 0.8 = 80%）" });
            }
          }
          if (th.warning !== undefined && th.critical !== undefined && th.warning > th.critical) {
            warnings.push({ path: `${prefix}.thresholds`, message: "warning 阈值应小于等于 critical 阈值" });
          }
          if (th.critical !== undefined && th.exceeded !== undefined && th.critical > th.exceeded) {
            warnings.push({ path: `${prefix}.thresholds`, message: "critical 阈值应小于等于 exceeded 阈值" });
          }
        }
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

  // 团队记忆同步配置校验（E.11）
  if (config.teamMemory) {
    const tm = config.teamMemory;
    if (tm.enabled !== undefined && typeof tm.enabled !== "boolean") {
      errors.push({
        path: "teamMemory.enabled",
        message: "必须是布尔值",
        value: tm.enabled,
      });
    }
    if (tm.dir !== undefined) {
      if (typeof tm.dir !== "string" || tm.dir.trim() === "") {
        errors.push({
          path: "teamMemory.dir",
          message: "必须是非空字符串（共享目录绝对路径）",
          value: tm.dir,
        });
      } else if (!tm.dir.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(tm.dir)) {
        // 共享目录必须是绝对路径（防止相对路径解析到意外位置）
        errors.push({
          path: "teamMemory.dir",
          message: "团队记忆共享目录必须是绝对路径",
          value: tm.dir,
        });
      }
    }
    if (tm.enabled && !tm.dir) {
      warnings.push({
        path: "teamMemory.dir",
        message: "已启用团队记忆但未配置共享目录 dir，团队记忆仅本地可用、不会跨成员同步",
      });
    }
    if (tm.debounceMs !== undefined) {
      if (typeof tm.debounceMs !== "number" || tm.debounceMs < 0) {
        errors.push({
          path: "teamMemory.debounceMs",
          message: "必须是非负数（毫秒）",
          value: tm.debounceMs,
        });
      }
    }
  }

  // 验证 search 配置：backend 枚举 + 组合一致性
  if (config.search) {
    const s = config.search;
    const VALID_SEARCH_BACKENDS = new Set(["searxng", "brave", "tavily", "duckduckgo"]);
    if (s.backend !== undefined) {
      if (!VALID_SEARCH_BACKENDS.has(s.backend)) {
        warnings.push({
          path: "search.backend",
          message: `无效值 "${s.backend}"，有效值为 ${Array.from(VALID_SEARCH_BACKENDS).join("/")}，将回退到自动检测/DuckDuckGo`,
        });
      } else if (s.backend === "brave" || s.backend === "tavily") {
        // search-backends/factory.ts 里这两个分支整个被注释掉（"Phase 2: 取消注释即可启用"），
        // 配了这两个值实际会静默换成 DuckDuckGo，没有任何报错或警告。
        warnings.push({
          path: "search.backend",
          message: `后端 "${s.backend}" 尚未实现，实际会静默回退到 DuckDuckGo`,
        });
      } else if (s.backend === "searxng" && !s.searxngUrl && !process.env.SEARXNG_URL) {
        warnings.push({
          path: "search.searxngUrl",
          message: `backend 设为 "searxng" 但未配置 searxngUrl（环境变量 SEARXNG_URL 也未设置），实际会静默回退到 DuckDuckGo`,
        });
      }
    }
  }

  // 验证 telemetry 导出器：类型不匹配实现分支时会被静默跳过（createExporter 返回 null）
  // 这个集合必须与 telemetry/index.ts 的 createExporter switch 分支保持一致。
  if (config.telemetry?.exporters?.length) {
    const VALID_EXPORTER_TYPES = new Set(["console", "jsonl", "otlp"]);
    config.telemetry.exporters.forEach((exp, index) => {
      if (!VALID_EXPORTER_TYPES.has(exp.type)) {
        warnings.push({
          path: `telemetry.exporters[${index}].type`,
          message: `无效值 "${exp.type}"，有效值为 ${Array.from(VALID_EXPORTER_TYPES).join("/")}，该导出器会被静默跳过`,
        });
      }
    });
  }

  // 验证 analytics 后端：type 不在实现分支里、或缺失 endpoint 都会被静默跳过。
  // 这个集合必须与 query/init-helpers.ts 的后端注册分派保持一致。
  if (config.analytics?.backends?.length) {
    const VALID_BACKEND_TYPES = new Set(["http", "otlp"]);
    config.analytics.backends.forEach((b, index) => {
      const prefix = `analytics.backends[${index}]`;
      if (!VALID_BACKEND_TYPES.has(b.type)) {
        warnings.push({
          path: `${prefix}.type`,
          message: `无效值 "${b.type}"，有效值为 ${Array.from(VALID_BACKEND_TYPES).join("/")}，该后端会被静默跳过`,
        });
      }
      // type=otlp 时 endpoint 可省略：OtlpExporter 会回退到
      // OTEL_EXPORTER_OTLP_ENDPOINT（默认 http://localhost:4318）+ /v1/logs。
      if (!b.endpoint || b.endpoint.trim() === "") {
        if (b.type === "otlp") {
          if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
            warnings.push({
              path: `${prefix}.endpoint`,
              message: "未设置且环境变量 OTEL_EXPORTER_OTLP_ENDPOINT 也未配置，会回退到 http://localhost:4318/v1/logs",
            });
          }
        } else {
          warnings.push({ path: `${prefix}.endpoint`, message: "不能为空，否则该后端初始化会失败" });
        }
      }
      if (!b.name || b.name.trim() === "") {
        warnings.push({ path: `${prefix}.name`, message: "不能为空" });
      }
    });
  }

  // 验证 sessionRetention：格式需与 session/cleanup.ts 的 parseRetentionPeriod 正则一致
  // （刻意内联同款正则而非跨模块导入 —— cleanup.ts 目前只在少数 cli.ts 分支按需动态加载，
  // schema.ts 静态 import 会把它提升为每次 loadConfig 都加载，与项目现有的惰性加载习惯冲突。
  // 改动 parseRetentionPeriod 的格式时记得同步这里）。
  if (config.sessionRetention) {
    const RETENTION_FORMAT = /^\d+[hdwm]$/;
    const sr = config.sessionRetention;
    if (sr.maxAge !== undefined && !RETENTION_FORMAT.test(sr.maxAge)) {
      warnings.push({
        path: "sessionRetention.maxAge",
        message: `格式无效 ("${sr.maxAge}")，应为 数字+h/d/w/m（如 "30d"），否则启动时自动清理会静默失败`,
      });
    }
    if (sr.minRetention !== undefined && !RETENTION_FORMAT.test(sr.minRetention)) {
      warnings.push({
        path: "sessionRetention.minRetention",
        message: `格式无效 ("${sr.minRetention}")，应为 数字+h/d/w/m（如 "1d"），否则启动时自动清理会静默失败`,
      });
    }
    if (sr.maxCount !== undefined && (typeof sr.maxCount !== "number" || sr.maxCount <= 0)) {
      warnings.push({ path: "sessionRetention.maxCount", message: "必须是正整数" });
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
