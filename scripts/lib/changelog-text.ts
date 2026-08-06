/**
 * changelog 文本清洗的**唯一实现**（原先内联在 generate-changelog.ts 里）。
 *
 * 为什么抽出来：curated 改造之后，「抹 URL」这件事有了三个消费方 ——
 * 校验器（入库前拦截）、生成器（渲染期兜底）、单测。三处各写一套正则
 * 就是三套判定标准，而它们分叉的症状是「某一条通路漏了个内网地址」，
 * 静默且直到有人肉眼看见才发现。
 *
 * `scripts/generate-changelog.ts` 仍然 re-export `stripUrls`，
 * 老的 import 路径（tests/website/changelog-strip-urls.test.ts）不受影响。
 */

/**
 * URL 形态。判定标准是**形态**而不是「看起来是否敏感」——
 * 后者依赖人的判断，会漏（见 stripUrls 的注释）。
 *
 * 尾部排除 `"'）)\]` 与空白：避免把中文右括号、引号、方括号一起吞进 URL，
 * 那样占位符会连标点带走（`见文档（https://x）后续` → `见文档（<链接已省略>`）。
 *
 * ⚠ 刻意**每次调用新建实例**而不是模块级常量：带 /g 的正则有 lastIndex 状态，
 * 模块级共享一个实例时，`.test()` / `.exec()` 会出现「隔次匹配失败」的经典坑。
 * `.replace()` 会自动重置 lastIndex 所以当下安全，但别留这个雷。
 */
function urlRe(): RegExp {
  return /https?:\/\/[^\s"'）)\]]+/g;
}

/** URL 被抹掉后留下的占位符。校验器与生成器都认这一个字面量。 */
export const URL_PLACEHOLDER = "<链接已省略>";

/**
 * 从文本里抹掉 URL —— changelog.json 会随站点发布到公网。
 *
 * 为什么必须在**生成期**做，而不是靠 review 或测试兜：
 * commit message 是**开发者随手写**的自由文本，作者当时想的是"把改动说清楚"，
 * 不是"这段字会被发到公网"。链路（commit → generate-changelog → changelog.json →
 * 站点构建 → 公网）足够长，没有任何一步会自然提醒作者这件事。
 * `tests/website/changelog-integration.test.ts` 的两条断言是**事后闸门**（能发现，
 * 但发现时脏数据已经进了仓库）；这里是**源头预防**。两者都要有，职责不同。
 *
 * 实际踩过：2026-08-06 那次域名切换，commit 标题里写了新官网地址，
 * 于是 `https://www.sid-code.cc` 被原样搬进 changelog.json，测试报红。
 * 那次泄的恰好是公开地址所以无害，但同一条通路搬的若是内网 gitlab / 私网 IP，
 * 就是真的把内部坐标发到公网了 —— 判定标准只能是"URL 形态"，不能靠"看起来是否敏感"。
 *
 * ⚠ curated 文案（`changelog/curated/*.json`）走的是**同一条通路**，而且多一个
 * 风险源：agent 读 diff 时会看到内网 gitlab 地址、部署脚本里的 IP、主机名，
 * 完全可能原样抄进文案。提示词里有一条"不要写 URL"，但提示词不是保障 ——
 * 所以校验器（入库前）与本函数（渲染期）两道都要有，见方案 §7.2。
 *
 * 处理方式是替换成占位符而非整段删除：把 "地址切到 https://x" 变成
 * "地址切到 <链接已省略>" 仍读得通，直接删会留下悬空的"切到"。
 */
export function stripUrls(text: string): string {
  return text.replace(urlRe(), URL_PLACEHOLDER);
}

/** 文本里是否含 URL 形态。校验器用它做**入库前拦截**（拦住而不是静默改写）。 */
export function hasUrl(text: string): boolean {
  return urlRe().test(text);
}

/** 文本里全部 URL（报错信息里要指出具体是哪一个，不能只说"含 URL"）。 */
export function findUrls(text: string): string[] {
  return text.match(urlRe()) ?? [];
}
