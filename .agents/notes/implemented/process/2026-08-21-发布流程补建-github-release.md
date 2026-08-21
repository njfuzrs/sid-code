---
Status: implemented
Date: 2026-08-21
---
# 发布流程补上「建 GitHub Release」这一步，正文取自 curated 文案

## 决定了什么

**这一步以前根本不存在。** `release.sh` 里 `gh release` 零命中，六个 workflow 也都没有。
仓库现有的 `v0.1.591`…`v0.1.600` 那 10 个 Release **全部创建于 2026-08-13T02:22 那两分钟内**
（时间戳间隔 2 秒）—— 开源首发时一次性人工回填，之后每次发版 tag 都推了、Release 却没人建。

后果是 GitHub 仓库首页把最新 Release 当作「当前版本」展示，于是 v0.1.601 已经上线、
`latest.txt` 已经是 `0.1.601`、官网 changelog 也更新了，而 GitHub 上仍显示
`v0.1.600 Latest`。**没有任何报错，只是页面上的版本号是错的。**

三处改动：

1. **新增 `scripts/github-release.ts`**：从 `changelog/curated/v<version>.json` 渲染 Release
   正文（形态照抄 v0.1.600 那个已有的：加粗 highlight → `### 分组` → `---` → 链接 + 安装命令），
   `--create` 才真建，默认只打印（干跑）。幂等：已存在则跳过，`--force` 才覆盖。
2. **`release.sh` 在 push tag 之后调它**。必须在 tag 推送之后 —— Release 挂在 tag 上，
   tag 不在远端时 `gh` 会**自建一个指向默认分支 HEAD 的 tag**，Release 就指向错误提交
   且不报错（脚本里另有一道显式 `git/ref/tags` 检查兜这个）。
   未装 `gh` 或建失败一律 `warn` 不阻断：制品此刻已上线且 sha256 校验过了。
3. **补 v0.1.601 这个空缺**，并加 9 条契约断言防复发。

## 放弃了什么（以及为什么不选）

**① 正文取 `CHANGELOG.md` —— 否决。** 那是全量原始提交（含 hash、含 docs/chore 分组），
读者是 diff 与脚本。Release 页读者是**用户**，与官网 /changelog 同一批人。
回填那 10 个 Release 时用的也是 curated 那套分组（对照 v0.1.600 的 body 可见），
保持同一个事实源。

**② 在 `release.sh` 里用 jq 拼正文 —— 否决。** 要读 JSON、按受控词表排序、做 URL 脱敏，
而 `changelog-curated-schema.ts` 已经有 `toRenderSections` / `validateCurated`。
在 shell 里重写等于开第二套实现，而分叉的症状是「官网分组顺序与 Release 页不一致」，
且完全静默。

**③ 把 4 平台制品作为 assets 上传 —— 否决。** 制品发在自建服务器
（`PUBLIC_BASE_URL/releases/sid-code/`），现有 10 个 Release 的 assets 都是 **0 个**。
两处都放二进制会出现「用户从 GitHub 下到一个版本、`install.sh` 装到另一个」的双轨问题。

**④ 建 Release 失败就 `fail` 阻断 —— 否决。** 走到这一步制品已经上线且校验过了，
一个没建成的 Release 页不该让整次发布判定为失败（手动补跑一行就行）。
断言里为此留了一条**反向断言**：这一段不许出现 `|| fail`。

## 拿什么证明它生效了

**变异自证**（这是关键，不是「机理讲得通」）：把 `release.sh` 里那两行调用整段删掉
——即缺口的原始形态——契约断言 **2 条报红**（`--upload 路径会调 github-release.ts`、
`建 Release 在 push tag 之后`），还原后 **49 pass / 0 fail**。

写断言时踩到一个真实的假红：`posOf("scripts/github-release.ts")` 命中的是我加在
**文件头注释**里的那处提及（偏移 2260），而 push tag 在 32228 —— 顺序断言直接假红。
改成锚在可执行形态 `--create \` 上。**这类断言必须锚在代码而非文档提及。**

**真实建成**：`bun run scripts/github-release.ts 0.1.601 --create` → `✅ 已创建`；
`gh release list` 显示 **`v0.1.601  Latest`**（原先停在 v0.1.600）。
tag 解引用核对：远端 tag 对象 `3ad6b688` → 解引用到 **`7b5005bf`** = 本地
`git rev-list -n1 v0.1.601` = `bump v0.1.601` 提交，**指向正确**。tarball HTTP **200**。

**幂等**：再跑一次 → `⏭ 已存在，跳过`。顺带修掉一处输出杂音：`releaseExists` 探测
不存在时 `gh` 往 stderr 打 `release not found`，会让终端出现一行看着像错误、
紧跟又是「✅ 已创建」的输出 —— 已用 `stdio: [_, _, "ignore"]` 吞掉。

**门禁**：`bash -n scripts/release.sh` 语法 OK；`tests/release-flow-contract.test.ts`
**49 pass / 0 fail**。
