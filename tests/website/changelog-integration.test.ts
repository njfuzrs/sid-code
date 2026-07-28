/**
 * 更新日志并入站点后的契约单测（设计方案 §4.3.8）。
 *
 * 改造把 changelog 从「外链到自建 mini 站」变成「站内一等页面」，产生了几条
 * 隐式契约——它们一旦破掉，症状都是**页面看着正常但内容不对**，光看构建成功
 * 或状态码 200 发现不了。这里把能在单测层锁住的部分钉死：
 *
 *   ① 数据形态：generate-changelog.ts 产出的 JSON 结构与组件的读取假设一致
 *   ② 无内网地址：JSON 会随站点发到公网，不能带 gitlab / 内网 IP（设计方案 §6.5）
 *   ③ 容器页 frontmatter 必须有 search: false，否则几百条 commit 冲垮全站搜索
 *   ④ 全站搜索排除钩子必须先 render 再判断（顺序颠倒会静默失效——实测踩过）
 *   ⑤ CHANGELOG.html 是指向 /changelog 的跳转页，不再是自建 mini 站
 *
 * 不在覆盖范围内（如实记录，免得看到"有测试"就以为全覆盖）：
 *   · 组件的实际渲染与搜索交互 —— 需浏览器，已用 playwright + computed style 实测
 *   · 语义色对比度 —— 同上，已实测浅色 5.25–6.38 / 深色 6.73–9.24 全达 AA
 *   · 发布流水线的端到端串联 —— 需真实服务器
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const DATA_PATH = resolve(ROOT, "website/.vitepress/data/changelog.json");
const PAGE_PATH = resolve(ROOT, "website/changelog.md");
const CONFIG_PATH = resolve(ROOT, "website/.vitepress/config.ts");
const COMPONENT_PATH = resolve(ROOT, "website/.vitepress/theme/Changelog.vue");
const HTML_PATH = resolve(ROOT, "CHANGELOG.html");

describe("changelog.json · 站点数据源形态", () => {
  test("文件存在（缺失会让 /changelog 构建失败）", () => {
    expect(existsSync(DATA_PATH)).toBe(true);
  });

  test("顶层字段齐全且类型正确", () => {
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    expect(typeof d.generatedAt).toBe("string");
    expect(d.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof d.currentVersion).toBe("string");
    expect(d.currentVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof d.totalVersions).toBe("number");
    expect(typeof d.totalCommits).toBe("number");
    expect(Array.isArray(d.groupMeta)).toBe(true);
    expect(Array.isArray(d.versions)).toBe(true);
    expect(d.versions.length).toBeGreaterThan(0);
  });

  test("统计字段与实际数组一致（组件页顶直接显示这些数字）", () => {
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    expect(d.totalVersions).toBe(d.versions.length);
    const actual = d.versions.reduce(
      (n: number, v: any) =>
        n + v.groups.reduce((m: number, g: any) => m + g.commits.length, 0),
      0,
    );
    expect(d.totalCommits).toBe(actual);
  });

  test("每个版本的 count 等于其分组下提交数之和", () => {
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    for (const v of d.versions) {
      const sum = v.groups.reduce((m: number, g: any) => m + g.commits.length, 0);
      expect(v.count).toBe(sum);
    }
  });

  test("提交条目字段与组件读取的键名一致", () => {
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    for (const v of d.versions) {
      expect(typeof v.version).toBe("string");
      expect(v.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof v.isGenesis).toBe("boolean");
      for (const g of v.groups) {
        // 空分组不该被产出——组件不做空分组过滤，会渲染出一个只有徽章的空壳
        expect(g.commits.length).toBeGreaterThan(0);
        for (const c of g.commits) {
          expect(typeof c.desc).toBe("string");
          expect(c.desc.length).toBeGreaterThan(0);
          expect(typeof c.hash).toBe("string");
          expect(Array.isArray(c.details)).toBe(true);
          // scope 允许为 null，但不能是 undefined（组件用 v-if 判空）
          expect(c.scope === null || typeof c.scope === "string").toBe(true);
        }
      }
    }
  });

  test("分组 key 都在 groupMeta 里声明过（否则徽章拿不到中文标题与配色）", () => {
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    const known = new Set(d.groupMeta.map((g: any) => g.key));
    for (const v of d.versions) {
      for (const g of v.groups) {
        expect(known.has(g.key)).toBe(true);
      }
    }
  });

  test("最新版本排在最前（组件不做排序，直接按数组顺序渲染时间线）", () => {
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    expect(d.versions[0].version).toBe(d.currentVersion);
  });
});

describe("changelog.json · 不含内网地址（会随站点发到公网）", () => {
  // 只匹配真正的地址形态：commit 描述里出现「gitlab」这个词本身无害，
  // 有害的是可访问的内网主机名/IP。用地址形态而非关键词做判定，避免误报。
  test("无 http(s) URL", () => {
    const raw = readFileSync(DATA_PATH, "utf8");
    const urls = raw.match(/https?:\/\/[^\s"\\]+/g) ?? [];
    expect(urls).toEqual([]);
  });

  test("无内网主机名与私网 IP", () => {
    const raw = readFileSync(DATA_PATH, "utf8");
    expect(raw).not.toMatch(/gitlab\.[a-z0-9.-]+\.(cc|com|cn|net|local)/i);
    expect(raw).not.toMatch(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/);
  });
});

describe("容器页与全站搜索隔离", () => {
  test("changelog.md 标了 search: false（否则 commit 描述冲垮全站搜索）", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src.startsWith("---")).toBe(true);
    const fm = src.slice(0, src.indexOf("\n---", 3));
    expect(fm).toMatch(/^search:\s*false\s*$/m);
  });

  test("changelog.md 挂载了 <Changelog /> 组件", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toContain("<Changelog />");
  });

  test("changelog.md 不含 commit 列表正文（内容只有一份，在 JSON 里）", () => {
    // 若哪天有人把版本块又手写回 md，这条会红。判据：md 里不该出现 vX.Y.Z 标题
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).not.toMatch(/^##\s+v\d+\.\d+\.\d+/m);
  });

  test("config.ts 的 _render 钩子先 render 再判断 frontmatter", () => {
    // 顺序颠倒是个静默失效：env.frontmatter 由 md.render 回填，渲染前读恒为
    // undefined，排除逻辑直接不生效（实测索引里照旧留下 4 条 /changelog 条目）。
    const src = readFileSync(CONFIG_PATH, "utf8");
    const hook = src.slice(src.indexOf("_render(src, env, md)"));
    const renderAt = hook.indexOf("md.render(src, env)");
    const checkAt = hook.indexOf("search === false");
    expect(renderAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(-1);
    expect(renderAt).toBeLessThan(checkAt);
  });

  test("_render 不用 md.renderAsync（当前锁定的 vitepress 1.6.4 上不存在该 API）", () => {
    const src = readFileSync(CONFIG_PATH, "utf8");
    // 注释里提到这个名字是允许的（有一条警告注释），这里只禁止真实调用
    expect(src).not.toMatch(/await\s+md\.renderAsync\s*\(/);
  });
});

describe("CHANGELOG.html · 跳转页而非自建 mini 站", () => {
  test("是跳转页：含 meta refresh 指向 /changelog", () => {
    const html = readFileSync(HTML_PATH, "utf8");
    expect(html).toMatch(/http-equiv=["']refresh["']/i);
    expect(html).toContain("/changelog");
  });

  test("不再是 mini 站：体积远小于旧版、无搜索/分组交互", () => {
    const html = readFileSync(HTML_PATH, "utf8");
    // 旧版自带 300+ 行内联 CSS/JS，约 120K；跳转页应在 4K 以内
    expect(html.length).toBeLessThan(4096);
    expect(html).not.toContain("--sid-brand");
  });

  test("不含内网地址", () => {
    const html = readFileSync(HTML_PATH, "utf8");
    expect(html).not.toMatch(/gitlab\.[a-z0-9.-]+\.(cc|com|cn|net|local)/i);
  });
});

describe("组件与数据的耦合点", () => {
  test("组件静态 import 的路径与生成器的输出路径一致", () => {
    const vue = readFileSync(COMPONENT_PATH, "utf8");
    expect(vue).toContain('from "../data/changelog.json"');
  });

  test("生成器写入的正是组件读取的那个文件", () => {
    const gen = readFileSync(resolve(ROOT, "scripts/generate-changelog.ts"), "utf8");
    expect(gen).toContain('website/.vitepress/data');
    expect(gen).toContain('"changelog.json"');
  });
});
