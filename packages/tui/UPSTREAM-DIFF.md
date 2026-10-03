# 相对上游 ink 的差异日志

新渲染底座 `packages/tui/` 以上游 [`vadimdemedes/ink`](https://github.com/vadimdemedes/ink) 为起点（B9 / D-1）。

## 上游基线

| 项 | 值 |
| --- | --- |
| 版本 | `ink@7.1.1`（MIT，许可全文见同目录 `LICENSE`，原样保留） |
| tag 对象 | `46db5c7499a414e40799f18258a90c4fb1d01cb2`（`refs/tags/v7.1.1`，annotated） |
| 指向的 commit | `70af033dbd2b126a16f144164685612b2c1fd554`（`refs/tags/v7.1.1^{}`） |
| 导入范围 | 上游 `src/` 全部 62 个文件 → `packages/tui/src/`；`license` → `LICENSE` |

导入提交里 `packages/tui/src/` 与上游 tag 的 `src/` 逐字节一致，可复核：

```bash
git clone --depth 1 --branch v7.1.1 https://github.com/vadimdemedes/ink.git /tmp/ink-v711
diff -r /tmp/ink-v711/src packages/tui/src   # 导入提交上应无输出
```

`packages/tui/src` 已从 oxfmt 与本仓 `.editorconfig` 风格中排除（上游是 xo / tab 风格），
否则 pre-commit 一格式化，就不再和上游一致。

## 差异表

每个相对上游的改动记一行。契约 ID 见 `SPEC.md`（T1.1 时仍在 `packages/cli/src/ui/render-port/SPEC.md`）。

| 提交 | 文件 | 改了什么 | 为什么 | 契约 ID |
| --- | --- | --- | --- | --- |
