---
title: 更新日志
description: 每个版本对用户有什么变化，按新功能/改进/修复/破坏性变更分类，带独立搜索。
# 本页有自己的搜索框（只搜版本变更），不进全站索引 —— 否则几百条变更描述
# 会把「搜 hook」「搜权限」这类正常查询冲成一片版本噪音。
# 执行方在 .vitepress/config.ts 的 search.options._render 钩子。
search: false
# 版本号是 h2，几十个版本会生成一条几十项的大纲，不如页内搜索好用。
# 而「有哪些版本、各在什么时候」现在由左侧时间线回答（.vitepress/changelog-meta.ts），
# 右侧大纲会是它的重复项。
outline: false
# 关掉页脚的上一页/下一页 —— 必须显式关，实测不关会渲染出一条**指向本页自己**的
# 「下一页 → v0.1.600」。成因：pager 的候选来自 sidebar（prev-next.js），
# 它虽然用 uniqBy 按 `link.replace(/[?#].*$/, '')` 把 19 条锚点去重成 1 个候选，
# 但 `isActive` 对带 hash 的 link 要比对 location.hash —— SSR 期没有 location、
# 落地时 hash 也为空，于是 findIndex 返回 -1，`candidates[index + 1]` 正好取到
# 第 0 个候选。左栏时间线本身就是这一页的导航，页脚 pager 在这里没有意义。
prev: false
next: false
---

# 更新日志

<!--
  ⚠ 标题下**不写导读**，正文直接是 <Changelog />，别再加回来。
  删掉的三句分别在解释「左边是什么、右边是什么」「这里只收用户可感知的改动」
  「全量提交在下面」—— 前两句描述的是读者往下一眼就能看到的界面本身，
  第三句是给一个已经删掉的章节做的指路。导读只在读者看不出结构时才有价值。

  同理删掉了原「## 其它形态」（指向 releases/CHANGELOG.md 纯文本版与仓库根文件）：
  这一页的读者是**用户**，commit hash / 模块 scope 是开发者视角的东西，
  放在用户视角的页面末尾属于选错受众。CHANGELOG.md 仍然照常生成、照常随发布上传，
  链接没死，只是不在这一页上占位（生成职责见 CLAUDE.md 的 changelog 三产物表）。
-->

<Changelog />

## 查看与升级

```bash
sid-code --version    # 当前装的是哪个版本
sid-code update       # 升级到最新版
```

## 相关

- [安装](/start/install) —— 首次安装
- [从 Claude Code 迁移](/team/migrate) —— 配置与用法的对应关系
