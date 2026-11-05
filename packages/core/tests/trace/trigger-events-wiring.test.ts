/**
 * 反死线门禁：触发类事件「常量定义了、emit 写了、接线漏了」必须变红（观测缺口方案 T5）
 *
 * ## 防的是什么
 *
 * 这类埋点有三个独立环节：① 事件名常量（单一事实源）；② 生产侧 emit 调用；
 * ③ app 层把 sink 接到 collector。三者**任何一种缺失都不会被其它测试发现**：
 * 单测直接注入 sink，产品里漏接线照样全绿；接线写了、emit 删了也只有人工读代码能看出来。
 * 实测过的形态就是「sink 定义了、emit 写了、接线漏了」——绿测零调用。
 *
 * ## 为什么读源码而不是跑行为
 *
 * 接线发生在 `App.runBridge` 内部（要跑通整条内核 + 真实 WebSocket 才能观察），
 * 行为测试成本远高于收益。这里用静态断言 + 变异自证兜住形态：删掉任一条接线，
 * 本文件的断言必须变红（见 Agent Note 的验证记录）。
 *
 * ## 断言读代码、不读注释
 *
 * 源码注释里大量提到 `BRIDGE_SESSION_EVENT_NAME` 等名字（解释为什么这么写），
 * 直接 `toContain` 会让「emit 调用被删掉」仍然通过。所以先剥注释再断言。
 *
 * ## 覆盖范围
 *
 * 本文件当前只覆盖 bridge 组（T4）。同一方案的 hook / 回滚 / 定时触发三组
 * 由 PR1 补齐时，按同样形态往这里加 describe。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8");
}

/**
 * 去掉 `//` 与块注释，保留字符串与代码。
 *
 * 只处理本仓常见的两种注释形态；字符串里出现 `//`（URL）用「前面不是冒号」
 * 的近似条件避开——目标是消掉注释噪声，不是写一个完整的 JS 词法分析器。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 生产侧 emit：`emitBridgeTelemetry(<sink>, BRIDGE_X_EVENT_NAME, ...)` */
function emitPattern(sinkExpr: string, constName: string): RegExp {
  return new RegExp(`emitBridgeTelemetry\\(\\s*${sinkExpr}\\s*,\\s*${constName}\\b`);
}

describe("触发事件反死线门禁 · bridge（T4）", () => {
  test("三个事件名常量在单一事实源里定义", () => {
    const telemetry = stripComments(read("../../src/bridge/bridge-telemetry.ts"));
    expect(telemetry).toContain('BRIDGE_SESSION_EVENT_NAME = "BridgeSession"');
    expect(telemetry).toContain('BRIDGE_INBOUND_EVENT_NAME = "BridgeInbound"');
    expect(telemetry).toContain('BRIDGE_PERMISSION_EVENT_NAME = "BridgePermission"');
  });

  test("生产侧 emit 调用点都在非注释代码里（生命周期每个阶段各一处）", () => {
    const runner = stripComments(read("../../src/bridge/bridge-runner.ts"));
    const core = stripComments(read("../../src/bridge/bridge-core.ts"));
    const proxy = stripComments(read("../../src/bridge/permission-proxy.ts"));

    // 只断言「至少一处」的话，删掉 connected（连上）或 stopped（收尾）仍然会绿 ——
    // 而「接线漏一条」正是这类门禁要防的形态（实测：删掉 connected 的 emit 后
    // 旧断言照样通过）。三处 = connected + 永久失败（按时机传 phase）+ stopped。
    const sessionEmits = runner.match(
      /emitBridgeTelemetry\(\s*this\.deps\.onTelemetry,\s*BRIDGE_SESSION_EVENT_NAME\b/g,
    );
    expect(sessionEmits?.length).toBe(3);
    expect(runner).toContain('phase: "connected"');
    expect(runner).toContain('phase: "stopped"');
    // 永久失败那一处按调用时机传 phase：start_failed 与 permanent_failure 都必须在生产侧用到，
    // 否则「启动即被拒」和「连上后被踢」会被记成同一个数。
    expect(runner).toContain('consumePermanentFailure("start_failed")');
    expect(runner).toContain('"permanent_failure"');

    expect(core).toMatch(emitPattern("this\\.onTelemetry", "BRIDGE_INBOUND_EVENT_NAME"));
    expect(proxy).toMatch(emitPattern("this\\.onTelemetry", "BRIDGE_PERMISSION_EVENT_NAME"));
  });

  test("runner 把 sink 透传给 core（core 再传给权限代理）", () => {
    const runner = stripComments(read("../../src/bridge/bridge-runner.ts"));
    // 不透传的话：入站消息与权限结果全部静默丢失，而 runner 自己的三个事件仍然正常
    expect(runner).toMatch(/onTelemetry:\s*deps\.onTelemetry/);

    const core = stripComments(read("../../src/bridge/bridge-core.ts"));
    expect(core).toMatch(
      /new PermissionProxy\(\s*this\.transport,\s*options\.permissionTimeoutMs,\s*options\.onTelemetry,?\s*\)/,
    );
  });

  test("app 层把桥接事件接到 collector，并置会话标记", () => {
    // 本文件在 packages/core/tests/trace/ → ../../.. = packages/
    const app = stripComments(read("../../../cli/src/app.ts"));

    // 接线点必须与 recordCustomEvent 在**同一行**：app.ts 里还有别的 onTelemetry
    // 注入（OTel 探针），只断言「文件里出现过 onTelemetry」会被那一处掩盖——
    // bridge 的注入被删掉也照样绿。
    const wiringLines = app.split("\n").filter((line) => line.includes("onTelemetry"));
    expect(wiringLines.some((line) => line.includes("recordCustomEvent"))).toBe(true);

    // 会话标记：没有它「这个会话是不是被遥控的」在 metadata 里查不到
    expect(app).toContain("setBridgeSessionFlag(true)");
  });

  test("collector 构造 metadata 时读会话标记（/clear 重建也走同一处）", () => {
    const collector = stripComments(read("../../src/trace/collector.ts"));
    // 只断言 app 设置了标记不够：collector 漏读时标记永远进不了 metadata，
    // 而两者之间没有类型约束，删掉这行不会有任何东西变红。
    expect(collector).toMatch(/isBridgeSession\(\)\s*\?\s*\{\s*bridge:\s*true\s*\}/);
  });
});
