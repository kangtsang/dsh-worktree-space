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

## 4. 文件命名

**多词文件名一律 kebab-case**：一个短横线，不是驼峰也不是下划线。

| 目录 | 写法 | 例子 |
| --- | --- | --- |
| `src/**` | kebab-case | `scan-cache.js`、`config-preview.ts`、`repository-glyph.ts`、`audit-log.js` |
| `test/**` | kebab-case | `create-flow.test.tsx`、`audit-log.test.mjs`、`recover-codes.test.mjs` |
| `src/client/components/**` | PascalCase（组件） | `WorktreePanel.tsx`、`PluginConfigCard.tsx` |

`test/` 本来就是这个规则；`src/` 里原先混着 `scanCache.js`、`configPreview.ts` 这样的驼峰，已统一成 kebab-case。
**组件文件的 PascalCase 不在本次范围内**，保持不变。

命名一律小写开头；短横线不重复，也不出现在开头或结尾。

## 5. 起了验收实例就要把地址给我

用 `dev-docs/dsh-worktree-space/acceptance/start-acceptance.ps1` 起实例之后，**必须把访问地址贴出来**，
否则这个实例等于没起——它只是个后台进程，我看不见。

地址直接读 `<CaseRoot>\case.env` 的 `URL=`，不要等后台任务的输出回传：那个回传会被打断，而 `case.env`
是脚本自己写的、可重复读的落盘结果。贴地址时一并给出这轮要验的点，别让人自己猜。

**启动脚本一律后台跑，不要用带超时的等待调用去阻塞。** 等一个设置超时的调用会把整轮对话卡住：
中途一旦有新消息打断，这次等待就作废、输出也没拿到，于是要再捞一次，来回两三轮才把地址交出去。
正确顺序是：后台启动 → 先告诉用户「正在起」→ 该期间做别的事（核对代码、准备验收清单）→
真要结果时再读一次 `case.env`。

「改文案/改样式 → 重建 → 重新打包 → 重启实例」是一整串，**中间任何一步漏掉，页面上看到的还是旧版本**，
而且看起来完全正常——已改的源码就在工作区里，只是没进产物。已经栽过两次：
一次是改了 i18n 就转去写别的，改完没 build 就打包；
一次是 bundle 里中文被转成 `\uXXXX`，用字面量搜「打开」搜不到，误以为构建没生效。
校验构建产物要用转义形式或直接读 `case.env`，别用字面量搜中文。
