# DSH STORE 生命周期证据 — 一次性 Profile 的安装 / 启动 / 卸载

本文件是 DSH STORE 上架契约第 8 条要求的证据记录：**可安装的插件必须在一次性 Profile 里完成
安装 → 配置组合 → 页面或工具可见 → 卸载回滚的验收**，单元测试不能替代。配套的权限与失败边界声明见
[`PERMISSIONS.md`](PERMISSIONS.md)，机器可读副本见 [`store-evidence.json`](store-evidence.json)。

声明基线：`dsh-worktree-space@1.4.3`，被测树是本仓库默认分支上的固定提交 `385fec6`；最终发版提交与它只差这两份证据文档自己（见第 5 节循环性一条）。下面的清单现状、验收方法、
验收结果与边界情形都以它为准，不引用其它版本。

---

## 1. 隔离：绝不碰日常 profile

验收必须在**一次性数据目录**里做，这样安装、启动、卸载都不会碰到用户日常的 `profiles/`：

```sh
# bash / zsh —— DSH_HOME 决定 profiles/ 的位置
export DSH_HOME="$(mktemp -d)/dsh-home"
```

```powershell
# PowerShell
$env:DSH_HOME = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-evidence-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $env:DSH_HOME | Out-Null
```

`DSH_HOME` 一旦这样设定，下面所有命令读写的都是那个临时目录；验收结束后整目录删掉即可。
（`dsh --profile <name>` 解析的就是 `$DSH_HOME/profiles/<name>`。）

> ⚠️ **清理前先断言路径。** 删掉整个目录时，请先确认解析后的绝对路径确实位于临时目录下、且不等于
> `$HOME` / `%USERPROFILE%`。PowerShell 变量名**不区分大小写**，`$home` 就是只读自动变量 `$HOME`
> ——给一个叫 `$home` 的局部变量赋值会**静默失败**，变量仍是 `C:\Users\<你>`，紧接着的
> `Remove-Item $home -Recurse -Force` 就会把整个用户目录删掉。本插件的验收脚本曾因此酿成事故，
> 完整经过见该事故的社区通报。

## 2. 步骤与判定标准

按顺序执行，每一步的**通过标准**写在一起 —— 证据要能逐条对上，不接受「看起来没问题」。

### 2.1 安装

```sh
dsh plugin --profile evidence add dsh-worktree-space
```

- 该命令把 pnpm 参数原样转发给 profile，首次使用会初始化这个 profile。
- 通过标准：命令以 0 退出且无 `incompatible` 警告（若有版本警告，说明 `engines.dsh` 与实际宿主不符，
  应改声明而不是用 `allow-version --accept-risk` 掩盖）；`$DSH_HOME/profiles/evidence/node_modules/dsh-worktree-space/`
  存在且其 `package.json` 的 `version` 等于本次提交的版本；profile 的 `package.json` 把它写进
  `dsh.profile.bundles`。**注意**：`cordis.patch.yml` 不会因此多出挂载行——`dsh plugin add` 只做 pnpm
  安装并登记 bundle，`- id: worktree-space` 那一行是之后在插件页里改过设置（或从插件市场启用）时由插件
  管理器写下的；本机日常 web profile 里那一行连同它的 `config` 就是这样来的。

  > 想从官方模板起步时，可用启动器的 `--from-default-profile web` 先把 `evidence` 按 web 模板初始化；
  > 具体用法以 `dsh --help` 在所用 DSH 版本上的输出为准。

### 2.2 配置组合（启动前的静态验收）

```sh
dsh --profile evidence --dump-config
```

- 通过标准：组合出的条目树里出现 `worktree-space` 一行，且 `config` 是 profile 文档里的值；
  同时确认 `engines` 段落与实际宿主版本相符（这就是「Node.js / DSH 兼容范围已在 manifest 中声明」的验证点）。
- 这一步不挂载 UI，因此适合放进 CI；它是「配置组合」的机器可读证据，截图或日志请一并留存。

### 2.3 启动与可见性

```sh
dsh --profile evidence --no-open --port 0
```

- 通过标准：进程正常启动；在插件列表里能看到 **Worktree Space** 的名称、描述与 `icon.svg` 图标；
  能看到它自己的配置区（面板入口、侧边栏底部入口、授权 agent 处理入口、扫描深度、最大遍历目录数、
  默认分支前缀、Worktree Space 容器根目录与指定容器根目录、归档文档位置与指定归档目录），改动立刻生效；
  「任务空间位置」切到「指定目录」时下面那一行才出现；侧边栏底部出现快捷入口，能打开管理页面；
  宿主 RPC 路由 `/api/dsh-worktree-space` 已注册。
- **profile 必须带上 Web 应用的 bundle 层**：`dsh plugin` 初始化出来的空 profile 里没有
  `@deepseek-ai/dsh-web-app`，插件会停在 `pending (waiting for service: connection)`，宿主打印
  `warning: 1 entry did not activate`——这不是插件的问题，用 `dsh evidence --from-default-profile web`
  从官方 web 模板建 profile 即可。
- 「RPC 路由已注册」的机器可读验法：这些路由是 `POST /api/dsh-worktree-space/<endpoint>`（endpoint
  见 `src/host/index.js` 的 `ENDPOINTS`），带会话 cookie 请求 `task.preference` 得 200 与
  `{"ok":true,"value":{…}}`，随便编一个 endpoint 得 404。客户端 bundle 的地址在启动数据里
  （`plugins/??dsh-worktree-space/client.js&rev=<rev>`），取回应得 200，字节数等于 `client/client.js`
  加上宿主加载器补的那层包装。
- **端到端功能验收**（一次性仓库，不要用真实项目）：在临时目录里 `git init` 一个仓库 → 新建任务空间 →
  确认 `<容器根>/<项目>/<任务名>/<仓库名>` 是 worktree（项目名 = 源工作区目录名，插件自己分层）、
  `<容器根>/README.md` 已写、`<容器根>/<项目>/<任务名>` 已注册为工作区并开了会话 → 改一个文件 →
  「结束任务」确认分支合并、worktree 移除、文档归档到 `<归档根目录>/<项目名>/<任务名>-<时间戳>/`
  （归档根目录由配置的「归档文档位置」决定，默认就是容器根自己的 `archived-docs`；两档各验收一次）。
- **容器根的两条校验**也各验一次：把任务空间根手填成一个**本身就是 git 仓库**的目录，确认创建被拒、
  且一个目录都没建出来；再确认容器根已有的 `README.md` 不被覆盖。
- **任务空间位置**这一档也各验一次：配置里切到「指定目录」并填一个路径后，新建对话框的容器根预填成
  它；切回「默认」后预填回推导值，且配置里留着的目录不再被读。再验一次回写：新建面板里把容器根改成
  别的路径（此时输入框下面出现「设为默认 Worktree Space 容器根目录」，旁边就是那条说明），勾上后点创建，
  确认配置里「指定 Worktree Space 容器根目录」= 该路径且「任务空间位置」= 指定目录。
- **两个 profile 各验一次**：`web` 与 `desktop` 是清单里声明的两个端，安装、可见性与配置都在两个端上
  走一遍第 2.1 至 2.4 节（桌面端的安装与卸载在插件管理页里点，见 README「安装」）。
- 留存：上面每一步的截图（插件列表、配置区、管理页面、结束任务结果）。

### 2.4 卸载与回滚

```sh
dsh plugin --profile evidence remove dsh-worktree-space
dsh --profile evidence --dump-config
```

- 通过标准：`profiles/evidence/node_modules/dsh-worktree-space/` 消失；`cordis.patch.yml` 里的挂载行被清掉；
  第二次 `--dump-config` 的条目树里不再有 `worktree-space`；启动后插件列表里不再出现该插件，侧边栏入口一并消失，
  且没有残留报错（宿主 RPC 路由注销，不留下需要手动清理的状态）。

## 3. 本版清单现状

`package.json` 在基线提交上的声明，逐字段抄录，不是转述：

| 字段 | 值 |
| --- | --- |
| `version` | `1.4.3` |
| `engines.node` | `^22.19.0 || >=24.0.0` |
| `engines.dsh` | `>=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1` |
| `peerDependencies["@deepseek-ai/dsh-client-connection"]` | `>=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1` |
| `peerDependencies["@deepseek-ai/dsh-tools"]` | `>=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1` |
| `dsh.compatibility.dsh` | `>=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1` |
| `dsh.compatibility.node` | `^22.19.0 || >=24.0.0` |
| `dsh.compatibility.profiles` | `["web", "desktop"]` |
| `dsh.client.platform` | `web` |
| `dsh.compatibility.dshReleases` | `0.2.2-rc.3`、`0.2.2-rc.2`、`0.2.2-rc.1`、`0.2.1-rc.5`、`0.2.1-rc.4`、`0.2.1-rc.1`、`0.2.0-rc.1`，均为 `compatible` |
| `dsh.compatibility.dshOperations` | **空**：本节的矩阵结果记在 Markdown 里，不在清单里 |
| `peerDependenciesMeta` | `dsh.client.inject` 里的 13 个宿主包**全部**声明为 `optional`：自动安装 peer 的安装器因此不再把宿主自己的包写进 profile。DSH 自己的插件安装命令本来就不装 peer，行为不变 |

三处 DSH 范围（`engines.dsh`、两个 peer、`dsh.compatibility.dsh`）刻意写成同一个字符串：DSH 0.2.0 起
安装与启动会强制校验 peer，另两处只是声明；三处不一致时，真正被闸住的那一处说了算，清单却会自相矛盾。

**1.4.2 起这条链没有上界。** 写法改为 `>=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1`——三条已发布的
版本线各取一个下界的 OR 链，等价于「0.2.0-rc.1 及以后全部接受」，0.3 起的新版本不再被兼容闸门挡住。
这是与生态里其它插件对齐的写法，代价是清单不再与实测范围等价：判断实测过哪些版本只能看
`dshReleases` 与本文件第 5 节。它换掉的是旧写法 `<0.3.0-0` 面临的另一个问题——在 DSH 用的
`semver.satisfies(..., { includePrerelease: true })` 下，`<0.3.0` 会把 `0.3.0-alpha.1` 一并放进来，
`-0` 这个预发布下界正是为排除 0.3.0 整条线的预发布而加的；现在整条链不再有上界，那个取舍也就不存在了。
下界**在 1.4.2 回到三条线并列**：1.3.2 起支持范围从 0.2.0 线起算（不再声明支持 0.1.7），1.4.0 曾收窄到
`>=0.2.1-rc.1`、拒绝 `0.2.0-rc.1` 与 `0.2.0-rc.2`，1.4.2 改回 OR 链后这两个版本重新落在声明范围内——
但它们**不在本轮的实测窗口里**，能装不代表验过。

**`dsh.client.platform` 仍是 `web`**：桌面端跑的是同一份 web 客户端，构建产物同为 `client/client.js`，
所以端声明写在 `dsh.compatibility.profiles`（两个 profile），平台声明保持一个值。

## 4. 两个可用的端

清单声明了两个 profile：`web` 与 `desktop`。两者跑的是同一份客户端产物（`client/client.js`）与同一套
宿主接口，差别只在安装与卸载的入口：

- **`web`**：命令行。`dsh plugin --profile web add dsh-worktree-space` 装，
  `dsh plugin --profile web remove dsh-worktree-space` 卸。
- **`desktop`**：插件管理页。侧边栏 →「插件」→ 在「插件包名」填 `dsh-worktree-space` → 点「安装」；
  卸载时在插件列表里点开 **Worktree Space**，进「插件详情」页，右上方点「卸载」按钮。

第 2.1 至 2.4 节那套命令只在 `web` 上跑；`desktop` 上的等价验收按上文的入口走一遍，记在第 5 节里。

## 5. 生命周期实测矩阵

七个版本各跑一遍第 1、2 节的流程，`web` 端、一次性数据目录、固定高位端口。端口按**从新到旧**分配
（`run-all.ps1` 依版本顺序取号）：`0.2.2-rc.3` → 34800、`0.2.2-rc.2` → 34801、`0.2.2-rc.1` → 34802、
`0.2.1-rc.5` → 34803、`0.2.1-rc.4` → 34804、`0.2.1-rc.1` → 34805、`0.2.0-rc.1` → 34806，避开宿主默认的 3080。
**1.3.2 起不再声明支持 0.1.7 系列**；**1.4.3 起窗口是并集**——最新五个（`0.2.2-rc.3`、`0.2.2-rc.2`、
`0.2.2-rc.1`、`0.2.1-rc.5`、`0.2.1-rc.4`）加上 `engines.dsh` 每条版本线的下界（`0.2.1-rc.1`、`0.2.0-rc.1`；
`0.2.2-rc.1` 既是下界又在最新五个之内，只测一次）。只测最新五个的话，两条线的下界永远没被跑过，
而降级到那两条线的使用者恰好跑在那里。更早版本的实测结果见 git 历史里的本文档。
被测产物是 dsh-worktree-space-1.4.3.tgz，由本仓库 `npm pack` 产出，含 26 个文件，
sha256 `34E17BCFB8AF27061FFD69D46600E107E535F8CE36FBB6FBDB1600D2815D5852`（1116421 字节）。
运行时间 2026-11-13 23:57:52 +08:00，判定 `PASS`（7 通过 0 失败），总耗时 87 秒，退出码 0。矩阵报告写在
`D:\dsh-acceptance\dsh-worktree-space\matrix\logs\matrix-report.md`；**本轮加了 `-Json`**，同名
`.json` 因此也是本轮的，报告里带着 `Commit: 385fec6`——**一份不写明自己测的是哪个构建的兼容性报告，等于没有**。
被测产物与那个提交逐字节一致，两处各自核过：`pnpm test` 的 `check:tracked-bundle` 重新构建后与提交里的
`client/client.js`（`A0CDE332…8029`，396873 字节）与 `lib/index.js`（`8345BE15…E957`，451380 字节）
逐字节相同；解包被测 tarball 再比，两份仍是这两个哈希。
所以报告里的 commit 与被测的包是同一棵树，不存在「报告早于功能改动」那种情况。

> **提交 sha 会随历史重整消失，产物哈希不会。**
> 本节记过的 `5476d81`、`9d491a4`、`b35e832` 都因为重整提交历史而不复存在，那不影响它们当时跑出的结论：
> tarball 是不可变文件，上面那个哈希才是能长期复核的东西，提交 sha 只是当时的指针。
> **复核某一轮以产物哈希为准，别拿 sha 去 `git show`。**

| DSH | Node | 安装 | 配置组合 | 启动与可见性 | 卸载 | 回滚 |
| --- | --- | --- | --- | --- | --- | --- |
| `0.2.2-rc.3` | `v24.18.0` | 通过 | 通过（1291 行 / 3 处命中） | 通过 | 通过 | 通过（1288 行 / 0 处命中） |
| `0.2.2-rc.2` | `v24.18.0` | 通过 | 通过（1291 行 / 3 处命中） | 通过 | 通过 | 通过（1288 行 / 0 处命中） |
| `0.2.2-rc.1` | `v24.18.0` | 通过 | 通过（1246 行 / 3 处命中） | 通过 | 通过 | 通过（1243 行 / 0 处命中） |
| `0.2.1-rc.5` | `v24.18.0` | 通过 | 通过（1234 行 / 3 处命中） | 通过 | 通过 | 通过（1231 行 / 0 处命中） |
| `0.2.1-rc.4` | `v24.18.0` | 通过 | 通过（1234 行 / 3 处命中） | 通过 | 通过 | 通过（1231 行 / 0 处命中） |
| `0.2.1-rc.1` | `v24.18.0` | 通过 | 通过（1226 行 / 3 处命中） | 通过 | 通过 | 通过（1223 行 / 0 处命中） |
| `0.2.0-rc.1` | `v24.18.0` | 通过 | 通过（1262 行 / 3 处命中） | 通过 | 通过 | 通过（1259 行 / 0 处命中） |

七个版本的 `dsh plugin add` 都以 0 退出且**没有** `incompatible` 警告；装上 `package.json` 的
`version` 均为 `1.4.3`，`engines.dsh` 均为 `>=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1`。

回滚是**逐字节**回到安装前，不是"看起来干净"：每个版本的 `06-dump-after-remove.txt` 与
`01-create.txt` 行数完全相同（1288/1288、1288/1288、1243/1243、1231/1231、1231/1231、1223/1223、1259/1259，
本轮逐对核过），`cordis.patch.yml` 提及数为 0，`node_modules` 已删除。

### 宿主在 bundle 末尾追加 76 字节——自动化比对必须先剥掉它

服务端下发的 `client/client.js` **永远不等于**仓库里那份，直接比 sha256 会在完全正常的构建上报「陈旧」。
差的是宿主自己追加的一行：

```
;//# sourceMappingURL=…/dsh-worktree-space/client.js.map&rev=<token>
```

这不是推测，是逐字节量出来的：仓库文件是 HTTP 响应的**完整前缀**——公共前缀等于文件全长，
**公共后缀 = 0**——多出来的只有结尾那 76 字节，其中 `rev` 逐宿主不同（内容寻址的缓存键），
这也是四份原始哈希互不相同的原因。只对前缀算哈希，得到的就是仓库 `client\client.js` 的哈希。

**这条已在五个不同产物上各验一次**（仓库那份分别是 259620 / 259843 / 259523 / 262968 / 320063 字节；
1.3.8 起是 341217 字节的那一份，与前五个不同）：
一次吻合是猜测，两次吻合是巧合，三次才是规律。仓库重构、改文案、换排版都会让产物变，
但那 76 字节的差一直没变——这才是把它写成规则的理由。

本轮矩阵**自己就记下了这个差**：五个 `summary.txt` 都是 `bundle_bytes: 392435`，
而仓库那份 `client/client.js` 是 392359 字节 / `17E66E3C…7E08`，392435 − 392359 = 76，
不需要再事后补采。**本轮客户端那份只差版本串**：与 1.4.1 那份（同为 392359 字节）逐字节相同，
唯一不同的位置是内联的版本号 `1.4.3`，因为 `build.mjs` 把版本编译进产物。
宿主那份变了，`lib/index.js` 为 442648 字节 / `AF9D1AE6…8ED8`（1.4.1 是 434433 字节）——`dispatch` 的
`sessionId`、`dispatchedAt` 的写入与等待判定都在宿主侧，
扫描端点读任务记录的源仓库，两处都在宿主侧。tarball 内的两份与仓库工作区逐字节同哈希（解包后当场比对；
Linux 上重建的同一份也是这两个哈希，见下一节）。

**两路数据互证，但来源不同，要分清：**

| 来源 | 数据 | 性质 |
| --- | --- | --- |
| 矩阵运行 | 五个 `summary.txt` 各记 `bundle_status: 200`、`bundle_bytes: 392435` | 来自矩阵，但**只有字节数、没有哈希** |
| 打包核对 | tarball 内 `client/client.js`、`lib/index.js` 与仓库产物的 sha256 比对（含翻字节阴性对照） | **不是**矩阵运行的数据 |

上一轮（1.2.0）字节级的前缀 / 后缀 / 前缀哈希是矩阵跑完之后**另起同一批宿主、同一份 tarball**
单独起实例抓的，原因是抓取脚本用了 `Get-ChildItem -Path '…\log-*' -Filter '04-boot.txt'` 这种写法，
在当前 provider 上返回 0 条（改成字面路径 `'…\log-*\04-boot.txt'` 才返回 4 条），于是没发现启动 URL；
等发现时窗口已经关了——`run-one.ps1` 在第 4 步的 `finally` 里杀宿主，第 5 步又卸掉了插件。
那一轮矩阵记的 `bundle_bytes: 259599` = 259523 + 76，与补采的差值一致，两路独立数据指向同一件事。

**所以自动化检查要先把末尾那行剥掉再比。** 矩阵本身只记 `bundle_bytes`、从不记哈希，
而第 5 步会卸载插件，跑完之后装进去的副本就没了——想验只能在宿主还活着的时候抓。

阴性对照也要留着，否则这条比对可能恒真：翻一个字节，sha256 变、**长度不变**（证明长度比对什么都证不了）；
拿 `lib\index.js` 去和 `client\client.js` 比，哈希不同（证明能区分不同文件）。

### 这份证据是循环的，如实记下

`package.json` 的 `files` 白名单**包含本文档**，所以改本文档就改了被测产物的 sha256。
上面那个哈希描述的是**装着旧版本文档的包**。这不是疏漏，是打包范围决定的：
证据文档和被它描述的产物住在同一个 tarball 里，谁先谁后都有代价。

因此补一句可复核的话：**本文档的任何一次修改，都会让上面那个 sha256 失效**，需要重跑矩阵。
判断包对不对，看 `lib\index.js` 和 `client\client.js` 的哈希，不看 tarball 的——
那两个是构建产物，改文档不会动它们。

1.3.2 把这条循环完整走过了一次：`E1300685…9472`（装着旧文档）→ 文档按那一轮数字重写 →
`B7ACF45E…6643`（重打、重测；本文档写的是它，而它里面装的文档还写着前一个）。再跑一轮只会把
滞后推后一轮，所以此处收敛：本节记录的 sha256 指向**最后一次实跑的包**，它内含的文档是本文档的
上一版；两份 bundle 哈希才是描述发布内容的东西。

**1.4.3 的两份产物**：`client/client.js` 为 `A0CDE332…8029`（396873 字节），`lib/index.js` 为
`AF9D1AE6…8ED8`（442648 字节）。**客户端这一版只差版本串**——与上一版逐字节相同，只有编译进去的版本号
变了；宿主那一份才是这一版的实质：`dispatch` 的可选 `sessionId`、`dispatchedAt` 的读写、以及漏报判定
改成两个时间的比较。1.4.1 那一轮还修掉一处会影响产物复现的问题：`src/client/styles.css` 在
Windows 工作树里带着 CRLF（`.gitattributes` 要求 `eol=lf`，索引里一直是 LF），`build.mjs` 把 CSS
内联进 `client/client.js`，于是 Windows 构建产出带 `\r` 的 bundle、Linux 产出不带，两侧无法逐字节一致。
把工作树重新检出为 LF 之后，两侧产物收敛到上面这两个哈希——这正是第 3 步 Linux 门存在的理由，
也是它本轮先红后绿的原因。

**矩阵只跑了一次。** 内容（兼容下界、窗口、README、CHANGELOG、证据）全部定稿并提交为 `86fd425`
之后才打包、才跑矩阵；报告里的 `commit`、`pluginVersion` 与 tarball 内的 `package.json` 三者一致，
这三者一致即说明矩阵测的就是最终要发的那个产物。

`desktop` 端由作者实测确认，命令行走不通、也不需要重跑。**那句确认说的是 1.1.0**，
此后每一版都没有重做桌面端的人工验收——本轮同样没有；本轮的浏览器验收走的是 `web` 端命令行起的实例。
清单里 `desktop` 仍声明为支持的 profile，依据是它跑同一份 `client/client.js` 与同一套宿主接口，
而不是逐版验过。

### 汇总列曾经恒为假

`run-all.ps1` 早期用 `$out = & run-one.ps1` 的返回值判定完成度，但 `run-one.ps1` 的每一条结论都由
`Emit` 经 `Write-Host` 输出——这个宿主不把 `Write-Host` 放进输出流，于是 `$out` 恒为空，
汇总那一列对**任何**版本都显示 `False`，无论实际发生了什么。方向恰好是唯一没人会去核对的
那一种：全绿时它报失败，真有失败时它也报失败，只是没人分得清。

现在改为读每个版本的 `logs\log-<版本>\summary.txt`——那是 `Emit` 同一批调用写进磁盘的副本，
而日志目录每轮开头会被清空，不会读到上一轮的残留。修复后本轮五个版本均输出 `True`（修复当轮是四个，
此后窗口扩到五个，本版为五个）。
逐版本的权威记录始终是 `summary.txt`，不是控制台汇总。

### 逐条对照

**本轮先把 `bundle_type` 那一格从假的改成真的。** 1.3.1 与 1.3.2 第一轮矩阵的 `summary.txt` 里，它都写着
`System.String[]`：`run-one.ps1` 传的是 `$b.Headers['Content-Type']`，而 PowerShell 7 里那个 header 是
**字符串数组**，脚本自己那个 `Emit` 用 `-f` 格式化，数组于是被 `ToString()` 成那句字面量。一格看着记了
content-type、实际上什么都没记，而它旁边就是 `bundle_status: 200`。改成 `(@(...) -join ', ')` 后重跑，
四份都是 `text/javascript; charset=utf-8`。修脚本本身不需要重打包（脚本属私有路径，不进包）；
但随后证据文档按这一轮数字重写——**文档在包里**，所以上面那个 sha256 描述的是文档重写前最后一次
重打的包，即装着本文档上一版的包。这是下一节循环性那条的现场，不是疏漏。

这个的形状与本节开头那条「汇总列曾经恒为假」是同一类：**一格有值、且那个值读起来像答案，但不回答问题**。
它不会让任何一步失败，只会在有人照抄进证据文档时把一句假话写进去。

| 判据（第 2 节） | 实测 | 说明 |
| --- | --- | --- |
| 2.1 安装以 0 退出、无 `incompatible` | 五个版本均满足 | pnpm 12.6.0，`Packages: +1` |
| 2.1 `node_modules/dsh-worktree-space/` 存在、`version` 正确 | 七个版本均为 `1.4.3` | |
| 2.2 `--dump-config` 出现 `worktree-space` 条目 | 五次均 `name: dsh-worktree-space` 命中 1 次 | 安装后比安装前多 3 行 |
| 2.3 进程正常启动 | 五次均 `boot_alive: True`，stderr 文件均 0 字节，`boot_stopped: True` | |
| 2.3 页面可达 | 七次均 HTTP 200（41705 / 41705 / 40623 / 38492 / 38492 / 37544 / 35333 字节，按 0.2.2-rc.3 到 0.2.0-rc.1），页面中出现插件 5 次 | |
| 2.3 客户端 bundle 地址可取回 | 五次均 HTTP 200、`text/javascript; charset=utf-8`，内容含 `id: "dsh-worktree-space"` | 服务端比仓库的 `client\client.js`(392359)多 **76**；矩阵自记 `bundle_bytes: 392435`，见上节 |
| 2.3 bundle 的 rev 逐版本不同 | `2fe97be17d07` / `571a531fa5c0` / `8f64c439ddca` / `aaf8a7866dc8` / `24661fd6c4b3` | 内容寻址，五份不同的宿主缓存各自一份 |
| 2.3 RPC 路由已注册 | `task.preference` → **200** `{"ok":true,"value":{"defaultBranchPrefix":"task/","archiveDocumentsStrategy":"container","archiveDocumentsDirectory":"","handoffFullAccess":"off","auditLog":"on"}}` | 编造的 endpoint → **404** |
| 2.4 `node_modules/dsh-worktree-space/` 消失 | 五次均 `True` | |
| 2.4 `cordis.patch.yml` 挂载行清掉 | 五次均 0 处提及 | |
| 2.4 再次 `--dump-config` 无 `worktree-space` | 五次均 0 处命中，且行数回到安装前 | |

**RPC 验法有前提**：请求必须带会话 cookie。启动 url 里的 token 在首次访问首页时换成 `dsh-auth-*`
cookie；不带这个 cookie 时，`POST /api/...` 一律回 **405**、`GET /api/...` 回 **404**，
连宿主自己确定存在的路由也一样——那是鉴权在前，不是路由缺失。另外，信封里的 `method` 是
`/api/` 之后的**整段**（`dsh-worktree-space/task.preference`），只写 `task.preference` 会被判
`RPC method does not match endpoint.`。

**bundle 地址是页面相对的**：`plugins/??dsh-worktree-space/client.js&rev=<rev>`，`rev` 每个版本各不相同
（`f89d414eea68` / `0f87100e2ed4` / `a0f30c1cc987` / `44d70f6fd220` / `c3ff87a1d4c7` / `958d04c02518` / `5e53ee5686a0`，按 0.2.2-rc.3 到 0.2.0-rc.1），
字节数五个版本一致（均 `bundle_bytes: 392435`）。

> 那行里的 `??` 是脚本写日志时的编码痕迹，`bundle_status: 200` 与 `bundle_registers: 1` 说明请求实际
> 成功——两轮矩阵表现一致。它不足以当作 URL 原文引用，但足以说明「取到了包」。

## 6. 必须逐条回应的边界情形

| 情形 | 结论 |
| --- | --- |
| 未认证请求 401 | 不适用：本插件不注册自己的 `webServer`，也没有独立的 HTTP 生命周期面；路由挂在宿主已认证的 `/api` 载体内 |
| 跨源请求 403 | 同上 |
| 缺少 authority 503 | 同上 |
| POST 不被重放 | 同上 |
| 崩溃恢复 | 不适用：插件不留持久化的操作日志，每次路由调用就是一遍 git；被中断的结束任务从仓库自身状态重新读取 |
| Windows 文件锁 | 未触发：五个版本的启动、探测与停止都没有留下占用，`node_modules` 可正常删除 |
| 回滚失败 | 未触发：五次卸载后 `node_modules` 消失、`cordis.patch.yml` 回到 0 处提及、`--dump-config` 回到安装前行数 |
| pnpm 10 / 11 / 12 | 仅实测到 **pnpm 12.6.0**（宿主随附版本）；10 与 11 未装、未验 |
| monorepo 子路径 | 不适用：本插件以单个包安装，不是从 monorepo 子路径装 |

## 7. 尚未覆盖的

- **第 2.3 节的端到端功能验收（本轮只验到「可见性」这一层）**：新建任务空间、结束任务、
  容器根的两条校验、任务空间位置的两档与回写——这些都还没在本轮实跑。它们要动 Git 仓库
  （`git init` 一个一次性仓库），与本节的安装 / 组合 / 可见性 / 卸载是不同的一层。
- **UI 层面的可见性没有逐项核对。** 本轮验到的是「页面可达、bundle 真的下发、宿主 RPC 路由
  已注册」这三条机器可读判据；插件列表里的名称 / 描述 / `icon.svg`、配置区九个字段的即时生效、
  侧边栏底部入口，仍需按第 2.3 节逐项点一遍。
- **pnpm 只验到 12.6.0。** 10 与 11 未验，见第 6 节。
- **`--dump-config` 的行数与宿主版本相关，不能跨版本顺延。** 换 DSH 版本或再改配置字段都要重量。
- **窗口是「最新五个 ∪ 每条声明版本线的下界」，不是固定集合。** 本版覆盖 `0.2.2-rc.3`、`0.2.2-rc.2`、
  `0.2.2-rc.1`、`0.2.1-rc.5`、`0.2.1-rc.4`、`0.2.1-rc.1`、`0.2.0-rc.1` 七个。取并集是因为声明里三条
  版本线各有一个下界：只测最新五个，`0.2.1-rc.1` 与 `0.2.0-rc.1` 永远没被跑过，而降级到那两条线的
  使用者恰好跑在那里。窗口在每次跑矩阵前都会与已发布的版本列表核对，漂移会直接失败而不是静默顺延；
  某条声明线一个已发布版本都没有时，闸门也直接失败并点名那条子句。
- **桌面端由作者实测确认**，本轮矩阵只有 `web` 端的命令行证据。
