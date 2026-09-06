/**
 * 命令集合变更广播测试（P1-2）。
 *
 * ## 缺陷形态
 *
 * 补全菜单与 `/help` 读的是 `TUIState.commands`，那份 state 修复前**全仓只被赋值一次**
 * （启动时 `await loadCommandList()` 一次），此后没有任何路径会更新它。于是注册表侧
 * 的三条动态来源在补全里全部失效：
 *
 * | 动态来源              | 注册表 getCommands | 补全菜单 |
 * | MCP 服务器中途连上/断开 | ✅ 正确反映         | ❌ 看不到/仍列着 |
 * | /reload-plugins 热更新 | ✅                 | ❌ |
 * | /skills 禁用某 skill   | ✅                 | ❌ |
 *
 * 执行路径是好的（每次执行都重新 getCommands），所以症状是「盲敲全名能跑，
 * 但补全里找不到」——表现为"这个功能好像不支持"而不是"有个 bug"。
 * 旁证：`CommandsDialog` 自己 useEffect 重新拉了一次，所以那个面板是新鲜的
 * ——同一份数据，面板对、补全错。
 *
 * ## 为什么锁"广播"而不是锁"每个变更点各自刷新"
 *
 * 后者靠人记，第五个变更点出现时会漏，而漏掉不会有任何东西报错
 * （补全少一条命令没人会红）。所以修法是让**唯一持有变更事实的一方**主动广播。
 * 下面逐个变更点断言它确实广播了 —— 少任何一个，对应的动态来源就在补全里失效。
 */

import { describe, test, expect } from "bun:test";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";

describe("onCommandsChanged 广播覆盖全部变更点", () => {
  test("setDisabledSkills（/skills 面板启停）会广播", () => {
    const reg = new UnifiedCommandRegistry();
    let n = 0;
    reg.onCommandsChanged(() => n++);
    reg.setDisabledSkills(["some-skill"]);
    expect(n).toBe(1);
  });

  test("invalidateSkillCommands（skill 集合运行时变化）会广播", () => {
    const reg = new UnifiedCommandRegistry();
    let n = 0;
    reg.onCommandsChanged(() => n++);
    reg.invalidateSkillCommands();
    expect(n).toBe(1);
  });

  test("clearCache 会广播", () => {
    const reg = new UnifiedCommandRegistry();
    let n = 0;
    reg.onCommandsChanged(() => n++);
    reg.clearCache();
    expect(n).toBe(1);
  });

  test("notifyExternalChange（MCP prompt / 连接态）会广播", () => {
    // MCP prompt 命令不进 cwd 缓存（getCommands 每次现场构建），
    // 所以它变了不需要清缓存，只需转发"变了"这件事。
    const reg = new UnifiedCommandRegistry();
    let n = 0;
    reg.onCommandsChanged(() => n++);
    reg.notifyExternalChange();
    expect(n).toBe(1);
  });

  test("reloadPlugins（/reload-plugins）会广播", async () => {
    const reg = new UnifiedCommandRegistry();
    let n = 0;
    reg.onCommandsChanged(() => n++);
    await reg.reloadPlugins();
    expect(n).toBe(1);
  });
});

describe("订阅语义", () => {
  test("多个订阅者都收到", () => {
    const reg = new UnifiedCommandRegistry();
    let a = 0;
    let b = 0;
    reg.onCommandsChanged(() => a++);
    reg.onCommandsChanged(() => b++);
    reg.clearCache();
    expect([a, b]).toEqual([1, 1]);
  });

  test("退订后不再收到", () => {
    const reg = new UnifiedCommandRegistry();
    let n = 0;
    const off = reg.onCommandsChanged(() => n++);
    reg.clearCache();
    off();
    reg.clearCache();
    expect(n).toBe(1);
  });

  test("某个监听器抛异常不影响其他监听器与主流程", () => {
    const reg = new UnifiedCommandRegistry();
    let reached = 0;
    reg.onCommandsChanged(() => {
      throw new Error("订阅方炸了");
    });
    reg.onCommandsChanged(() => reached++);
    // 不抛：触发变更的那个操作（如 /reload-plugins 本身）不能被订阅方拖垮
    expect(() => reg.clearCache()).not.toThrow();
    expect(reached).toBe(1);
  });

  test("无订阅者时广播是安全的空操作（启动早期）", () => {
    const reg = new UnifiedCommandRegistry();
    expect(() => reg.clearCache()).not.toThrow();
  });
});
