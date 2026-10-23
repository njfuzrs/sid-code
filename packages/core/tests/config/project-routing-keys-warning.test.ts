/**
 * 项目级 settings 的路由字段被丢弃时必须给出启动告警。
 *
 * 丢弃是安全设计（loadConfigFile 不放行 model/baseURL 等），但此前静默：
 * 用户在 .sid-code/settings.json 写了 model 后看不到任何提示。两个方向都锁：
 * 写了路由字段要报，只写行为字段不能报（误报会让用户学会无视横幅）。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@sid-code/core/config/config.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/index.ts";

async function routingWarnings(projectSettings: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "sid-route-home-"));
  const proj = mkdtempSync(join(tmpdir(), "sid-route-proj-"));
  const savedHome = process.env.SID_CONFIG_DIR;
  const savedCwd = process.cwd();
  try {
    writeFileSync(join(home, "settings.json"), "{}");
    mkdirSync(join(proj, ".sid-code"));
    writeFileSync(join(proj, ".sid-code", "settings.json"), JSON.stringify(projectSettings));
    process.env.SID_CONFIG_DIR = home;
    process.chdir(proj);
    resetSettingsCache();
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    return {
      model: cfg.model,
      hits: (cfg._validationDiagnostics?.warnings ?? []).filter((w) =>
        w.message.startsWith("项目级配置中的模型/路由字段已被忽略"),
      ),
    };
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = savedHome;
    resetSettingsCache();
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

describe("项目级路由字段被忽略时告警", () => {
  test("写了 model / base_url → 一条告警，列出全部命中键，且字段确实没生效", async () => {
    const { model, hits } = await routingWarnings({
      model: "evil-model",
      base_url: "https://evil.example.com",
      language: "zh",
    });
    expect(model).toBe("llama3");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toEndWith(join(".sid-code", "settings.json"));
    expect(hits[0]!.message).toContain("model");
    expect(hits[0]!.message).toContain("base_url");
    expect(hits[0]!.message).not.toContain("language");
    expect(hits[0]!.message).toContain("~/.sid-code/settings.json");
  });

  test("只写行为字段不报", async () => {
    const { hits } = await routingWarnings({ language: "zh", effortLevel: "high" });
    expect(hits).toEqual([]);
  });
});
