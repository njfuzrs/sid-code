/**
 * 配置加载测试
 */

import { describe, test, expect } from "bun:test";
import {
  defaultConfig,
  loadConfig,
  isMissingApiKey,
  PLACEHOLDER_API_KEY,
} from "@sid-code/core/config/config.ts";

describe("config", () => {
  test("defaultConfig 返回合理的默认值（不绑定特定 Provider/模型）", () => {
    const cfg = defaultConfig();
    expect(cfg.provider).toBe("");
    expect(cfg.model).toBe("");
    expect(cfg.maxTokens).toBe(32768);
    expect(cfg.print).toBe(false);
    expect(cfg.yesMode).toBe(false);
    expect(cfg.hooks).toEqual({});
    expect(cfg.mcpServers).toEqual({});
  });

  test("loadConfig 使用 CLI 参数覆盖默认值", async () => {
    const cfg = await loadConfig({
      provider: "openai",
      model: "gpt-4o",
      maxTokens: 4096,
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o");
    expect(cfg.maxTokens).toBe(4096);
  });

  // 回归（code review 自查）：显式 maxTokens 必须在 loadConfig 全流程存活，不被
  // 「按模型推导」分支静默覆盖。曾因 _explicitMaxTokens 登记晚于首次
  // resolveCurrentModelConfig，导致显式值被模型上限覆盖。
  test("loadConfig 显式 maxTokens 低于模型上限时不被模型推导覆盖", async () => {
    const cfg = await loadConfig({
      provider: "openai",
      model: "deepseek-v4-pro", // 注册表上限 384000，远高于显式值
      maxTokens: 8192,
    });
    expect(cfg.maxTokens).toBe(8192);
  });

  // 回归：显式 maxTokens 超过模型物理上限时必须钳制（否则网关 400）。
  test("loadConfig 显式 maxTokens 超模型上限时钳制到上限", async () => {
    const cfg = await loadConfig({
      provider: "openai",
      model: "glm-5.2", // 注册表上限 128000
      maxTokens: 999999,
    });
    expect(cfg.maxTokens).toBe(128000);
  });

  test("loadConfig CLI 参数优先级最高", async () => {
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    // CLI 参数应覆盖环境变量和默认值
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("llama3");
  });

  // 回归：baseURL 只认 SID_CODE_LLM_BASE_URL。
  // ANTHROPIC_BASE_URL 是 Claude Code 的变量，OPENAI_BASE_URL 是 OpenAI SDK 的通用变量，
  // 同机并存时两者都会以「env 优先于配置文件」盖掉用户自己的端点（或在 per-model
  // base_url 存在时每次启动打一条覆盖告警）。空配置目录是为了不读到本机 settings.json。
  test("loadConfig 不把 ANTHROPIC_BASE_URL / OPENAI_BASE_URL 当作自己的 baseURL", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sid-cfg-"));
    const saved = {
      SID_CONFIG_DIR: process.env.SID_CONFIG_DIR,
      SID_CODE_LLM_BASE_URL: process.env.SID_CODE_LLM_BASE_URL,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    };
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    try {
      process.env.SID_CONFIG_DIR = dir;
      delete process.env.SID_CODE_LLM_BASE_URL;
      process.env.OPENAI_BASE_URL = "https://openai.example/v1";
      process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4000";
      const ignored = await loadConfig({ provider: "ollama", model: "llama3" });
      expect(ignored.baseURL).toBe("");

      process.env.SID_CODE_LLM_BASE_URL = "https://sid.example/v1";
      const own = await loadConfig({ provider: "ollama", model: "llama3" });
      expect(own.baseURL).toBe("https://sid.example/v1");
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 回归：per-model base_url 覆盖 env 的提示必须进 _validationDiagnostics，
  // 不能走 getLogger().warn。loadConfig 时 logger 还是 enabled=false 的兜底实例，
  // WARN 只写 stderr，TUI 进 alternate buffer 后被清掉，用户只在加载完成前瞥到一眼。
  // 诊断列表是 TUI 启动横幅与 --print stderr 诊断的共同数据源。
  test("per-model base_url 覆盖 env 时记入启动诊断且不写 stderr", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sid-cfg-"));
    const saved = {
      SID_CONFIG_DIR: process.env.SID_CONFIG_DIR,
      SID_CODE_LLM_BASE_URL: process.env.SID_CODE_LLM_BASE_URL,
    };
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          model: "my-model",
          availableModels: [
            { name: "my-model", provider: "openai", base_url: "https://model.example/v1" },
          ],
        }),
      );
      process.env.SID_CONFIG_DIR = dir;
      process.env.SID_CODE_LLM_BASE_URL = "https://env.example/v1";
      const cfg = await loadConfig({});
      const warnings = cfg._validationDiagnostics?.warnings ?? [];
      const hit = warnings.filter((w) => w.path === "baseURL");
      expect(hit).toHaveLength(1);
      expect(hit[0]!.message).toContain("https://env.example/v1");
      expect(hit[0]!.message).toContain("https://model.example/v1");
      expect(hit[0]!.message).toContain("my-model");
      expect(hit[0]!.message).not.toContain("OPENAI_BASE_URL");
      expect(stderr.join("")).not.toContain("被模型");
      expect(cfg.baseURL).toBe("https://model.example/v1");

      // 值相同不记：否则每条配了 base_url 的模型启动都刷一条横幅，横幅就变成噪音。
      process.env.SID_CODE_LLM_BASE_URL = "https://model.example/v1";
      const same = await loadConfig({});
      const sameHit = (same._validationDiagnostics?.warnings ?? []).filter(
        (w) => w.path === "baseURL",
      );
      expect(sameHit).toHaveLength(0);
    } finally {
      process.stderr.write = origWrite;
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 回归：normalizeConfigKeys 归一化 availableModels 时必须保留用户手写 pricing。
  // 曾漏拷该字段，导致「用户手写价最高优先」被架空（settings.json 里配的价被静默丢弃）。
  test("loadConfig 保留 availableModels 的用户手写 pricing（snake_case 路径）", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sid-cfg-"));
    const prevHome = process.env.SID_CONFIG_DIR;
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          model: "my-model",
          availableModels: [
            {
              name: "my-model",
              provider: "openai",
              base_url: "https://gw.example.com/v1",
              api_key: "sk-x",
              pricing: { input: 1.64, output: 3.29, cacheRead: 0.13 },
            },
          ],
        }),
      );
      process.env.SID_CONFIG_DIR = dir;
      const cfg = await loadConfig({});
      const m = cfg.availableModels.find((x) => x.name === "my-model");
      expect(m?.pricing).toBeDefined();
      expect(m!.pricing!.input).toBe(1.64);
      expect(m!.pricing!.output).toBe(3.29);
      expect(m!.pricing!.cacheRead).toBe(0.13);
    } finally {
      if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
      else process.env.SID_CONFIG_DIR = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // §3.6（fdb47f30）：loadConfig 收尾必须保证 sessionId 非空（单一事实源），
  // 否则 registerSession 写入 active-sessions 的 sessionId 为空字符串（/ps 看不到 id）。
  test("loadConfig 未指定时自动生成非空 sessionId", async () => {
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    expect(cfg.sessionId).toBeTruthy();
    expect(cfg.sessionId.length).toBeGreaterThan(0);
  });

  test("loadConfig 显式传入 sessionId 时保留不覆盖", async () => {
    const cfg = await loadConfig({ provider: "ollama", model: "llama3", sessionId: "myfixed1" });
    expect(cfg.sessionId).toBe("myfixed1");
  });

  // E.11：SID_CODE_TEAM_MEMORY 环境变量覆盖团队记忆配置（文档 §5 承诺的便捷入口）
  describe("SID_CODE_TEAM_MEMORY env 覆盖", () => {
    const ENV_KEY = "SID_CODE_TEAM_MEMORY";
    const orig = process.env[ENV_KEY];
    const restore = () => {
      if (orig === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = orig;
    };

    test("合法 JSON 对象被解析进 config.teamMemory", async () => {
      process.env[ENV_KEY] = JSON.stringify({
        enabled: true,
        dir: "/nas/team-memory",
        debounceMs: 1500,
      });
      try {
        const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
        expect(cfg.teamMemory).toEqual({
          enabled: true,
          dir: "/nas/team-memory",
          debounceMs: 1500,
        });
      } finally {
        restore();
      }
    });

    test("非法 JSON 静默忽略，不污染 config", async () => {
      process.env[ENV_KEY] = "not-json{";
      try {
        const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
        expect(cfg.teamMemory).toBeUndefined();
      } finally {
        restore();
      }
    });

    test("数组等非对象 JSON 被拒绝", async () => {
      process.env[ENV_KEY] = JSON.stringify(["enabled", true]);
      try {
        const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
        expect(cfg.teamMemory).toBeUndefined();
      } finally {
        restore();
      }
    });

    test("只收形状正确的字段，丢弃错误类型", async () => {
      process.env[ENV_KEY] = JSON.stringify({ enabled: "yes", dir: 123, debounceMs: 2000 });
      try {
        const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
        // enabled/dir 类型错被丢，仅 debounceMs 合法
        expect(cfg.teamMemory).toEqual({ debounceMs: 2000 });
      } finally {
        restore();
      }
    });
  });

  // 回归：mergeConfig 曾把 false 与 "" 当成「没给」跳过。后果是文件里显式写的
  // alternateBuffer:false 会被 CLI 层「没传 flag」时带回的缺省盖掉，启动仍然全屏、
  // 鼠标上报打开，选文字必须先 Ctrl+S。false 与空字符串都是表态，必须存活。
  test("loadConfig 保留文件里显式的 false 与空字符串，不被缺省层盖掉", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sid-cfg-"));
    const prevHome = process.env.SID_CONFIG_DIR;
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ alternateBuffer: false, appendSystemPrompt: "" }),
      );
      process.env.SID_CONFIG_DIR = dir;
      const { resetSettingsCache } = await import("@sid-code/core/config/settings/index.ts");
      resetSettingsCache();
      const cfg = await loadConfig({});
      expect(cfg.alternateBuffer).toBe(false);
      expect(cfg.appendSystemPrompt).toBe("");
    } finally {
      if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
      else process.env.SID_CONFIG_DIR = prevHome;
      const { resetSettingsCache } = await import("@sid-code/core/config/settings/index.ts");
      resetSettingsCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 回归：app.json 里混进了不属于 AppConfig 的残留键（alternateBuffer 等），按
  // 「settings 先、app 后」合并且会盖掉 settings.json 的显式值。app.json 只允许
  // 贡献自己声明过的字段；两边冲突时以 settings.json 为准。
  test("app.json 的越界键不覆盖 settings.json，声明内的键仍然生效", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sid-cfg-"));
    const prevHome = process.env.SID_CONFIG_DIR;
    try {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ alternateBuffer: false }));
      writeFileSync(
        join(dir, "app.json"),
        JSON.stringify({
          alternateBuffer: true,
          audit: false,
          showLineNumbers: false,
          numStartups: 7,
        }),
      );
      process.env.SID_CONFIG_DIR = dir;
      const { resetSettingsCache } = await import("@sid-code/core/config/settings/index.ts");
      resetSettingsCache();
      const cfg = await loadConfig({});
      expect(cfg.alternateBuffer).toBe(false);
      // audit 没有被 app.json 的残留 false 盖掉，回到默认 true。
      expect(cfg.audit).toBe(true);
      // showLineNumbers 是 AppConfig 声明内的字段，app.json 的值仍然生效。
      expect(cfg.showLineNumbers).toBe(false);

      // 读盘过滤必须贯穿回写：启动计数这种「读出再整份写回」的路径，
      // 不能把 alternateBuffer 这类越界键原样存回去。
      const { incrementStartupCount, resetAppConfigCache } =
        await import("@sid-code/core/config/app-config.ts");
      resetAppConfigCache();
      incrementStartupCount();
      const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf-8"));
      expect(app.alternateBuffer).toBeUndefined();
      expect(app.audit).toBeUndefined();
      expect(app.numStartups).toBe(8);
    } finally {
      if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
      else process.env.SID_CONFIG_DIR = prevHome;
      const { resetSettingsCache } = await import("@sid-code/core/config/settings/index.ts");
      resetSettingsCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("isMissingApiKey — 占位符/空值识别", () => {
    test("空 / undefined / 纯空白 → 视为缺失", () => {
      expect(isMissingApiKey(undefined)).toBe(true);
      expect(isMissingApiKey(null)).toBe(true);
      expect(isMissingApiKey("")).toBe(true);
      expect(isMissingApiKey("   ")).toBe(true);
    });

    test("团队模板占位符 __YOUR_API_KEY__（含首尾空白）→ 视为缺失", () => {
      expect(isMissingApiKey(PLACEHOLDER_API_KEY)).toBe(true);
      expect(isMissingApiKey("  __YOUR_API_KEY__  ")).toBe(true);
    });

    test("真实 key → 不缺失", () => {
      expect(isMissingApiKey("sk-abc123")).toBe(false);
      expect(isMissingApiKey("anthropic-xyz")).toBe(false);
    });
  });
});
