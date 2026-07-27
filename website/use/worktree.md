---
title: Worktree 隔离
description: 在独立 worktree 里干活，含 symlink node_modules 的跨分支 lockfile 风险。
---

# Worktree 隔离

::: warning 本页待撰写
内容排期在阶段 5（T-5.4）。当前是占位页——先建出来是因为站点导航已声明这条链接，
而构建期死链检测是发布门禁（`ignoreDeadLinks: false`），页面缺失会直接让构建失败。
:::

在独立 worktree 里干活，含 symlink node_modules 的跨分支 lockfile 风险。

## 相关

- [sid-code 是什么](/start/)
- [安装](/start/install)
