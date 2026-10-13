/**
 * 早期输入捕获（early-input.ts）回归测试
 *
 * 背景：首屏弹「项目扩展信任」框时 InputArea 不挂载，早期捕获一直开着，与 KeypressContext
 * 同时读 stdin。用户在框里按 ↑ + 回车被它吞进缓冲；又因 KeypressContext 已 setEncoding("utf8")，
 * read() 返回字符串，旧实现按字节 `String.fromCharCode("a")` 把每个字符变成 NUL。
 * 关框后 InputArea 挂载回填，输入框多出不可见字符（真 pty 实测提交文本 "\x00\x00\x00bc"）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  appendEarlyInputData,
  consumeEarlyInput,
  stopCapturingEarlyInput,
} from "../../src/ui/early-input.ts";

describe("early-input", () => {
  beforeEach(() => {
    consumeEarlyInput();
  });

  test("字符串数据不再被转成 NUL", () => {
    appendEarlyInputData("abc");
    expect(consumeEarlyInput()).toBe("abc");
  });

  test("Buffer 数据按 UTF-8 解码（中文不被拆字节）", () => {
    appendEarlyInputData(Buffer.from("你好", "utf8"));
    expect(consumeEarlyInput()).toBe("你好");
  });

  test("方向键整段跳过，不留下 [A；回车转换为换行", () => {
    appendEarlyInputData("\x1b[A\r");
    expect(consumeEarlyInput()).toBe("\n");
    appendEarlyInputData("x\x1b[1;5Cy\x1bOPz");
    expect(consumeEarlyInput()).toBe("xyz");
  });

  test("退格删除最后一个字符（按码点）", () => {
    appendEarlyInputData("ab你\x7f");
    expect(consumeEarlyInput()).toBe("ab");
  });

  test("其余控制字符丢弃，NUL 不进缓冲", () => {
    appendEarlyInputData("a\x00\x01\tb");
    expect(consumeEarlyInput()).toBe("a\tb");
  });

  test("stopCapturingEarlyInput 只停捕获、保留已缓冲内容", () => {
    appendEarlyInputData("hi");
    stopCapturingEarlyInput();
    expect(consumeEarlyInput()).toBe("hi");
  });

  test("KeypressProvider 接管 stdin 时停掉早期捕获（防回归锚点）", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/ui/contexts/KeypressContext.tsx"),
      "utf8",
    );
    expect(src).toContain("stopCapturingEarlyInput()");
  });
});
