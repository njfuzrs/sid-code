/**
 * 端末応答フラグメント漏洩の回帰テスト
 *
 * 背景:`-r` で履歴会話を恢复すると入力欄に `>|xterm.js(6.1.0-beta.288)1;2c`
 * のような乱码が現れるバグがあった。原因は:
 *   1. Ink 起動時に XTVERSION(`CSI>0q` → DCS 応答) + DA1(`CSI c`) 探査を送る
 *   2. 恢复は履歴大量でレンダリングが重く,イベントループが 50ms 超ブロック
 *   3. すると分割到着した DCS/CSI 応答が incomplete-escape タイムアウトで
 *      flush され,tokenize が「未完シーケンス」を sequence トークンとして吐く
 *   4. その断片は完全形の応答正規表現にマッチせず,parseKeypress で **キー入力**
 *      として text 化 → 入力欄へ漏洩
 *
 * 根治:応答プレフィックス(DCS `\x1bP` / OSC `\x1b]` / CSI-private `\x1b[?` /
 * CSI-secondary `\x1b[>` / 単独 ST `\x1b\\`)を持つ sequence は物理キーが
 * 生成し得ないので,完全形にマッチしなくても `responseFragment` として扱い
 * 破棄する。矢印キー等の一般 CSI(`\x1b[A`)は従来どおりキーとして残す。
 */

import { test, expect, describe } from "bun:test";
import {
  parseMultipleKeypresses,
  INITIAL_STATE,
  type ParsedInput,
} from "@sid-code/tui-renderer/parse-keypress.ts";

/** 入力欄へ漏れる「ESC を含むのに名前の無いキー」が含まれるか(=漏洩判定) */
function hasEscLeak(keys: ParsedInput[]): boolean {
  return keys.some(
    (k) =>
      k.kind === "key" &&
      typeof k.sequence === "string" &&
      k.sequence.includes("\x1b") &&
      !k.name
  );
}

/** フラグメントとして破棄対象になったキーの数 */
function fragmentCount(keys: ParsedInput[]): number {
  return keys.filter(
    (k) => k.kind === "response" && k.response.type === "responseFragment"
  ).length;
}

describe("端末応答フラグメントの漏洩根絶", () => {
  test("XTVERSION 応答が分割到着 + flush されても漏れない", () => {
    // 重いレンダリングで DCS 応答が途中まで届き,ST 到着前に flush される
    const [, s1] = parseMultipleKeypresses(
      INITIAL_STATE,
      "\x1bP>|xterm.js(6.1.0-beta.288)"
    );
    const [flushed] = parseMultipleKeypresses(s1, null); // flush(input=null)
    expect(hasEscLeak(flushed)).toBe(false);
    expect(fragmentCount(flushed)).toBe(1);
  });

  test("XTVERSION 本体消費後の ST 残尾(\\x1b\\\\)が単独で来ても漏れない", () => {
    const [k] = parseMultipleKeypresses(INITIAL_STATE, "\x1b\\\x1b[?1;2c");
    expect(hasEscLeak(k)).toBe(false);
    // ST は fragment,DA1 は完全形なので正しく response(da1)
    expect(k.some((x) => x.kind === "response" && x.response.type === "da1")).toBe(true);
    expect(fragmentCount(k)).toBe(1);
  });

  test("DA1 応答が分割 flush(\\x1b[?1;2 で c 欠落)されても漏れない", () => {
    const [, s1] = parseMultipleKeypresses(INITIAL_STATE, "\x1b[?1;2");
    const [flushed] = parseMultipleKeypresses(s1, null);
    expect(hasEscLeak(flushed)).toBe(false);
    expect(fragmentCount(flushed)).toBe(1);
  });

  test("OSC11 背景色応答が分割 flush されても漏れない", () => {
    const [, s1] = parseMultipleKeypresses(
      INITIAL_STATE,
      "\x1b]11;rgb:1a1a/1b1b"
    );
    const [flushed] = parseMultipleKeypresses(s1, null);
    expect(hasEscLeak(flushed)).toBe(false);
    expect(fragmentCount(flushed)).toBe(1);
  });

  test("完全な XTVERSION 応答は従来どおり正しく xtversion として消費", () => {
    const [k] = parseMultipleKeypresses(
      INITIAL_STATE,
      "\x1bP>|ghostty 1.2\x1b\\"
    );
    const r = k.find((x) => x.kind === "response");
    expect(r?.kind).toBe("response");
    expect(r && r.kind === "response" && r.response.type).toBe("xtversion");
  });

  test("完全な DA1 応答は従来どおり da1 として消費", () => {
    const [k] = parseMultipleKeypresses(INITIAL_STATE, "\x1b[?1;2c");
    const r = k.find((x) => x.kind === "response");
    expect(r && r.kind === "response" && r.response.type).toBe("da1");
  });
});

describe("正常な入力を誤ってフラグメント扱いしない", () => {
  test("方向キーはキーとして残る", () => {
    const [k] = parseMultipleKeypresses(
      INITIAL_STATE,
      "\x1b[A\x1b[B\x1b[C\x1b[D"
    );
    expect(fragmentCount(k)).toBe(0);
    expect(k.map((x) => (x.kind === "key" ? x.name : null))).toEqual([
      "up",
      "down",
      "right",
      "left",
    ]);
  });

  test("修飾キー/Home/End/Delete はキーとして残る", () => {
    const [k] = parseMultipleKeypresses(
      INITIAL_STATE,
      "\x1b[1;5A\x1b[3~\x1b[H\x1b[F"
    );
    expect(fragmentCount(k)).toBe(0);
    expect(k.every((x) => x.kind === "key")).toBe(true);
  });

  test("普通のテキスト入力はそのまま", () => {
    const [k] = parseMultipleKeypresses(INITIAL_STATE, "hello world");
    expect(fragmentCount(k)).toBe(0);
    expect(k[0]?.kind).toBe("key");
    expect(k[0] && k[0].kind === "key" && k[0].sequence).toBe("hello world");
  });

  test("ユーザーが押した単独 ESC は漏れないが誤フラグメントも作らない", () => {
    const [, s1] = parseMultipleKeypresses(INITIAL_STATE, "\x1b");
    const [flushed] = parseMultipleKeypresses(s1, null);
    // 単独 ESC は Escape キーになるか空になる。ESC 付き無名キーの漏洩は無い。
    expect(hasEscLeak(flushed)).toBe(false);
  });
});
