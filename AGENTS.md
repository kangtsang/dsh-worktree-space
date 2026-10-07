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
- 删除目标只能是 `<MatrixRoot>\homes\home-<版本>` 和 `<MatrixRoot>\logs\log-<版本>`，且必须是直接子目录、名字精确匹配
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

地址直接读 `<ManualRoot>\case.env` 的 `URL=`，不要等后台任务的输出回传：那个回传会被打断，而 `case.env`
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

### 派完单要确认它真的起来了

`session_bridge_send` 返回 `sent` 只说明**消息投递到了**，不说明子 agent 起了新回合。
它可能停在 idle：`lastTurn` 不变，`lastReply` 还是上一轮那段话——**读起来和一份结果一模一样**。

连续栽过两次，都是往一个已经闲置或被取消的会话上续派：两次都没跑，而两次回来的「结果」都是把
上一轮的原文逐字复读。第二次尤其危险——那轮跑的是旧包、旧的 run root，数字全对，
只有磁盘上的 run root 根本没被创建。不主动去看的话，PASS 会照抄一遍交上来。

**确认要看磁盘上的副作用，不看派单返回了什么。** 验收矩阵就查 run root 是否出现；
启动实例就查 `case.env` 是不是刚写的。也可以读 `session_bridge_status`：
真正起来的 agent 是 `running` 且 `openTurn` 为 yes，而且会先回一句它正在核对什么。

**新起一个比续派可靠。** 续派只在那个会话确实闲着、上一轮已经收尾时用；
否则不如重开——重开的代价是一个空会话，续派失败的代价是一个没人发现的假结果。

「改文案/改样式 → 重建 → 重新打包 → 重启实例」是一整串，**中间任何一步漏掉，页面上看到的还是旧版本**，
而且看起来完全正常——已改的源码就在工作区里，只是没进产物。已经栽过四次：
一次是改了 i18n 就转去写别的，改完没 build 就打包；
一次是 bundle 里中文被转成 `\uXXXX`，用字面量搜「打开」搜不到，误以为构建没生效；
一次是排查一个已定位的 bug 时，连着三轮验收都在验同一个 14:44 的旧包——每一轮页面看起来都「正常」，
第三轮才想起来去看包里有没有今天的标识串；
一次是在桌面端实装 1.2.0 后打开面板直接报 `Cannot read properties of undefined (reading 'depth')`——
**磁盘上的包是新的**（装进去的两个 bundle 与仓库 sha256 逐字节一致），**宿主跑的仍是上一个包的代码**，
重启宿主后消失。
校验构建产物要用转义形式，别用字面量搜中文。

**这道坑现在有守卫了**：`start-acceptance.ps1` 在 `npm pack` **之前**比较 `lib\index.js`、
`client\client.js` 与 `src\`、`client\`（除 bundle 自身）里最新文件的时间，bundle 更旧就**直接失败**，
并打印是哪个文件、该跑什么。**脚本不构建，只检查**——所以改完源码要先 `node build.mjs`。
明知这次不该带上工作区里的源码改动，用 `-SkipBuildCheck` 跳过。

**但那道守卫只挡一半：它查的是「产物比源旧」，查不出「宿主还跑着上一个包的代码」。**
后者在磁盘上完全看不出来——`node_modules` 里是新包，mtime 是新的，sha256 也对得上，
只有进程里的模块是旧的。**装包之后宿主没有重新加载插件代码时，只有重启宿主能排掉。**

所以装完包先重启宿主再测。症状和「包里有 bug」几乎一样：都是新装、新版、页面报错。
区分的办法在下一段。

判断装进去的包是不是新的，**不要看时间戳**：npm 安装时会重新盖 `package.json` 的时间，
`lib\index.js` 的时间也只有真装了新包才会变。**唯一可靠的判据是在装进去的那个文件里，
搜一个本次改动独有的标识串**；bundle 被压缩过就比 sha256，并带阴性对照。

**客户端 bundle 是压缩过的，搜标识串这条路对它不管用。** esbuild 压过之后函数名、变量名全都改了，
源码里的一行字在产物里可能根本不存在。**比对 sha256**，并且带上阴性对照证明这个比对不是恒真：

| 比什么 | 说明什么 |
| --- | --- |
| 装进去的 `client\client.js` vs 仓库的 `client\client.js`，sha256 相同 | 装的确实是现在这版 |
| 把副本翻一个字节，sha256 变了、**长度一样** | 哈希对字节敏感，而**光比长度证明不了任何事** |
| 装进去的 `lib\index.js` vs 仓库的 `client\client.js`，sha256 不同 | 比对能区分不同文件 |

第三条和第一条合起来排掉「永远相等」和「永远不等」两种失效方式。

### 就绪门槛用启动时刻，别用墙钟猜

启动脚本的实际耗时**取决于 npm 缓存冷热**：实测热缓存下 **10 秒**跑完，冷缓存要 90-120 秒。

派单时写「`case.env` 写入时间晚于 10:05」这种阈值，如果脚本 10:00:55 就跑完了，这个门槛**永远不可能满足**——
子 agent 会一路轮询到超时，然后报一个「失败」，而实例其实早就活着。栽过一次：子 agent 轮询了 3 分钟
去等一个**早已满足**的条件，最后如实报告「门槛字面上不通过，实例确实正常」。

正确做法：**把启动那一刻的时间戳交给子 agent**，或者直接让它比对「比启动时刻新」，
而不是拿现在的钟去减一个估出来的秒数。

## 6. 测试分层与入口

本仓库的测试分两层，`vitest.config.ts` 里用 `projects` 声明。分层的理由和一般规则见全局规则 §4 的「测试套件」子节，这里只记本仓库的具体事实。

| 命令 | 内容 |
| --- | --- |
| `pnpm test:unit` | 两层并发 + 各自 60 秒预算 + 合并汇总 |
| `pnpm test:unit:fast` | `unit` 层：除真实 git 外的全部 |
| `pnpm test:unit:git` | `git` 层：会真跑 git 的那些文件 |

三个入口**走同一个 runner**（`scripts/test/run-tests.mjs`），共用同一个 60 秒墙钟预算和同一份汇总输出。快捷入口也必须有预算：最需要有人拦一把的场景恰恰是手动跑单层，而 `testTimeout` 只能挡住「一个用例跑太久」，挡不住「worker 不再应答」——那种情况内存会一路涨到进程被系统杀掉。

`pnpm test` = `build` + `typecheck` + `test:unit` + `check:client-bundle` + `check:tracked-bundle` + `check:package`。
它跑完两层，不会因为分层而漏测；它还多跑三件事，**而那三件事只有它跑**。

### 要打包或要验收之前，走 `pnpm test`，不要走 `test:unit`

`check:tracked-bundle` 重新构建一遍，再和仓库里那份 `client/client.js` 逐字节 diff。
它是唯一能发现「源码改了、bundle 没重建」的检查——比 `start-acceptance.ps1` 里那个时间比较强，
后者只挡打包那一刻，而且只在接受路径上跑。

**但它只挂在 `pnpm test` 上，`pnpm test:unit` 不含它。**

栽过一次，而且是最难发现的一种：改完 `WorktreesSettings.tsx`、`i18n.ts`、`styles.css`，
跑 `test:unit` 和 `tsc` 都过，直接 `pnpm pack`。打出来的包里 `client/client.js` 里
`feedbackLink` 出现 **0 次**——**验收矩阵 4/4 全过**，报告里每一行都对。
陈旧 bundle 对安装、启动、RPC、回滚那些检查完全隐形：它们验的是「插件装上了、宿主起来了、
接口通」，没有一项问「这个 bundle 里有没有刚改的东西」。

所以这条规矩是：**改了 `src/client/**`（含 `styles.css`），要打包或者要验收之前，跑完整的 `pnpm test`。**
多花的那点时间，比打出一个「装得上、起得来、但界面还是旧的」包便宜得多。

**这里不记用例数，也不记秒数。** 两者都是加一个测试、或者机器忙一点就变的数字，记下来只会误导：下一个拿它当基线核对的人第一件事就是发现对不上，然后得先花时间弄清是数字过期了还是哪里真的坏了——而分层要保证的那条不变量其实一条都没坏。

真正稳定、值得记的是这两条，它们随时可以自己复核：

1. **两层没有漏测。** `pnpm test:unit` 跑的用例集合必须等于不加 `--project` 的全量枚举，且两个层的文件集无重叠。改动 `vitest.config.ts` 的 `projects` 或 `include` 之后重新核一次。
2. **两层都远在 60 秒预算内。** 实测 `unit` 十几秒、`git` 二十几秒（`git` 层慢是因为每个用例都要真起一次 `git.exe`，是进程创建开销，调参解决不了）。**任何一层接近预算就是回归**，这时该查速度，而不是先调预算——调预算会把回归藏起来。

**`git` 层只有三个文件**：`test/task-merge-worktree.test.mjs`、`test/encoding.test.ts` 和 `test/suite-runner-budget.test.mjs`。前两个用 `execFileSync` 驱动真实 git，在 Windows 上单次 `git.exe` 启动几乎全是进程创建开销，所以慢得没法靠调参解决；第三个 fork 真实的 node 进程树，理由相同——它验的就是进程树行为，对真实进程之外的东西断言不算数。新增真正跑进程 / 碰磁盘的测试时放进这一层，`vitest.config.ts` 顶部的 `REAL_GIT` 一行加文件名。**这一行的文件名数量要跟着变**：它写错不会让任何测试失败，只会让下一个照着它放文件的人以为规则是"只有两个"。

### 测试里的路径不能无条件按 Windows 语义断言——CI 跑在 Linux 上

`.github/workflows/ci.yml` 是 `runs-on: ubuntu-latest`，跑的是完整的 `pnpm test`。
**本地在 Windows 上全绿，只说明 Windows 上绿。**

本仓库的路径处理**按文件系统大小写敏感性分叉**：宿主的 `canonicalPath` 只在
`process.platform === 'win32'` 时折叠大小写（`src/host/task/paths.js`），
因为 Linux 上 `/Repo` 和 `/repo` 就是两个目录，把看着像的其中一个剪掉，等于静默丢掉一个真实工作区。

**所以断言大小写差异的行为时必须按平台分支，不能只写 Windows 的答案。** 栽过一次：
`test/host.test.mjs` 里一条 `prunes a nested Workspace whose path differs only in case`
写死了 `E:\WORKSPACE\public` 被 `e:\workspace` 包含，在 Linux 上必然失败——而它一直「绿」，
因为本机是 Windows，从来没人跑过 Linux。**一个从来没在 CI 上跑过的测试，和没写是同一个状态。**

**别把这条反过来修成「干脆不分大小写」。** 同时补一条对照用例：共享前缀拼写一致时
（`E:\workspace\PUBLIC` vs `E:\workspace`）在**所有**平台都剪。两条合起来才把
「按平台分叉」和「完全不看大小写」区分开——只改前一条，反向的修法也能让它变绿。

**客户端那份另有一条约定，和宿主不同，别混。** 浏览器端不知道宿主是什么系统，
所以 `src/client/lib/paths.ts` 是**按路径形状**判断：两边都带盘符（`^[a-zA-Z]:`）才当
Windows 路径折叠大小写（`sameLocation`）。写客户端路径工具时照这个来，别去读 `process.platform`
——浏览器里那个值是浏览器的，不是宿主的。

### 同一个道理不止适用于路径——「在一台机器上成立」都别当成「通用」

Linux CI 连续三轮拦下三类东西，**根子是同一个**：某件事只在一台机器上成立过，
于是被当成了通用事实。

| 轮次 | 被拦下的 | 「只在一台机器上成立」的是什么 |
| --- | --- | --- |
| 1 | 测试写死 Windows 的大小写语义 | 只有本机是 Windows |
| 2 | `check:package` 只找 Windows 那个位置的 npm | **只在一台机器上量过一次布局** |
| 3 | subprocess mock 的 Promise 竞态 | 只有本机的**调度速度**刚好合适 |

第 2 条的注释当时写着 `Measured on this machine`——**这句话本身就是缺陷**：
量了一台机器的布局，然后当成布局。npm 装在 node.exe 旁边是 Windows 的事，
Linux/macOS 装在 `lib/` 下面。同一个检查在本机绿了很久，在 runner 上**最后一道发布门直接拒绝打开**，
还打印了一句完全误导的话：「安装一个自带 npm 的 Node」——那个 Node 带着 npm，就在隔壁目录。

第 3 条更隐蔽：`typeof reply === "object"` 对 Promise 也成立，于是 mock 去读 promise 上的
`.exitCode`（不存在），`?? 0` 变成成功，**立刻答复，副作用在后台裸跑**。
Windows 上恰好赶上了，Linux 上没赶上。把 handler 延迟 150ms 就能在本机复现——而且是**两条**挂，
不是一条。

**所以下面这几条都按「我这台机器」重新过一遍：**

- **本机量过的路径或布局**（node、npm、python、各种 CLI 装在哪）→ 改成**找**，别写死一个
- **本机跑绿的测试** → 在 Linux 上是什么结果？写死平台语义的断言按平台分支；
  靠时序成立的断言（mock、副作用、竞态）改成**确定性的等待**，别指望调度
- **本机绿的整体流程**（CI、本地全量）→ 本地绿只说明本机绿

`test/documented-defaults.test.mjs` 是这条的另一个实例：**改了默认值却忘了同步说明文档**。
这类事靠人记不住，所以把文档里写的数字**抠出来和代码常量比**。查了才发现不止一处漏：
`scanDepth` 从 2 改到 3 之后四个文档有三个没跟；内置跳过目录少了一项，README 还在数 24（实际 23）。
代码是对的、文档是错的，两边各自都自洽——**没有任何办法靠读代码发现它**。
现在改默认值之后 `pnpm test` 会直接点名是哪几个文件。

### 打 tag 之前在 Linux 上跑一遍 `pnpm test`，别等 CI 告诉你

上面那三轮都是**推了 tag → CI 报错 → 查根因 → 修 → 再推**。每次都要删远端 tag、推 main、再推 tag，
而 `pnpm test` 在本机只要一分多钟。**本机能跑的验证，没有理由放到 CI 上才发现。**

WSL 里常驻着一份 Linux 用的检出：`\\wsl$\Ubuntu\home\zega\dsh-wts-linux`，
Node 是 `~/opt/node`（软链，升级只需解压 + 重指软链，PATH 不用动）。同步文件后：

```
wsl.exe -e bash -lc 'cd ~/dsh-wts-linux && pnpm test'
```

**`-l` 必须带。** `wsl.exe -e bash -c` 是不登录非交互的调用，**不读任何配置文件**，
所以里面没有 node，会报 command not found——这是配置方式的正常边界，不是环境坏了。

**判据看 exit code，别只看测试数。** 这套验证第一次跑通时还顺带证明了一件别处验不了的事：
Linux 构建出的 `client/client.js` 和 `lib/index.js` 与 Windows 构建的**逐字节相同**，
也就是 `check:tracked-bundle` 在两个平台都成立。**构建是可复现的**——
以前没人在 Linux 上跑过这道检查，所以没人知道。

这条不替代 CI：CI 仍然跑，它多验的是 `pnpm install --frozen-lockfile` 那一层，
本地那份的依赖是早就装好的。**发版前的顺序是：Linux 本地验 → 提交 → 推 tag。**

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

### 测试输出要留存时，只往 `_test-output/` 写

`run-tests.mjs` 只打印到 stdout，**自己不写任何文件**——这是事实，不用去改它。但一次全量跑会打印几百 KB，
值得留一份下来细看，而「留」这件事需要一个固定落点。没有固定落点时的实际结果：每次现编一个文件名
（`.testrun-full.txt`、`.testrun-rerun.txt`、`.testrun-pair.txt`……），全部落在仓库根目录，
在 `git status` 里排成一串未跟踪项。**没有人会在 `git status` 里盯着六行未跟踪文件看出问题**，
于是它们留到下一次、下下一次，直到某次 `git add .` 差点把它们带上。

`_test-output/` 已在 `.gitignore` 里，与 `_preview/` 同样的约定。往那里写的东西既不会出现在
`git status` 里，也不会被一次手滑的 `git add .` 捡走。

**推给子 agent 的跑测试任务，写清这句约束。** 这次的六个文件就是这么来的：派单只说了「跑全量测试
并汇报」，没说别落盘，子 agent 为了能重读那 237 KB 输出就自己管道成了文件。约束的措辞不重要，
**约束必须存在**。
