/**
 * 缺陷 35：内置插件没有磁盘根目录时，`${PLUGIN_ROOT}` 会被展开成空串
 * （`${PLUGIN_ROOT}/hooks/check.sh` → `/hooks/check.sh`，一个看起来合法的根路径）。
 *
 * 修复口径：路径变量不再做字符串替换，由归一化层填 pathVars、runner 导出成环境变量。
 * 所以「没有来源也照样注册」= shell 展开成空串。归一化期必须把这种 handler 判 error 并跳过，
 * 同时不能误伤合法来源（插件有 pluginRoot、skill 有 skillRoot）。
 */

import { describe, expect, test } from "bun:test";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { normalizeHooksConfig } from "@sid-code/core/hook/config-normalize.ts";
import { ConfigSource, type HookConfig } from "@sid-code/core/hook/types.ts";

/** 断言 handler 被识别成 command 类型（HookConfig 是联合类型，收窄后才能读 command / pathVars） */
function asCommand(config: HookConfig | undefined) {
  expect(config?.type).toBe("command");
  return config as Extract<HookConfig, { command: string }>;
}

/** 取出注册表里唯一一条 command hook 的 config */
function onlyCommandConfig(sys: HookSystem) {
  const hooks = sys.getAllHooks();
  expect(hooks).toHaveLength(1);
  return asCommand(hooks[0].config);
}

describe("缺陷 35 - 无插件根目录时拒绝 PLUGIN_ROOT 展开", () => {
  test("内置插件（无 pluginRoot）用 ${PLUGIN_ROOT} → error 诊断且不注册", () => {
    const sys = new HookSystem();
    const diagnostics = sys.replacePluginHooks([
      {
        name: "builtin-x",
        hooks: { Stop: [{ hooks: [{ command: "${PLUGIN_ROOT}/hooks/check.sh" }] }] },
      },
    ]);

    const errors = diagnostics.filter((d) => d.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toEndWith(".command");
    expect(errors[0].message).toContain("PLUGIN_ROOT");
    expect(errors[0].message).toContain("本条已跳过");
    // 关键断言：不是「注册了一条会被展开成 /hooks/check.sh 的 hook」，而是根本没注册
    expect(sys.getAllHooks()).toHaveLength(0);
  });

  test("同一层带 pluginRoot → 正常注册，命令原样保留，pathVars.PLUGIN_ROOT 就位", () => {
    const sys = new HookSystem();
    const diagnostics = sys.replacePluginHooks([
      {
        name: "disk-plugin",
        pluginRoot: "/opt/x",
        hooks: { Stop: [{ hooks: [{ command: "${PLUGIN_ROOT}/hooks/check.sh" }] }] },
      },
    ]);

    expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(0);
    const config = onlyCommandConfig(sys);
    // 不做字符串替换：命令串保持原样，由 runner 导出环境变量交给 shell 展开
    expect(config.command).toBe("${PLUGIN_ROOT}/hooks/check.sh");
    expect(config.pathVars?.PLUGIN_ROOT).toBe("/opt/x");
    expect(config.pathVars?.CLAUDE_PLUGIN_ROOT).toBe("/opt/x");
  });

  test("skill 来源用 ${CLAUDE_PLUGIN_ROOT} 且有 skillRoot → 仍然正常注册（不误伤）", () => {
    // skill hook 的注册来源是 Runtime（见 skill/hooks.ts registerSkillHooks），这里用同一来源复现
    const { entries, diagnostics } = normalizeHooksConfig(
      { Stop: [{ hooks: [{ command: "$CLAUDE_PLUGIN_ROOT/hooks/check.sh" }] }] },
      ConfigSource.Runtime,
      { skillRoot: "/skills/my-skill" },
    );

    expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(0);
    expect(entries).toHaveLength(1);
    const config = asCommand(entries[0].config);
    expect(config.command).toBe("$CLAUDE_PLUGIN_ROOT/hooks/check.sh");
    // skill 来源只导出 CLAUDE_PLUGIN_ROOT / SID_CODE_PLUGIN_ROOT，不导出 sid 旧写法 PLUGIN_ROOT
    expect(config.pathVars?.CLAUDE_PLUGIN_ROOT).toBe("/skills/my-skill");
    expect(config.pathVars?.PLUGIN_ROOT).toBeUndefined();
  });

  test("args 里出现变量、来自 settings 且无插件根 → 同样 error 跳过", () => {
    const { entries, diagnostics } = normalizeHooksConfig(
      { Stop: [{ hooks: [{ command: "bash", args: ["${CLAUDE_PLUGIN_ROOT}/run.sh"] }] }] },
      ConfigSource.User,
    );

    expect(entries).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe("error");
    expect(diagnostics[0].path).toEndWith(".command");
  });

  test("SID_CODE_PLUGIN_ROOT 与 $VAR 裸写两种写法都拦", () => {
    for (const command of ["${SID_CODE_PLUGIN_ROOT}/a.sh", "$PLUGIN_ROOT/a.sh"]) {
      const { entries, diagnostics } = normalizeHooksConfig(
        { Stop: [{ hooks: [{ command }] }] },
        ConfigSource.User,
      );
      expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(1);
      expect(entries).toHaveLength(0);
    }
  });

  test("不误伤其它环境变量（${HOME} / $PATH）", () => {
    const { entries, diagnostics } = normalizeHooksConfig(
      {
        Stop: [
          {
            hooks: [{ command: "${HOME}/bin/check.sh" }, { command: "$PATH:$HOME/bin check" }],
          },
        ],
      },
      ConfigSource.User,
    );

    expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(0);
    expect(entries).toHaveLength(2);
  });

  test("同一层里合法与非法 handler 并存：只跳过非法那条", () => {
    const sys = new HookSystem();
    const diagnostics = sys.replacePluginHooks([
      {
        name: "builtin-x",
        hooks: {
          Stop: [
            {
              hooks: [{ command: "${PLUGIN_ROOT}/bad.sh" }, { command: "echo ok" }],
            },
          ],
        },
      },
    ]);

    expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(1);
    const config = onlyCommandConfig(sys);
    expect(config.command).toBe("echo ok");
  });
});
