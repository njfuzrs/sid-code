---
title: 更新日志
description: 每个版本的变更记录，从 git 历史自动生成，带独立搜索与分类筛选。
# 本页有自己的搜索框（只搜版本变更），不进全站索引 —— 否则几百条 commit 描述
# 会把「搜 hook」「搜权限」这类正常查询冲成一片版本噪音。
# 执行方在 .vitepress/config.ts 的 search.options._render 钩子。
search: false
# 版本号是 h2，几十个版本会生成一条几十项的大纲，不如页内搜索好用
outline: false
---

# 更新日志

变更记录由发布流程（`scripts/release.sh`）在每次发版时从 git 历史重新生成，
按新功能 / 修复 / 重构 / 性能 / 文档分组。git 历史是唯一事实源，本页是它的渲染视图。

<Changelog />

## 其它形态

- **纯文本版**：[CHANGELOG.md](https://www.sid-code.cc/releases/sid-code/CHANGELOG.md) —— 便于 diff、`curl`、脚本处理
- **本机查看**：仓库根 `CHANGELOG.md` 与发布产物同源

## 查看与升级

```bash
sid-code --version    # 当前装的是哪个版本
sid-code update       # 升级到最新版
```

## 相关

- [安装](/start/install) —— 首次安装
- [从 Claude Code 迁移](/team/migrate) —— 配置与用法的对应关系
