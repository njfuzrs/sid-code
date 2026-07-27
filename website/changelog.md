---
title: 更新日志
description: 每个版本的变更记录，从 git 历史生成，不在本站重复维护。
---

# 更新日志

变更记录由发布流程（`scripts/release.sh`）在每次发版时从 git 历史重新生成，
按 feat / fix / refactor / perf / docs 分组，两份产物：

- **[网页版 CHANGELOG.html](http://121.196.144.227/releases/sid-code/CHANGELOG.html)** —— 推荐。含 commit 细节展开、分组徽章、搜索过滤
- **[文本版 CHANGELOG.md](http://121.196.144.227/releases/sid-code/CHANGELOG.md)** —— 纯文本，便于 diff 与脚本处理

本页刻意**不重复实现**变更列表：它已经有一份从 git 生成的权威渲染视图，
在两处维护同一份内容只会产生不一致。

## 查看当前装的是哪个版本

```bash
sid-code --version
```

## 升级到最新版

```bash
sid-code update
```

## 相关

- [安装](/start/install) —— 首次安装
- [从 Claude Code 迁移](/team/migrate) —— 配置与用法的对应关系
