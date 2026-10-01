# dsh-worktree-space 仓库约定

本文件对在本仓库工作的所有会话生效。与全局规则（`$DSH_HOME/AGENTS.md`）冲突时，**更严格的优先**；拿不准按更严格的那条执行，或者直接问维护者。

本仓库目前由单一维护者维护，因此约定可以随时调整。

## 1. 推送与发版

**推送永远由维护者手动执行。** 未经逐次明确许可，不得执行任何远端写操作（`git push` 任意 refspec 含强推/删远端分支/删标签、`gh`/`glab` 的 PR/Issue 操作、`npm publish` 等）。

**推 tag 等于发版。** 本仓库的 `.github/workflows/publish.yml` 由 `v*` 标签触发，使用 npm OIDC 发布。工作流会断言 `tag="${GITHUB_REF_NAME#v}"` 等于 `package.json` 的 `version`，不匹配则失败。

推标签一旦发生即触发发布，**不可撤回**，所以没有许可不要推 tag。

### 措辞对照

以下说法**不构成**推送授权：

| 说法 | 实际含义 |
| --- | --- |
| 「改完不要提交」 | 不要 `git commit` |
| 「分类提交」 | 只 `git commit`，**不 push** |
| 「打 tag」 | 只在本地 `git tag`，**不 push** |
| 「最后推送由我手动操作」 | 由维护者自己推 |

没明说时，默认停在本地。

## 2. 验收脚本

`package.json` 里有四条 `acceptance:*` 脚本，入口在 `scripts/acceptance/`。它们会在受控沙箱里安装、启动并回滚多个 DSH 版本，涉及大量递归删除操作。

改动这些脚本前，先读 `scripts/acceptance/README.md`，特别是其中的删除范围约束。

全局规则要求任何删除路径都经过机器校验；本仓库的落地要求是：

- 任何递归删除都必须先通过 `Assert-Under` → `Assert-DirectChild` → `Assert-Deletable`，另加 reparse point 检查
- 删除目标只能是 `<RunRoot>\homes\home-<版本>` 和 `<RunRoot>\logs\log-<版本>`，且必须是直接子目录、名字精确匹配
- 全脚本禁止通配符递归删除
- 改完守卫后必须跑 `guard-tests.ps1`，它打印 `GUARD-OK` / `GUARD-FAIL` 且自身不删除任何东西

`.ps1` 文件遵守全局的编码规则：**正文只用 ASCII**，中文注释会导致乱码。

## 3. 兼容性声明

`package.json` 的 `dsh.compatibility.dshReleases` 是一个**对象**，键是 DSH 版本号、值是兼容性标记。写脚本读取它时必须用 `.PSObject.Properties.Name` 取键；用 `@($obj)` 会得到一个包着整个对象的单元素数组，插值出来形如 `@{0.1.7-rc.1=compatible; ...}`，导致 npm 报 `EINVALIDTAGNAME`。

同时注意版本排序：预发布后缀不能剥掉再排，`rc.1` 和 `rc.2` 剥掉后排序键相同，"从新到旧"就失效了。