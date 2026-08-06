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
import { execFileSync } from "node:child_process";
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

describe("changelog.json · 版本区间不漏提交（回归：补跑会清空当前版本）", () => {
  /**
   * 2026-08-06 实测的静默数据丢失：`buildModel` 一边用 `tags[0]..HEAD` 算「正在发布」
   * 区间，一边在历史循环里以 `version === currentVersion` 跳过同名 tag。当该 tag
   * **已存在**（tag 打完后补跑、或 --no-bump 复用版本号）时，tags[0] 就是它自己，
   * 于是它真正的提交两头都不认，彻底消失——changelog 从 276 条掉到 267 条，
   * 且**没有任何报错**（产物只是站点数据源，少几条无人察觉）。
   *
   * 这里不重跑生成脚本（那要动仓库产物），而是对**已入库的产物**验一条不变式：
   * 每个非 genesis 版本的 commit 数，应与该 tag 区间的真实提交数吻合。
   * 这条不变式对上面那个 bug 是敏感的：bug 会让当前版本的 count 变成
   * 「tag 之后的提交数」，与真实区间对不上。
   */
  test("每个版本的 commit 数与其 tag 区间的真实提交数吻合", () => {
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    const tags: string[] = execFileSync("git", ["tag", "-l", "v*", "--sort=-v:refname"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    let checked = 0;
    for (const v of d.versions) {
      if (v.isGenesis) continue; // genesis 块刻意截断回溯条数，不适用此不变式
      const tag = `v${v.version}`;
      const idx = tags.indexOf(tag);
      if (idx < 0) continue; // 尚未打 tag 的「正在发布」版本，无法比对
      const prevTag = tags[idx + 1];
      if (!prevTag) continue;

      // 真实区间提交数，扣掉生成器刻意过滤的噪声（bump / Merge / dashboard 刷盘）
      const subjects = execFileSync(
        "git",
        ["log", "--format=%s", `${prevTag}..${tag}`],
        { cwd: ROOT, encoding: "utf8" },
      )
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const real = subjects.filter(
        (s) =>
          !/^bump\s+v?\d/i.test(s) &&
          !/^Merge\s/i.test(s) &&
          !/^ci(?:\([^)]*\))?\s*[:：]\s*refresh dashboard/i.test(s),
      ).length;

      expect(v.count).toBe(real);
      checked++;
    }
    // 防止不变式因为 continue 全部跳过而变成空断言（那就成了假绿）
    expect(checked).toBeGreaterThan(0);
  });

  test("版本日期与其 tag 的提交日一致（不受生成时机/时区影响）", () => {
    // today() 走 toISOString()（UTC），本地 +0800 的凌晨会算成前一天。
    // 版本日期必须锚在 tag 的提交日上，否则同一个版本在不同时刻生成会得到不同日期。
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    let checked = 0;
    for (const v of d.versions) {
      const tag = `v${v.version}`;
      let tagDay: string;
      try {
        tagDay = execFileSync(
          "git",
          ["log", "-1", "--format=%ad", "--date=format:%Y-%m-%d", tag],
          { cwd: ROOT, encoding: "utf8" },
        ).trim();
      } catch {
        continue; // 尚未打 tag
      }
      if (!tagDay) continue;
      expect(v.date).toBe(tagDay);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
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

describe("独立搜索的匹配语义", () => {
  // 复刻组件里的匹配逻辑（Changelog.vue 的 haystack + commitMatches）。
  // 组件是 .vue 单文件、无法在 bun test 里直接 import 其内部函数，
  // 所以这里锁的是**语义契约**：改组件逻辑时两边要一起改，否则这些断言会红。
  const hay = (c: any) =>
    [c.scope ?? "", c.desc, c.hash, ...c.details].join(" ").toLowerCase();
  const matches = (c: any, terms: string[]) =>
    terms.length === 0 || terms.every((t) => hay(c).includes(t));
  const parse = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);

  function allCommits() {
    const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    const out: any[] = [];
    for (const v of d.versions) for (const g of v.groups) out.push(...g.commits);
    return out;
  }

  test("多词是 AND 而非整串子串匹配", () => {
    // 这是改造中真实踩到的缺陷：整串匹配要求两个词在原文里紧邻，
    // 而 changelog 的词通常散落在描述与细节的不同位置，用户输两个词一条不中。
    const commits = allCommits();
    const term1 = "缓存";
    const term2 = "命中";
    const andHits = commits.filter((c) => matches(c, [term1, term2])).length;
    const substringHits = commits.filter((c) =>
      hay(c).includes(`${term1} ${term2}`),
    ).length;
    expect(andHits).toBeGreaterThan(0);
    expect(andHits).toBeGreaterThan(substringHits);
  });

  test("空查询与纯空白查询返回全部", () => {
    const commits = allCommits();
    expect(commits.filter((c) => matches(c, parse(""))).length).toBe(commits.length);
    expect(commits.filter((c) => matches(c, parse("   "))).length).toBe(commits.length);
  });

  test("搜 hash 能命中（提交条目显示 hash，用户会拿它搜）", () => {
    const commits = allCommits();
    const withHash = commits.find((c) => c.hash);
    expect(withHash).toBeDefined();
    expect(matches(withHash, parse(withHash.hash))).toBe(true);
  });

  test("搜 scope 能命中，且跨字段与描述词组合有效", () => {
    const commits = allCommits();
    const withScope = commits.find((c) => c.scope && c.desc.length > 4);
    expect(withScope).toBeDefined();
    expect(matches(withScope, parse(withScope.scope))).toBe(true);
    // scope 与描述里的词组合 —— 这是拼成整段 haystack 才能支持的场景
    const firstWord = withScope.desc.slice(0, 2);
    expect(matches(withScope, [withScope.scope.toLowerCase(), firstWord.toLowerCase()])).toBe(true);
  });

  test("不存在的词返回 0（无结果态有兜底 UI）", () => {
    expect(allCommits().filter((c) => matches(c, parse("zzz-不存在-zzz"))).length).toBe(0);
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

/**
 * 左栏「版本时间线」（website/.vitepress/changelog-meta.ts）。
 *
 * 这一层的故障**全都是静默的** —— 左栏少一个版本、锚点对不上、sidebar key 被删掉，
 * 页面都照旧渲染、构建照旧成功、状态码照旧 200。所以必须靠断言钉住。
 */
describe("左栏版本时间线", () => {
  // 静态 import 会让本文件依赖构建期 JSON 的存在性，与上面的用例一致（同一份数据源）
  const { CHANGELOG_SIDEBAR, buildTimeline, versionAnchor } = require(
    resolve(ROOT, "website/.vitepress/changelog-meta.ts"),
  );
  const data = () => JSON.parse(readFileSync(DATA_PATH, "utf8"));

  test("分组条数之和等于版本总数（漏版本是静默缺陷：左栏少一条没人会发现）", () => {
    const total = CHANGELOG_SIDEBAR.reduce(
      (n: number, g: any) => n + g.items.length,
      0,
    );
    expect(total).toBe(data().versions.length);
  });

  test("只有第一组（最新月）展开，其余折叠", () => {
    expect(CHANGELOG_SIDEBAR.length).toBeGreaterThan(0);
    expect(CHANGELOG_SIDEBAR[0].collapsed).toBe(false);
    for (const g of CHANGELOG_SIDEBAR.slice(1)) {
      expect(g.collapsed).toBe(true);
    }
  });

  test("组标题带条数，且与该组实际条目数一致", () => {
    for (const g of CHANGELOG_SIDEBAR) {
      expect(g.text).toMatch(/^\d{4} 年 \d{1,2} 月（\d+）$/);
      const declared = Number(/（(\d+)）$/.exec(g.text)![1]);
      expect(declared).toBe(g.items.length);
    }
  });

  test("组顺序与组内顺序都是最新在前（左栏顺序必须与正文一致）", () => {
    const flat = CHANGELOG_SIDEBAR.flatMap((g: any) => g.items).map(
      (i: any) => i.link.replace("/changelog#v", ""),
    );
    expect(flat).toEqual(data().versions.map((v: any) => v.version));
  });

  test("每条 link 形如 /changelog#v<semver>", () => {
    for (const g of CHANGELOG_SIDEBAR) {
      for (const item of g.items) {
        expect(item.link).toMatch(/^\/changelog#v\d+\.\d+\.\d+$/);
      }
    }
  });

  /**
   * 锚点对不上是这个设计**唯一的致命故障**：左栏能点、URL 会变、页面不动，
   * 而且不报任何错。两侧必须同源 —— 组件用 versionAnchor() 生成 :id，
   * changelog-meta.ts 用同一个函数生成 link 的 hash 部分。
   */
  test("组件的 :id 与左栏 link 的 hash 同源（都走 versionAnchor）", () => {
    const vue = readFileSync(COMPONENT_PATH, "utf8");
    expect(vue).toContain('versionAnchor } from "../changelog-meta"');
    expect(vue).toContain(':id="versionAnchor(v.version)"');
    // 禁止退回手拼字符串（曾经是 :id="`v${v.version}`"）——那样两侧就各拼一套了
    expect(vue).not.toContain(":id=\"`v${v.version}`\"");
    expect(versionAnchor("0.1.600")).toBe("v0.1.600");
  });

  test("sidebar 里配了 /changelog 这个 key，且不带尾斜杠", () => {
    // 这条 key 被删掉就退回到本次改造前的原始缺陷：getSidebar 前缀匹配失败 →
    // hasSidebar=false → 全站唯一一页没有左栏、宽度也与别的页不同。
    // 症状只是「看起来窄了点」，不会有任何报错，所以必须有回归防线。
    const src = readFileSync(CONFIG_PATH, "utf8");
    expect(src).toMatch(/"\/changelog":\s*CHANGELOG_SIDEBAR/);
    // 尾斜杠版本永远匹配不上：这一页的 relativePath 是 changelog.md，不是目录
    expect(src).not.toMatch(/"\/changelog\/":/);
    expect(src).toContain('from "./changelog-meta"');
  });

  test("容器页显式关掉 pager（否则会渲染出指向本页自己的「下一页」）", () => {
    // 实测：prev-next.js 的 uniqBy 把 19 条锚点去重成 1 个候选，但 isActive 对带
    // hash 的 link 要比对 location.hash，SSR 期没有 location → findIndex 返回 -1
    // → candidates[index + 1] 正好取到第 0 个候选，于是「下一页 → v0.1.600」
    // 指回本页。必须在 frontmatter 显式关。
    const src = readFileSync(PAGE_PATH, "utf8");
    const fm = src.slice(0, src.indexOf("\n---", 3));
    expect(fm).toMatch(/^prev:\s*false\s*$/m);
    expect(fm).toMatch(/^next:\s*false\s*$/m);
  });

  test("buildTimeline 用字符串切片分月，不受时区影响", () => {
    // 用 new Date() 解析 YYYY-MM-DD 在 UTC+8 会把月初退回上个月。
    // 这里直接验边界：8 月 1 日必须归到 8 月。
    const groups = buildTimeline([
      { version: "9.9.9", date: "2026-08-01" },
      { version: "9.9.8", date: "2026-07-31" },
    ]);
    expect(groups.map((g: any) => g.text)).toEqual([
      "2026 年 8 月（1）",
      "2026 年 7 月（1）",
    ]);
  });
});
