/**
 * `sid-code -r` 恢复后输入框出现 `>|xterm.js(6.1.0-beta.304)1;2c`：
 * 底座的终端探查（`ESC[>0q` + `ESC[c`）回复被 KeypressContext 直读 stdin 的解析器当成按键。
 * 这里断言 XTVERSION（DCS）与 DA1 / DA2（私有前缀 CSI）回复不产生任何按键，且不吞掉紧随其后的真实输入。
 */
import { describe, expect, test } from "bun:test";
import {
  createDataListener,
  ESC_TIMEOUT,
  type Key,
} from "../../../src/ui/contexts/KeypressContext.tsx";

const E = "\u001B";

async function feed(chunks: string[]): Promise<Key[]> {
  const keys: Key[] = [];
  const listener = createDataListener((k) => {
    keys.push(k);
  });
  for (const c of chunks) listener(c);
  await new Promise((r) => setTimeout(r, ESC_TIMEOUT + 20));
  return keys;
}

const typed = (keys: Key[]) =>
  keys
    .filter((k) => k.insertable)
    .map((k) => k.sequence)
    .join("");

describe("终端探查回复不进输入框", () => {
  test("实测复现形态：XTVERSION(ST) + DA1 同块 → 零按键", async () => {
    expect(await feed([`${E}P>|xterm.js(6.1.0-beta.304)${E}\\${E}[?1;2c`])).toEqual([]);
  });

  test("BEL 结尾的 XTVERSION → 零按键", async () => {
    expect(await feed([`${E}P>|ghostty 1.2\u0007`])).toEqual([]);
  });

  test("回复分块到达 → 零按键", async () => {
    expect(await feed([`${E}P>|xterm.js(6.1`, `.0)${E}`, `\\${E}[?1`, ";2c"])).toEqual([]);
  });

  test("DA2 / kitty 查询回复 → 零按键", async () => {
    expect(await feed([`${E}[>0;276;0c${E}[?0u`])).toEqual([]);
  });

  test("回复后紧跟的真实输入照常交出", async () => {
    expect(typed(await feed([`${E}P>|xterm.js(6.1.0)${E}\\${E}[?1;2cab`]))).toBe("ab");
  });

  test("单独的 Alt+Shift+P 仍是按键", async () => {
    const keys = await feed([`${E}P`]);
    expect(keys.map((k) => [k.name, k.shift, k.alt])).toEqual([["p", true, true]]);
  });

  test("普通方向键 / SGR 鼠标不受影响", async () => {
    const keys = await feed([`${E}[A`]);
    expect(keys.map((k) => k.name)).toEqual(["up"]);
  });
});
