/**
 * FIX-7：`settings.monitor` 企业开关与阈值收紧（方案 §L1 / §5.4.5 / §10.6）
 *
 * 验收四条（方案 §L1「验收」段，逐条对应）：
 * 1. `monitor.enabled=false` → 工具列表不含 `monitor`，`tool_search("监控")` 无结果；
 * 2. `maxConcurrent=1` → 第二个 monitor 被拒；
 * 3. `maxTimeoutMs=60000` + 传 `timeout_ms=300000` → 钳到 60s 并在结果里注明；
 * 4. 配置写 `maxConcurrent=99` → 仍按代码常量 4（只收紧不放宽）；
 *    变异：去掉 `min` → 第 4 条红（去掉「取 min」后配置 99 会放宽上限）。
 *
 * 另外两条**只收紧**的跨来源语义（`config/monitor-policy.ts` 存在的理由）：
 * - 企业写宽（99）不能盖掉用户自己的收紧值（2）——settings 合并链是「后者覆盖前者」，
 *   直接用 `getSettings()` 会把这个用户值静默放宽；
 * - `enabled` 任一来源写 false 即关闭（`&&` 语义），企业 true 不能把用户的 false 打开。
 *
 * 真实入口：`new MonitorTool().isEnabled()/call()`、`Registry.definitions()`、
 * `ToolSearchTool.execute()`——不直调 `getMonitorPolicySettings()` 断言内部值。
 *
 * 落盘隔离：call → spawnMonitorTask → initTaskOutput 会写 `~/.sid-code/tasks/`，
 * 按 CONTRIBUTING 把 `SID_CONFIG_DIR` 指向 tmpdir（存/恢复原值）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MonitorTool } from "../../src/tool/monitor.ts";
import { Registry } from "../../src/tool/registry.ts";
import { ToolSearchTool } from "../../src/tool/tool-search.ts";
import {
  MAX_CONCURRENT_MONITORS,
  MAX_MONITOR_TIMEOUT_MS,
  __clearActiveMonitorsForTest,
} from "../../src/task/monitor-task.ts";
import { clearAllTasks, registerTask } from "../../src/task/registry.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import { __resetWaitRegistryForTest, listWaits } from "../../src/task/wait-registry.ts";
import { resetSettingsCache } from "../../src/config/settings/cache.ts";
import { managedSettingsSystemDir } from "../../src/config/paths.ts";
import type { LocalMonitorTaskState } from "../../src/task/types.ts";

// 系统级 managed-settings.json 存在时会盖掉 SID_CONFIG_DIR 下那份（first-exists-wins），
// 本机/CI 通常不存在。存在时跳过并在用例名里写清原因，而不是产出一个假绿。
const systemPolicyExists = existsSync(join(managedSettingsSystemDir(), "managed-settings.json"));

let originalConfigDir: string | undefined;
let tmpHome = "";
const tool = new MonitorTool();

function writeUserSettings(body: unknown): void {
  writeFileSync(join(tmpHome, "settings.json"), JSON.stringify(body));
  resetSettingsCache();
}

function writeManagedSettings(body: unknown): void {
  writeFileSync(join(tmpHome, "managed-settings.json"), JSON.stringify(body));
  resetSettingsCache();
}

/** 造一个已在 registry 里的 monitor 任务（不 spawn 真实进程，用于并发上限） */
function fakeMonitor(id: string): LocalMonitorTaskState {
  const task: LocalMonitorTaskState = {
    id,
    type: "local_monitor",
    status: "running",
    description: `监控 ${id}`,
    startTime: Date.now(),
    outputFile: "",
    outputOffset: 0,
    notified: false,
    command: "true",
    deadlineAt: Date.now() + 60_000,
    eventCount: 0,
    outputLines: 0,
    isBackgrounded: true,
  };
  registerTask(task);
  return task;
}

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-monitor-policy-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  resetSettingsCache();
  __resetWaitRegistryForTest();
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
});

afterEach(() => {
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  __resetWaitRegistryForTest();
  resetSettingsCache();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe.skipIf(systemPolicyExists)("FIX-7 缺省 = 现状（enabled true、上限取代码常量）", () => {
  test("没有任何 monitor 配置时：工具可用，限额等于代码常量", async () => {
    expect(tool.isEnabled()).toBe(true);

    // 默认期限仍是 300s（不传 timeout_ms 时结果里的「5 分钟期限」）
    const r = await tool.call({ description: "缺省", command: "true" });
    expect(r.isError).toBeFalsy();
    expect(r.data).toContain("5 分钟期限");
  });

  test("只配了其中一个数值，另一个仍走代码常量", async () => {
    writeManagedSettings({ monitor: { maxConcurrent: 2 } });
    expect(tool.isEnabled()).toBe(true);
    // maxConcurrent=2 生效：两个占位后第三个被拒
    fakeMonitor("m00000000");
    fakeMonitor("m00000001");
    const r = await tool.call({ description: "第三个", command: "true" });
    expect(r.isError).toBe(true);
    expect(r.data).toContain("上限 2 个");
  });
});

describe.skipIf(systemPolicyExists)("FIX-7 验收 1：enabled=false 关闭工具", () => {
  test("企业配置关闭 → isEnabled false、不进工具列表、tool_search 搜不到", async () => {
    const reg = new Registry();
    reg.register(tool);

    // 对照：禁用**之前**关键词 "monitor" 本来能搜到 monitor（searchHint 命中），
    // 证明下面的空结果是 isEnabled 过滤掉的，不是因为关键词根本匹配不上。
    // 注意用英文关键词：registry 的分词只认拉丁词，"监控" 在未禁用时也匹配不到，
    // 拿它做对照证明不了任何事（方案字面要求的 tool_search("监控") 仍单独断言）。
    expect(reg.searchDeferredTools("monitor").map((t) => t.name())).toContain("monitor");

    writeManagedSettings({ monitor: { enabled: false } });
    expect(tool.isEnabled()).toBe(false);
    expect(reg.definitions().map((d) => d.name)).not.toContain("monitor");
    expect(reg.enabled().map((t) => t.name())).not.toContain("monitor");
    expect(reg.searchDeferredTools("monitor").map((t) => t.name())).not.toContain("monitor");

    // 企业读法 1a：关键词搜索（非工具名）走 searchDeferredTools，已按 isEnabled 过滤
    for (const query of ["watch", "监控"]) {
      const search = await new ToolSearchTool(reg).execute({ query });
      expect(search.isError).toBe(false);
      expect(search.output).not.toContain("monitor");
      expect(reg.isActivated("monitor")).toBe(false);
    }

    // 企业读法 1b：query 恰好是工具名时走精确名快路径——必须明确回「已被策略禁用」，
    // 不能像修复前那样回「已激活 1 个工具」（模型会以为工具可用了）
    const exact = await new ToolSearchTool(reg).execute({ query: "monitor" });
    expect(exact.output).toContain("已被策略禁用");
    expect(exact.output).not.toContain("已激活");
    expect(reg.isActivated("monitor")).toBe(false);

    // 企业读法 2：select 精确激活同样回「已被策略禁用」，进不了 activeDefinitions
    const selected = await new ToolSearchTool(reg).execute({ query: "select:monitor" });
    expect(selected.output).toContain("已被策略禁用");
    expect(reg.activeDefinitions().map((d) => d.name)).not.toContain("monitor");
  });

  test("模型凭历史上下文直调执行层 → 得到可解释的拒绝，而不是静默照跑", async () => {
    writeManagedSettings({ monitor: { enabled: false } });
    const r = await tool.call({ description: "直调", command: "true" });
    expect(r.isError).toBe(true);
    expect(r.data).toContain("settings.monitor.enabled=false");
  });

  test("用户级关闭同样生效（来源不限企业）", async () => {
    writeUserSettings({ monitor: { enabled: false } });
    expect(tool.isEnabled()).toBe(false);
  });

  test("enabled 取 &&：企业写 true 不能把用户的 false 打开", async () => {
    writeUserSettings({ monitor: { enabled: false } });
    writeManagedSettings({ monitor: { enabled: true } });
    expect(tool.isEnabled()).toBe(false);
  });
});

describe.skipIf(systemPolicyExists)("FIX-7 验收 2：maxConcurrent=1 第二个被拒", () => {
  test("企业收紧到 1 → 第二个 monitor 被拒并列出运行中的那个", async () => {
    writeManagedSettings({ monitor: { maxConcurrent: 1 } });
    fakeMonitor("m00000000");
    const r = await tool.call({ description: "第二个", command: "true" });
    expect(r.isError).toBe(true);
    expect(r.data).toContain("上限 1 个");
    expect(r.data).toContain("m00000000");
  });

  test("企业写宽（99）不能放宽用户自己的收紧值（2）", async () => {
    writeUserSettings({ monitor: { maxConcurrent: 2 } });
    writeManagedSettings({ monitor: { maxConcurrent: 99 } });
    fakeMonitor("m00000000");
    fakeMonitor("m00000001");
    const r = await tool.call({ description: "第三个", command: "true" });
    expect(r.isError).toBe(true);
    expect(r.data).toContain("上限 2 个");
  });
});

describe.skipIf(systemPolicyExists)("FIX-7 验收 3：maxTimeoutMs 钳制并在结果里注明", () => {
  test("企业上限 60s + 传 300s → 钳到 60s、结果注明、登记表期限同步", async () => {
    writeManagedSettings({ monitor: { maxTimeoutMs: 60_000 } });
    const before = Date.now();
    const r = await tool.call({
      description: "超上限",
      command: "true",
      timeout_ms: 300_000,
    });
    expect(r.isError).toBeFalsy();
    expect(r.data).toContain("钳制到上限 60000ms");

    // 不只看文案：等待登记里的 deadline 必须真的落在 60s 量级（而不是 300s）
    const id = /已启动监控 (m[a-z0-9]{8})/.exec(r.data)?.[1];
    expect(id).toBeTruthy();
    const wait = listWaits().find((w) => w.id === id);
    expect(wait?.promise.kind).toBe("deadline");
    const deadlineAt = wait?.promise.kind === "deadline" ? wait.promise.deadlineAt : 0;
    expect(deadlineAt - before).toBeLessThanOrEqual(60_000 + 5_000);
  });

  test("不传 timeout_ms 时默认值也随上限收紧（默认 300s → 60s）", async () => {
    writeManagedSettings({ monitor: { maxTimeoutMs: 60_000 } });
    const r = await tool.call({ description: "默认值收紧", command: "true" });
    expect(r.isError).toBeFalsy();
    expect(r.data).toContain("1 分钟期限");
  });
});

describe.skipIf(systemPolicyExists)(
  "FIX-7 验收 4：只收紧、不放宽（maxConcurrent=99 仍按 4）",
  () => {
    test("配置 99 → 仍按代码常量 4，第 5 个被拒", async () => {
      writeManagedSettings({ monitor: { maxConcurrent: 99 } });
      for (let i = 0; i < MAX_CONCURRENT_MONITORS; i++) fakeMonitor(`m0000000${i}`);
      const r = await tool.call({ description: "第五个", command: "true" });
      expect(r.isError).toBe(true);
      expect(r.data).toContain(`上限 ${MAX_CONCURRENT_MONITORS} 个`);
    });

    test("maxTimeoutMs 写超代码常量 → 仍按代码常量钳制", async () => {
      writeManagedSettings({ monitor: { maxTimeoutMs: 99_999_999 } });
      const r = await tool.call({
        description: "超代码常量",
        command: "true",
        timeout_ms: MAX_MONITOR_TIMEOUT_MS * 2,
      });
      expect(r.isError).toBeFalsy();
      expect(r.data).toContain(`钳制到上限 ${MAX_MONITOR_TIMEOUT_MS}ms`);
    });
  },
);
