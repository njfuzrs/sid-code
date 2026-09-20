---
Status: implemented
Date: 2026-09-20
---
# GitHub 默认 README 改回中文，英文副本落到 README.en.md

## 决定了什么

仓库根 `README.md` 改回中文（GitHub 仓库页只渲染这个文件名）。英文全文挪到 `README.en.md`，顶部语言切换两边互链。顺带把「三处数字须一致」注释从「README.md 是英文主入口」改成「README.md 是中文主入口、README.en.md 是英文副本」（`website/.vitepress/theme/HomeShowcase.vue`、`website/.vitepress/config.ts`）。

兄弟仓库（`agent-backend` / `claude-trace` / `agent-traj-bench`）的 GitHub 默认页都是中文；本仓工作语言、文档站、源码注释也是中文。P2-6 把英文放到 `README.md` 是为英语读者，结果默认页和兄弟仓、和本仓真实工作语言全拧了。

## 放弃了什么（以及为什么不选）

- **删掉英文副本、只留中文 README。** 否决：英文读者仍能用 CLI，贡献者需要提前知道「注释和文档是中文」——英文副本顶部那段 language note 就是干这个的，删了等于把提醒藏起来。
- **继续用 `README.zh-CN.md` 当中文、`README.md` 当英文。** 否决：GitHub **不会**按界面语言自动选 `README.<locale>.md`（那是社区讨论了多年的未落地需求）。默认页永远是 `README.md`。要让仓库页展示中文，只能把中文放进这个文件名。
- **把英文叫 `README.zh-CN.md` 的镜像命名（例如只改内容不改文件名）。** 否决：文件名还写着英文是默认、中文是附件，和事实相反，下一个 agent 会按文件名再改回去。

## 拿什么证明它生效了

- `head -12 README.md` 第一屏是中文，语言切换指向 `./README.en.md`。
- `head -12 README.en.md` 语言切换指向 `./README.md`；正文仍是英文。
- 工作区不再有 `README.zh-CN.md`（`ls README*` 只有 `README.md` 与 `README.en.md`）。
- `rg 'README\.zh-CN' --glob '!CHANGELOG.md'` 只剩 README.md 注释里那句历史记录（P2-6 曾经的文件名），没有活链接。
- GitHub 仓库页在本 PR 合入 `main` 之后才会切；合入后打开 https://github.com/njfuzrs/sid-code 应直接看到中文 README。
