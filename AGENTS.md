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

用 `scripts/acceptance/start-acceptance.ps1` 起实例之后，**必须把访问地址贴出来**，
否则这个实例等于没起——它只是个后台进程，我看不见。

地址直接读 `<CaseRoot>\case.env` 的 `URL=`，不要等后台任务的输出回传：那个回传会被打断，而 `case.env`
是脚本自己写的、可重复读的落盘结果。贴地址时一并给出这轮要验的点，别让人自己猜。

**启动验收实例一律派子 agent 做，不要在主会话里跑。**

打包、装 tarball、建 profile、启动 web、等端口起来，这一串要一分多钟。它和主会话要答的问题没有关系，
而主会话被它占住的时候你发什么我都只能等。派单之后主会话立刻回到手上的活，地址由子 agent 读 `case.env`
交回来；子 agent 是后台的，不占主会话。

子 agent 交回来的必须包含：`URL=`（含 token 的完整地址）、`CONTAINER_ROOT=`、以及 PID。
主会话拿到后贴地址 + 列这轮要验的点，两件事一起做，不要等下一次才补。

**主会话里不要用带超时的等待调用去等这个流程。** 等一个设置超时的调用会把整轮对话卡住：
中途一旦有新消息打断，这次等待就作废、输出也没拿到，于是要再捞一次，来回两三轮才把地址交出去。
正确顺序是：派单 → 告诉用户「正在起」→ 该期间做别的事（核对代码、准备验收清单）→
真要结果时读一次 `case.env` 或 `job_output`。

「改文案/改样式 → 重建 → 重新打包 → 重启实例」是一整串，**中间任何一步漏掉，页面上看到的还是旧版本**，
而且看起来完全正常——已改的源码就在工作区里，只是没进产物。已经栽过三次：
一次是改了 i18n 就转去写别的，改完没 build 就打包；
一次是 bundle 里中文被转成 `\uXXXX`，用字面量搜「打开」搜不到，误以为构建没生效；
一次是排查一个已定位的 bug 时，连着三轮验收都在验同一个 14:44 的旧包——每一轮页面看起来都「正常」，
第三轮才想起来去看包里有没有今天的标识串。
校验构建产物要用转义形式，别用字面量搜中文。

**这道坑现在有守卫了**：`start-acceptance.ps1` 在 `npm pack` **之前**比较 `lib\index.js`、
`client\client.js` 与 `src\`、`client\`（除 bundle 自身）里最新文件的时间，bundle 更旧就**直接失败**，
并打印是哪个文件、该跑什么。**脚本不构建，只检查**——所以改完源码要先 `node build.mjs`。
明知这次不该带上工作区里的源码改动，用 `-SkipBuildCheck` 跳过。

判断装进去的包是不是新的，**不要看时间戳**：npm 安装时会重新盖 `package.json` 的时间，
`lib\index.js` 的时间也只有真装了新包才会变。**唯一可靠的判据是在装进去的那个文件里，
搜一个本次改动独有的标识串。**

## 6. 测试分层与入口

本仓库的测试分两层，`vitest.config.ts` 里用 `projects` 声明。分层的理由和一般规则见全局规则 §4 的「测试套件」子节，这里只记本仓库的具体事实。

| 命令 | 内容 |
| --- | --- |
| `pnpm test:unit` | 两层并发 + 各自 60 秒预算 + 合并汇总 |
| `pnpm test:unit:fast` | `unit` 层：除真实 git 外的全部 |
| `pnpm test:unit:git` | `git` 层：会真跑 git 的那些文件 |

三个入口**走同一个 runner**（`scripts/test/run-tests.mjs`），共用同一个 60 秒墙钟预算和同一份汇总输出。快捷入口也必须有预算：最需要有人拦一把的场景恰恰是手动跑单层，而 `testTimeout` 只能挡住「一个用例跑太久」，挡不住「worker 不再应答」——那种情况内存会一路涨到进程被系统杀掉。

`pnpm test` 走 `test:unit`，**跑完两层**，不会因为分层而漏测。

**这里不记用例数，也不记秒数。** 两者都是加一个测试、或者机器忙一点就变的数字，记下来只会误导：下一个拿它当基线核对的人第一件事就是发现对不上，然后得先花时间弄清是数字过期了还是哪里真的坏了——而分层要保证的那条不变量其实一条都没坏。

真正稳定、值得记的是这两条，它们随时可以自己复核：

1. **两层没有漏测。** `pnpm test:unit` 跑的用例集合必须等于不加 `--project` 的全量枚举，且两个层的文件集无重叠。改动 `vitest.config.ts` 的 `projects` 或 `include` 之后重新核一次。
2. **两层都远在 60 秒预算内。** 实测 `unit` 十几秒、`git` 二十几秒（`git` 层慢是因为每个用例都要真起一次 `git.exe`，是进程创建开销，调参解决不了）。**任何一层接近预算就是回归**，这时该查速度，而不是先调预算——调预算会把回归藏起来。

**`git` 层只有两个文件**：`test/task-merge-worktree.test.mjs` 和 `test/encoding.test.ts`。它们用 `execFileSync` 驱动真实 git，在 Windows 上单次 `git.exe` 启动几乎全是进程创建开销，所以慢得没法靠调参解决。新增真正跑进程 / 碰磁盘的测试时放进这一层，`vitest.config.ts` 顶部的 `REAL_GIT` 一行加文件名。

### `maxWorkers` 必须写在根级，不能写在 project 里

这是本仓库最容易踩的坑，而且**踩了不报错**。

`projects` 模式下，vitest 用**根配置**建 worker 池，只从每个 project 读 `name` / `environment` / `include` / `exclude`。写在 project 里的 `maxWorkers` 没有任何人读——根上没有，于是回退到 `numCpus - 1`，本机就是 **19 个 fork**，正是把 44 秒的套件跑成 16 分钟并最终 OOM 的那个配置。`poolOptions` 同理。

**怎么确认它生效了**：跑测试时数 `node --conditions node` 子进程，应当是 4 个。19 个就是没生效。`tsc` 不检查这个，`vitest` 不警告这个，只有 fork 数会告诉你。

### 为什么这套以前会卡死

崩溃发生在 vitest 打印汇总行**之前**，所以一次失败的全量跑只剩下「971 秒」这一个数字，没有任何原因——这就是「不知道为什么慢」的来源。每层的 60 秒预算（`scripts/test/run-tests.mjs`）就是为了让这种情况变成一句 `OVER BUDGET: unit exceeded 60s`，而不是一个挂着的光标。

### 卡死不是慢，是死循环——别用「等更久」处理

2026-10-03 定位到过一次：`unit` 层超预算且**没有汇总**，进程反复重建（worker 年龄只有 80 秒、内存 1.3 GB）。
根因是 `PluginConfigCard` 里一个**漏写依赖数组的 `useEffect`**，它每次 render 都把 `forcedIgnoreNames(...)`
的返回值——一个每次都全新的数组——写进 state。于是「引用变了 → 重渲染 → 再跑」永远循环。

症状全是误导性的：CPU 打满单核、内存一路涨、**连 `testTimeout` 都触发不了**（定时器要靠事件循环执行，
而事件循环一秒都没让出来），所以看上去像「测试很慢」，实际上那个文件永远跑不完。

判断方法按这个顺序，都比「多等一会儿」快：

| 观察 | 说明什么 |
| --- | --- |
| 进程年龄远小于墙钟时间 | worker 在被反复杀掉重启，不是「还在算」 |
| 内存单调上涨到 GB 级 | 有东西在无界分配 |
| CPU 100% 单核且零输出 | 同步死循环——定时器根本没机会执行 |

定位到单个文件后，**逐步收窄**比逐个猜快得多：先只 import（这次 1.9 秒就排除了 transform），
再只 render，最后才逐个用例跑。

**预防**：任何把「每次调用都返回新数组/新对象」的函数结果写进 state 的 `useEffect`，
都必须按**内容**比较后再 set，并且把依赖数组写全——`scan-ignore.ts` 的 `sameIgnoreNames` 就是为此存在的。
另外，`useEffect` 收尾是 `})` 而不是 `}, [deps])`，grep `^\s*\}\)$` 能把漏写的那些一起捞出来。
