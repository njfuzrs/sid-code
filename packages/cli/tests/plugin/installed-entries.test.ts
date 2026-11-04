/**
 * installed.json 逐条 entry 校验（缺陷 37）
 *
 * 背景：这个文件是用户可编辑的纯文本，旧实现只校验 `plugins` 是个对象，每条 entry
 * 一个字段都没查。后续使用处全部直接解引用，其中 `loader.ts` 的
 * `entry.source.endsWith("@builtin")` 在 source 缺失时直接 TypeError，而这行在
 * `assemblePluginLoadResult` 里 —— 报错信息是 `Cannot read properties of undefined`，
 * 与「installed.json 有一条坏数据」毫无关联，排查方向会被带偏。
 *
 * 这里覆盖三层：
 *   1. 纯函数 installedEntryIssue 的判据；
 *   2. readInstalledPlugins 跳过坏条目、保留好条目；
 *   3. loadAllPlugins 把坏条目转成 PluginLoadResult.errors 里的 generic-error（可见）。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installedEntryIssue,
  readInstalledPlugins,
  getInstalledFilePath,
} from "@sid-code/cli/plugin/installed.ts";
import { clearAllPluginCaches } from "@sid-code/cli/plugin/caches.ts";
import { loadAllPlugins } from "@sid-code/cli/plugin/loader.ts";

let tmp = "";
let prevConfigDir: string | undefined;

/** 一条合法 entry（字段与 InstalledPluginEntry 声明的 6 个必填项一致） */
function validEntry(name = "good-plugin") {
  return {
    name,
    path: "/tmp/does-not-matter",
    source: `${name}@local`,
    version: "1.0.0",
    installedAt: "2026-11-01T00:00:00.000Z",
    enabled: true,
  };
}

/** 把给定 plugins 对象写进当前 SID_CONFIG_DIR 下的 installed.json */
function writeRegistry(plugins: Record<string, unknown>): void {
  mkdirSync(join(tmp, "plugins"), { recursive: true });
  writeFileSync(getInstalledFilePath(), JSON.stringify({ version: 1, plugins }, null, 2));
}

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmp = mkdtempSync(join(tmpdir(), "sid-installed-"));
  process.env.SID_CONFIG_DIR = tmp;
  clearAllPluginCaches();
});

afterEach(() => {
  clearAllPluginCaches();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("installedEntryIssue 判据", () => {
  test("合法条目返回 null", () => {
    expect(installedEntryIssue(validEntry())).toBeNull();
  });

  test("缺 source 被拦（旧实现会在 loader 里 TypeError）", () => {
    const { source: _drop, ...rest } = validEntry();
    expect(installedEntryIssue(rest)).toBe("source 必须是非空字符串");
  });

  test("缺 path / path 非字符串被拦", () => {
    expect(installedEntryIssue({ ...validEntry(), path: undefined })).toBe("path 必须是非空字符串");
    expect(installedEntryIssue({ ...validEntry(), path: 123 })).toBe("path 必须是非空字符串");
  });

  test("enabled 不是布尔被拦（旧实现会把 undefined 当 falsy，插件静默禁用）", () => {
    expect(installedEntryIssue({ ...validEntry(), enabled: undefined })).toBe(
      "enabled 必须是布尔值",
    );
  });

  test("external / market 可选，但存在时类型要对", () => {
    expect(installedEntryIssue({ ...validEntry(), external: true })).toBeNull();
    expect(installedEntryIssue({ ...validEntry(), external: "yes" })).toBe("external 必须是布尔值");
    expect(installedEntryIssue({ ...validEntry(), market: { name: "company" } })).toBeNull();
    expect(installedEntryIssue({ ...validEntry(), market: "company" })).toBe("market 必须是对象");
  });

  test("数组 / null 不是合法条目", () => {
    expect(installedEntryIssue([])).toBe("条目不是对象");
    expect(installedEntryIssue(null)).toBe("条目不是对象");
  });
});

describe("readInstalledPlugins 逐条过滤", () => {
  test("坏条目被跳过，好条目保留", async () => {
    writeRegistry({
      "good-plugin": validEntry("good-plugin"),
      "broken-plugin": { name: "broken-plugin", path: "/tmp/x", enabled: true }, // 缺 source/version/installedAt
    });

    const registry = await readInstalledPlugins();
    expect(Object.keys(registry.plugins)).toEqual(["good-plugin"]);
  });

  test("坏条目通过 onInvalidEntry 回调给出原因（供 loader 转成结构化错误）", async () => {
    writeRegistry({ broken: { name: "broken" } });

    const seen: Array<{ key: string; reason: string }> = [];
    await readInstalledPlugins((key, reason) => seen.push({ key, reason }));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe("broken");
    expect(seen[0]!.reason).toContain("installed.json 条目");
  });

  test("plugins 是数组时按格式无效处理（不遍历下标当插件名）", async () => {
    mkdirSync(join(tmp, "plugins"), { recursive: true });
    writeFileSync(getInstalledFilePath(), JSON.stringify({ version: 1, plugins: [] }));
    const registry = await readInstalledPlugins();
    expect(registry.plugins).toEqual({});
  });
});

describe("loadAllPlugins 把坏条目报进 PluginLoadResult.errors", () => {
  test("source 缺失的条目不再抛 TypeError，而是变成一条 generic-error", async () => {
    writeRegistry({
      "broken-plugin": { name: "broken-plugin", path: "/tmp/x", enabled: true },
    });

    // 旧实现在这里抛 `Cannot read properties of undefined (reading 'endsWith')`
    const result = await loadAllPlugins();
    const err = result.errors.find(
      (e) => e.type === "generic-error" && e.source === "broken-plugin",
    );
    expect(err).toBeDefined();
    expect(result.enabled).toEqual([]);
    expect(result.disabled).toEqual([]);
  });
});
