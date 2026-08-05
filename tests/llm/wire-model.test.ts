/**
 * wire-model —— 别名（name）与厂商真名（modelId）分离的回归测试。
 *
 * 背景：`availableModels[].name` 原本一个字段干两件事（本地查找键 + 请求体 model 字段），
 * 导致「同一模型接两个渠道」无解：同名 → 第二条选不中；改名 → 别名被当模型名发给厂商 400。
 * 拆出 modelId 后，本文件钉住三件事：
 *   1. 解析语义（缺省回落 name、find-first、不做任何名字推测）；
 *   2. 进程级别名表兜底（覆盖未显式传 wireModel 的一大票调用点）；
 *   3. 关键回归：fallback 切模型时不得把**主模型的**真名带过去。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveWireModel,
  pickWireModel,
  setWireModelAliases,
  lookupWireModelAlias,
  resetWireModelAliases,
} from "../../src/llm/wire-model.ts";

const DUAL_CHANNEL = [
  { name: "claude-sonnet-5-gateway", modelId: "claude-sonnet-5" },
  { name: "claude-sonnet-5-official", modelId: "claude-sonnet-5" },
];

describe("resolveWireModel", () => {
  test("配了 modelId → 返回厂商真名", () => {
    expect(resolveWireModel("claude-sonnet-5-gateway", DUAL_CHANNEL)).toBe("claude-sonnet-5");
    expect(resolveWireModel("claude-sonnet-5-official", DUAL_CHANNEL)).toBe("claude-sonnet-5");
  });

  test("未配 modelId → 原样返回 name（存量配置零行为变化）", () => {
    const models = [{ name: "glm-5" }, { name: "deepseek-v4-pro" }];
    expect(resolveWireModel("glm-5", models)).toBe("glm-5");
    expect(resolveWireModel("deepseek-v4-pro", models)).toBe("deepseek-v4-pro");
  });

  test("列表为空 / 未传 → 原样返回", () => {
    expect(resolveWireModel("some-model", [])).toBe("some-model");
    expect(resolveWireModel("some-model", undefined)).toBe("some-model");
  });

  test("别名不在列表里 → 原样返回，不做任何名字推测", () => {
    // 刻意不剥离前缀去猜「更像官方名」的值：猜错会把配置错误变成难归因的线上行为。
    expect(resolveWireModel("gw-claude-sonnet-5", DUAL_CHANNEL)).toBe("gw-claude-sonnet-5");
  });

  test("modelId 是空串 / 纯空白 → 视作未配，回落 name", () => {
    const models = [{ name: "a", modelId: "" }, { name: "b", modelId: "   " }];
    expect(resolveWireModel("a", models)).toBe("a");
    expect(resolveWireModel("b", models)).toBe("b");
  });

  test("同名多条 → 命中第一条（与选择侧 find-first 严格同语义）", () => {
    // 选择侧永远切到第一条，解析侧必须同口径，否则「选的是第一条、发的是第二条的真名」。
    const models = [
      { name: "dup", modelId: "real-first" },
      { name: "dup", modelId: "real-second" },
    ];
    expect(resolveWireModel("dup", models)).toBe("real-first");
  });
});

describe("进程级别名表", () => {
  beforeEach(() => resetWireModelAliases());

  test("注册后可查到真名", () => {
    setWireModelAliases(DUAL_CHANNEL);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBe("claude-sonnet-5");
  });

  test("modelId 与 name 相同的条目不入表（等价于没配，白占查询）", () => {
    setWireModelAliases([{ name: "glm-5", modelId: "glm-5" }]);
    expect(lookupWireModelAlias("glm-5")).toBeUndefined();
  });

  test("重新注册会清掉旧映射 —— 否则切配置后别名被错翻成上一份的真名", () => {
    setWireModelAliases(DUAL_CHANNEL);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBe("claude-sonnet-5");
    // 切到一份完全没有 modelId 的配置
    setWireModelAliases([{ name: "glm-5" }]);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBeUndefined();
  });

  test("传 undefined = 清空", () => {
    setWireModelAliases(DUAL_CHANNEL);
    setWireModelAliases(undefined);
    expect(lookupWireModelAlias("claude-sonnet-5-gateway")).toBeUndefined();
  });

  test("同名多条只保留第一条（与 resolveWireModel 同语义）", () => {
    setWireModelAliases([
      { name: "dup", modelId: "real-first" },
      { name: "dup", modelId: "real-second" },
    ]);
    expect(lookupWireModelAlias("dup")).toBe("real-first");
  });
});

describe("pickWireModel（provider 侧取值）", () => {
  beforeEach(() => resetWireModelAliases());

  test("params.wireModel 最高优先（主循环快路径）", () => {
    setWireModelAliases([{ name: "alias", modelId: "from-map" }]);
    expect(pickWireModel({ wireModel: "explicit", model: "alias" }, "ctor")).toBe("explicit");
  });

  test("没带 wireModel → 用别名表翻译 params.model（兜住 side-call / headless 等路径）", () => {
    // 这是别名表存在的全部理由：这些调用点不传 wireModel，逐个补必然漏。
    setWireModelAliases(DUAL_CHANNEL);
    expect(pickWireModel({ model: "claude-sonnet-5-gateway" }, "ctor")).toBe("claude-sonnet-5");
  });

  test("表里没有 → params.model 原样（绝大多数用户的常态，零行为变化）", () => {
    expect(pickWireModel({ model: "glm-5" }, "ctor")).toBe("glm-5");
  });

  test("连 params.model 都没有 → 回落构造时固化值，且该值同样过别名表", () => {
    setWireModelAliases(DUAL_CHANNEL);
    expect(pickWireModel({}, "claude-sonnet-5-gateway")).toBe("claude-sonnet-5");
    expect(pickWireModel({}, "unmapped")).toBe("unmapped");
  });

  test("回归：fallback 切模型时 wireModel=undefined 才能重新翻译", () => {
    // fallback.ts 用 `{...params, model: fallbackModel, wireModel: undefined}`。
    // 若不清掉 wireModel，provider 优先级里它高于 model → 切了 fallback 别名却仍发
    // **主模型**的真名，降级静默失效（发的还是刚失败的那个模型）。
    setWireModelAliases([
      { name: "primary-gw", modelId: "deepseek-v4-pro" },
      { name: "backup-gw", modelId: "glm-5" },
    ]);
    const primaryParams = { model: "primary-gw", wireModel: "deepseek-v4-pro" };
    // 错误做法（只换 model）：仍发主模型真名
    expect(pickWireModel({ ...primaryParams, model: "backup-gw" }, "ctor")).toBe("deepseek-v4-pro");
    // 正确做法（同时清 wireModel）：重新翻译成 fallback 的真名
    expect(
      pickWireModel({ ...primaryParams, model: "backup-gw", wireModel: undefined }, "ctor"),
    ).toBe("glm-5");
  });
});
