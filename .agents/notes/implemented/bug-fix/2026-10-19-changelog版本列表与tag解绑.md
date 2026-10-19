---
Status: implemented
Date: 2026-10-19
---
# changelog 版本列表改认 bump 提交，不再跟随 git tag

## 决定了什么

`scripts/lib/changelog-git.ts` 新增 `listReleaseAnchors()`：从 HEAD 可达历史里找 `bump vX.Y.Z` 提交，作为已发布版本的锚点，取代原来的 `listSemverTags()` 和 `tagDate()`。版本区间改为「上一锚点..本锚点」，日期取 bump 提交日。`generate-changelog.ts`、`changelog-curate.ts`、`changelog-stable.ts` 全部改用锚点。tag 只留给发布、Release 和 promote 门禁用。

起因：PR #304 为下架旧渲染底座，撤回了 v0.1.607 及更早的 tag 和 Release。旧生成器按 `git tag -l` 遍历版本，于是 v0.1.611 发版时，官网 /changelog 从 29 版掉到 4 版，`CHANGELOG.md` 同样只剩 4 版。生成、站点构建、冒烟全部是绿的。tag 是「版本还在不在架上」，changelog 是「版本发生过什么」，两件事生命周期不同，不该绑在一起。

## 放弃了什么（以及为什么不选）

- **把旧 tag 恢复回来**：本地 unreachable 对象里还能捞到旧 tag 对象，但撤 tag 是刻意的下架决定，恢复等于推翻 PR #304。而且下次再撤 tag，问题还会重演。
- **入库一份版本清单 `changelog/releases.json`，由 release.sh 追加**：多一份要手工维护的状态，还会和 git 历史漂移。bump 提交本来就是 release.sh 自动产出、落在受保护 main 上的不可变事实，用它做锚点不需要新增状态。
- **以 curated 文件为版本列表**：curated 可能缺失（脚本设计上缺失只 warn），缺一个文件就会丢一个版本块，判据不可靠。
- **沿用 tag 提交作锚点**：v0.1.582–v0.1.597 的旧 tag 打在 bump 的父提交上（历史上的「错位一位」）。改用 bump 提交后，这 16 个版本的区间只是整体平移一条，前后版本间不丢不重。下面的逐版比对证明官网数据不变。

代价：`bump vX.Y.Z` 提交成了 changelog 的唯一锚点，main 上不能改写或删除它们。这一点已写进 `scripts/RELEASE.md`。

## 拿什么证明它生效了

- `bun run scripts/generate-changelog.ts 0.1.611` → `changelog.json（30 版本 / 417 条 curated 文案）`，修复前是 4 版本 / 95 条。`CHANGELOG.md` 恢复为 30 个版本块。
- 与删 tag 前的产物 `fc3d48f8:website/.vitepress/data/changelog.json` 逐版比对（去掉 channel 字段）：29 个历史版本只差 1 行，是 PR #304 有意改过的「新底座」措辞。`CHANGELOG.md` 的差异也全部来自 PR #304 登记的改写表。
- 30 个锚点提交逐个核验：都在 main 上，日期与原官网显示一致。
- 新增回归测试：「每份 curated 都出现在官网数据里」和「区间算法不读 tag」。变异自证：把 `listReleaseAnchors` 改回按 `git tag -l` 过滤，生成器产出 4 版本，两条断言都变红；恢复后 46/46 通过。
