/**
 * kitty CSI-u 的 `:` 分隔参数（候选码点 / 事件类型 / 关联文本）解析。
 *
 * 背景：方案文档 §6.1——`\x1b[38:55;2u`（主码点 38=`&`）曾解析失败，
 * `&` 丢失且 `55;2u` 逐字符漏进输入框。修复后要求主码点保真、剩余参数不漏。
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

describe("kitty CSI-u 的 `:` 分隔参数", () => {
  test("候选码点 \\x1b[38:55;2u → 单个 &（不漏 55;2u）", async () => {
    expect(typed(await feed([`${E}[38:55;2u`]))).toBe("&");
  });

  test("候选码点形态保留 modifier（shift）", async () => {
    const keys = await feed([`${E}[38:55;2u`]);
    expect(keys[0]?.shift).toBe(true);
    expect(keys[0]?.insertable).toBe(true);
  });

  test("多码点关联文本 \\x1b[38;2;38:55u → 单个 &", async () => {
    expect(typed(await feed([`${E}[38;2;38:55u`]))).toBe("&");
  });

  test("多码点关联文本形态保留 modifier（shift）", async () => {
    const keys = await feed([`${E}[38;2;38:55u`]);
    expect(keys[0]?.shift).toBe(true);
    expect(keys[0]?.insertable).toBe(true);
  });

  test("候选码点后紧随真实输入：\\x1b[38:55;2uX → &X", async () => {
    expect(typed(await feed([`${E}[38:55;2uX`]))).toBe("&X");
  });

  test("主码点 97（a）的候选码点形态 \\x1b[97:65;2u → a", async () => {
    expect(typed(await feed([`${E}[97:65;2u`]))).toBe("a");
  });

  test("无 `:` 的既有形态不受影响：\\x1b[38;2u → &", async () => {
    expect(typed(await feed([`${E}[38;2u`]))).toBe("&");
  });

  test("负向对照：alt+& 仍是快捷键语义，不进输入框", async () => {
    const keys = await feed([`${E}[38;3u`]);
    expect(typed(keys)).toBe("");
    expect(keys[0]?.alt).toBe(true);
  });
});
