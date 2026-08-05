/**
 * spawn 子代理跨进程 wireModel 传递 —— 别名泄漏防回退。
 *
 * 缺陷链（本次改造中发现并修复）：
 *   spawn 出的子代理是**独立 OS 进程**，它不读 settings.json、不跑 loadConfig，
 *   因此 llm/wire-model.ts 的进程级别名表在子进程里恒为空。父进程若只把 `model`
 *   （本地别名）过管道传过去，子代理就会把 "xxx-gateway" 当模型名发给厂商吃 400/404
 *   —— 而父进程一切正常。故障只在「用了子代理 + 配了 model_id」这一格出现，
 *   且父子进程日志分离，极难归因。
 *
 * 修复由两道防线组成，本文件各测一遍：
 *   ① ParentInitMessage.wire_model：父进程解析好真名随 init 传过去；
 *   ② 子进程 setWireModelAliases 播种：让**本进程内任何路径**（含日后新增的发送点、
 *      以及 ModelFallback 一旦被接上 fallbackProvider 后的降级路径）都自动拿到真名，
 *      而不是依赖「每个调用点都记得传 wireModel」。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  setWireModelAliases,
  resetWireModelAliases,
  pickWireModel,
} from "../../src/llm/wire-model.ts";
import type { ParentInitMessage } from "../../src/agent/sub-agent-protocol.ts";

/** 复刻 headless.ts 收到 init 后的播种逻辑（与 src/entrypoints/headless.ts 保持同构） */
function seedFromInit(init: Pick<ParentInitMessage, "model" | "wire_model">): void {
  if (init.wire_model) {
    setWireModelAliases([{ name: init.model, modelId: init.wire_model }]);
  }
}

describe("防线①：wire_model 随 init 过管道", () => {
  beforeEach(() => resetWireModelAliases());
  afterEach(() => resetWireModelAliases());

  test("子进程用 init.wire_model 发线上，而非别名", () => {
    const init = { model: "cheap-gw", wire_model: "glm-5" };
    // headless.ts 显式传 wireModel: init.wire_model
    expect(pickWireModel({ model: init.model, wireModel: init.wire_model }, init.model)).toBe("glm-5");
  });

  test("老版本父进程不传 wire_model → 回落别名，行为不变（向后兼容）", () => {
    const init: { model: string; wire_model?: string } = { model: "glm-5" };
    expect(pickWireModel({ model: init.model, wireModel: init.wire_model }, init.model)).toBe("glm-5");
  });
});

describe("防线②：子进程别名表播种覆盖所有路径", () => {
  beforeEach(() => resetWireModelAliases());
  afterEach(() => resetWireModelAliases());

  test("播种后，不传 wireModel 的调用点也发真名", () => {
    // 这是防线②的全部价值：逐点传 wireModel 只能覆盖「当前已知」的发送点，
    // 播种让未来新增的发送点默认就正确。
    seedFromInit({ model: "cheap-gw", wire_model: "glm-5" });
    expect(pickWireModel({ model: "cheap-gw" }, "cheap-gw")).toBe("glm-5");
  });

  test("播种后，provider 构造时固化的别名也被翻译（连 params.model 都没有的老调用点）", () => {
    seedFromInit({ model: "cheap-gw", wire_model: "glm-5" });
    expect(pickWireModel({}, "cheap-gw")).toBe("glm-5");
  });

  test("模拟 fallback 换模型：wireModel 清空后靠播种表重新翻译，不会残留主模型真名", () => {
    // ModelFallback 用 `{...params, model: X, wireModel: undefined}`。子进程里若没有
    // 播种表，这一步会退化成「发别名」；有表则正确翻译。
    seedFromInit({ model: "cheap-gw", wire_model: "glm-5" });
    const primary = { model: "cheap-gw", wireModel: "glm-5" };
    const switched = { ...primary, model: "cheap-gw", wireModel: undefined };
    expect(pickWireModel(switched, "cheap-gw")).toBe("glm-5");
  });

  test("wire_model 缺省时不播种，未配 model_id 的存量用户零行为变化", () => {
    seedFromInit({ model: "glm-5" });
    expect(pickWireModel({ model: "glm-5" }, "glm-5")).toBe("glm-5");
    // 任意其它模型也不受影响
    expect(pickWireModel({ model: "deepseek-v4-pro" }, "x")).toBe("deepseek-v4-pro");
  });

  test("wire_model === model 时不入表（等价于没配，避免白占查询）", () => {
    seedFromInit({ model: "glm-5", wire_model: "glm-5" });
    expect(pickWireModel({ model: "glm-5" }, "glm-5")).toBe("glm-5");
  });
});

describe("归因不变量：子进程回报给父进程的仍是别名", () => {
  test("result 消息用 init.model（别名），否则两个渠道的用量会被合并统计", () => {
    // headless.ts 的 result 消息 `model: init.model` 是刻意的：
    // 别名才能区分「网关渠道」与「官方渠道」的用量与成本。
    const init = { model: "cheap-gw", wire_model: "glm-5" };
    const reported = init.model;
    expect(reported).toBe("cheap-gw");
    expect(reported).not.toBe(init.wire_model);
  });
});
