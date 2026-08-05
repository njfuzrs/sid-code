/**
 * changelog 生成期抹 URL（源头预防）
 *
 * 与 `changelog-integration.test.ts` 里那两条「产物不含内网地址」的断言是**互补**关系：
 * - 那边是**事后闸门**：扫已生成的 changelog.json，能发现问题，但发现时脏数据已进仓库。
 * - 这边测**源头函数**：commit 文本流进产物之前就被抹掉。
 *
 * 为什么需要源头预防：commit message 是开发者随手写的自由文本，作者当时想的是
 * "把改动说清楚"，不是"这段字会被发到公网"。链路（commit → generate-changelog →
 * changelog.json → 站点构建 → 公网）足够长，中间没有任何一步会自然提醒作者。
 *
 * 真实触发过：2026-08-06 域名切换那次，commit 标题里写了新官网地址，于是它被原样
 * 搬进 changelog.json，被上述事后闸门报红。那次泄的恰好是公开地址所以无害，
 * 但同一条通路搬的若是内网 gitlab / 私网 IP，就是把内部坐标发到公网了。
 * 所以判定标准是**URL 形态**，不是"看起来是否敏感"——后者依赖人的判断，会漏。
 */

import { describe, test, expect } from "bun:test";
import { stripUrls } from "../../scripts/generate-changelog.ts";

describe("stripUrls（changelog 生成期抹 URL）", () => {
  test("抹掉 http/https URL，替换为占位符", () => {
    expect(stripUrls("地址切到 https://www.sid-code.cc 并补迁移")).toBe(
      "地址切到 <链接已省略> 并补迁移",
    );
    expect(stripUrls("see http://example.com/a/b?c=1")).toBe("see <链接已省略>");
  });

  test("替换而非删除——保证句子仍读得通", () => {
    // 直接删会留下悬空的"切到"，读起来像话没说完
    const out = stripUrls("把地址切到 https://x.com");
    expect(out).toBe("把地址切到 <链接已省略>");
    expect(out).not.toBe("把地址切到 ");
  });

  test("内网主机名与私网 IP 同样被抹（这才是真正有害的那类）", () => {
    expect(stripUrls("推到 http://gitlab.example.com/foo/bar.git")).toBe("推到 <链接已省略>");
    expect(stripUrls("代理 http://192.168.1.50/searxng")).toBe("代理 <链接已省略>");
    expect(stripUrls("上传到 http://10.0.0.8:9100/mcp 完成")).toBe("上传到 <链接已省略> 完成");
  });

  test("一条文本里多个 URL 全部抹掉", () => {
    expect(stripUrls("从 http://a.com 迁到 https://b.com")).toBe(
      "从 <链接已省略> 迁到 <链接已省略>",
    );
  });

  test("中文右括号/引号不被吞进 URL（否则占位符会连标点一起吃掉）", () => {
    expect(stripUrls("见文档（https://x.com）后续")).toBe("见文档（<链接已省略>）后续");
    expect(stripUrls("见文档(https://x.com)后续")).toBe("见文档(<链接已省略>)后续");
    expect(stripUrls('引用 "https://x.com" 结束')).toBe('引用 "<链接已省略>" 结束');
    expect(stripUrls("链接 [https://x.com] 结束")).toBe("链接 [<链接已省略>] 结束");
  });

  test("不含 URL 的文本原样返回（绝大多数 commit 走这条路，不能误伤）", () => {
    const plain = "fix(tool): 修复 Bash 工具的超时判定，scope 里的冒号与括号都不该被动";
    expect(stripUrls(plain)).toBe(plain);
    // 光出现 "gitlab" 这个词本身无害，不该被动
    expect(stripUrls("迁移到 gitlab 上托管")).toBe("迁移到 gitlab 上托管");
    // 裸域名不是 URL 形态，刻意不管（避免把 "sid-code.cc 已备案" 这种正常叙述打碎）
    expect(stripUrls("www.sid-code.cc 已备案")).toBe("www.sid-code.cc 已备案");
  });

  test("空串与纯 URL 边界", () => {
    expect(stripUrls("")).toBe("");
    expect(stripUrls("https://x.com")).toBe("<链接已省略>");
  });

  test("连续调用结果稳定（/g 正则的 lastIndex 不残留）", () => {
    // 若把带 /g 的正则提到模块级共享并改用 test()/exec()，就会出现"隔次失败"。
    // 这条断言把该退化行为钉住。
    for (let i = 0; i < 3; i++) {
      expect(stripUrls("a https://x.com b")).toBe("a <链接已省略> b");
    }
  });

  test("幂等：已抹过的文本再抹一次不变", () => {
    const once = stripUrls("切到 https://x.com");
    expect(stripUrls(once)).toBe(once);
  });
});
