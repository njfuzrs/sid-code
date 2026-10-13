/**
 * coordinator/mode 最小行为保护。
 *
 * 这个目录之前没有测试，改它时 affected-tests 会回退整包。
 * 补上这几个用例后，改 coordinator/ 时选测能精确命中本目录。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  COORDINATOR_ONLY_TOOLS,
  checkCoordinatorEnv,
  getCoordinatorSystemPrompt,
  isCoordinatorMode,
  setCoordinatorMode,
} from "../../src/coordinator/mode.ts";

describe("coordinator/mode", () => {
  // 模块级 sessionMode 在测试间会残留，每个用例前后复位到 normal
  beforeEach(() => setCoordinatorMode(false));
  afterEach(() => setCoordinatorMode(false));

  test("默认不是 coordinator 模式", () => {
    expect(isCoordinatorMode()).toBe(false);
  });

  test("setCoordinatorMode(true/false) 能切换", () => {
    setCoordinatorMode(true);
    expect(isCoordinatorMode()).toBe(true);
    setCoordinatorMode(false);
    expect(isCoordinatorMode()).toBe(false);
  });

  test("checkCoordinatorEnv() 在 SID_CODE_COORDINATOR_MODE=1 时开启", () => {
    // 存旧值，测完还原——不要无条件 delete（见测试隔离约定）
    const old = process.env.SID_CODE_COORDINATOR_MODE;
    try {
      process.env.SID_CODE_COORDINATOR_MODE = "1";
      setCoordinatorMode(false); // 先清，确保是 env 触发的
      checkCoordinatorEnv();
      expect(isCoordinatorMode()).toBe(true);
    } finally {
      if (old === undefined) delete process.env.SID_CODE_COORDINATOR_MODE;
      else process.env.SID_CODE_COORDINATOR_MODE = old;
    }
  });

  test("checkCoordinatorEnv() 在 env 不为 1 时不开启", () => {
    const old = process.env.SID_CODE_COORDINATOR_MODE;
    try {
      process.env.SID_CODE_COORDINATOR_MODE = "0";
      setCoordinatorMode(false);
      checkCoordinatorEnv();
      expect(isCoordinatorMode()).toBe(false);
    } finally {
      if (old === undefined) delete process.env.SID_CODE_COORDINATOR_MODE;
      else process.env.SID_CODE_COORDINATOR_MODE = old;
    }
  });

  test("getCoordinatorSystemPrompt 包含传入的工具名", () => {
    const prompt = getCoordinatorSystemPrompt(["read", "edit", "bash"]);
    expect(prompt).toContain("read, edit, bash");
  });

  test("COORDINATOR_ONLY_TOOLS 包含 sub_agent", () => {
    expect(COORDINATOR_ONLY_TOOLS.has("sub_agent")).toBe(true);
  });
});
