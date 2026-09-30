# DSH STORE 生命周期证据 — 一次性 Profile 的安装 / 启动 / 卸载

本文件是 DSH STORE 上架契约第 8 条要求的证据记录：**可安装的插件必须在一次性 Profile 里完成
安装 → 配置组合 → 页面或工具可见 → 卸载回滚的验收**，单元测试不能替代。
配套的权限与失败边界声明见 [`PERMISSIONS.md`](../PERMISSIONS.md)。

声明基线：`dsh-worktree-space@1.0.6`。

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
  默认分支前缀、任务空间位置与指定任务空间根目录、归档文档位置与指定归档目录），改动立刻生效；
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
  别的路径（此时输入框下面出现「设为默认任务空间根目录」，旁边就是那条说明），勾上后点创建，确认
  配置里「指定任务空间根目录」= 该路径且「任务空间位置」= 指定目录。
- 留存：上面每一步的截图（插件列表、配置区、管理页面、结束任务结果）。

### 2.4 卸载与回滚

```sh
dsh plugin --profile evidence remove dsh-worktree-space
dsh --profile evidence --dump-config
```

- 通过标准：`profiles/evidence/node_modules/dsh-worktree-space/` 消失；`cordis.patch.yml` 里的挂载行被清掉；
  第二次 `--dump-config` 的条目树里不再有 `worktree-space`；启动后插件列表里不再出现该插件，侧边栏入口一并消失，
  且没有残留报错（宿主 RPC 路由注销，不留下需要手动清理的状态）。

## 3. 验收记录（2026-09-28，一次性 profile `evidence`）

环境：Windows、Node.js `v24.18.0`、DSH `0.1.7-rc.2`；被测包是 `npm pack` 出来的
`dsh-worktree-space-1.0.6.tgz`（**307740** 字节，与 `pnpm check:package` 校验的 19 个文件同源），对应
固定提交 `ae7bb4386069090f9f188937a4d4eeafaadc9407`。`DSH_HOME` 全程指向临时目录，没有碰日常
`profiles/`。机器可读版本见 [`store-evidence.json`](store-evidence.json)。

> **布局说明**：本节记录的是 1.0.6 那一次运行。当时插件建出的任务空间是**扁平**的 ——
> `<容器根>/<任务名>/<仓库名>`，没有 1.0.8 才加上的项目目录那一层。所以下面出现的路径少一层，
> 那是那个版本的真实样子，不是笔误；本节也不为项目层提供任何运行期证据。

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 安装 | **已通过** | `dsh plugin --profile evidence add <tarball>` 退出 0，输出 `+ dsh-worktree-space 1.0.6`；`incompatible` 一次都没出现；profile 的 `package.json` 增加该依赖并把它写进 `dsh.profile.bundles`；装出来的 `package.json` 是 `version 1.0.6`、`engines={"node":">=22.19.0","dsh":">=0.1.7-rc.1"}` |
| 配置组合 | **已通过** | `dsh --profile evidence --dump-config` 退出 0（1249 行），组合树末尾出现 `# == dsh-worktree-space` / `- id: worktree-space` / `name: dsh-worktree-space` |
| 启动与可见性 | **已通过** | 启动无警告（没有 `did not activate`）；启动数据里出现客户端条目 `{"id":"dsh-worktree-space","url":"plugins/??dsh-worktree-space/client.js&rev=473ca4a5f860",…}`；该 bundle 取回 **200、203853 字节**（本地 `client/client.js` 203777 字节，外加宿主加载器补的 76 字节包装与 `sourceMappingURL`）；宿主 RPC 已注册并作答：`POST /api/dsh-worktree-space/task.preference` → 200 `{"ok":true,"value":{"defaultBranchPrefix":"task/","archiveDocumentsDirectory":""}}`，未知 endpoint → 404 |
| 卸载回滚 | **已通过** | `dsh plugin --profile evidence remove dsh-worktree-space` 退出 0，输出 `- dsh-worktree-space 1.0.6`；`profiles/evidence/node_modules/dsh-worktree-space/` 消失；`package.json` 的依赖与 `bundles` 里都不再有它；`--dump-config` 里 `worktree-space` 出现 **0** 次（1246 行）；再启动一次无报错，页面里 `dsh-worktree-space` 出现 **0** 次 |

### 3.1 端到端功能验收（一次性仓库）

同一个一次性 profile 里，用插件自己的 RPC 走完了创建 → 计划 → 结束：

1. `task.create`（源根下只有一个 `repo-alpha`）→ 建出 `<tasksRoot>/evidence/repo-alpha`（worktree，分支
   `task/evidence`）与 `worktree-space.json` / `worktree-space.md`。把 tasks root 指到源根**里面**时被
   拒绝：`tasks root is inside the source root: … work and source must be isolated`（这是 1.0.6 的原话；
   1.0.7 起同一拒绝改说 `the tasks root … is inside the repositories' directory …`，规则本身未变）。
2. 在 worktree 里改一个文件并提交 → `task.plan` 报 `mergeTarget: "main"`、`commits: 1`、
   `changedFiles: 0`。
3. `task.done`（`merge: true, deleteBranch: true`）→ `merged: true, removed: true, branchDeleted: true,
   containerRemoved: true, failed: false, warnings: []`。
4. 源仓库结果：`e9365ef Merge branch 'task/evidence'`（`--no-ff`），`feature.txt` 已出现在 main 检出里，
   分支只剩 `main`，`git worktree list` 只剩主检出；任务目录已删除（`tasksRoot` 本身保留，因为它是用户
   指定的根，插件只删自己建的那一层）。

### 3.2 外部回读（固定提交就是发布内容）

从 GitHub 按固定提交取回本仓库里的构建产物，与本地逐字节比对：

```
Invoke-WebRequest https://raw.githubusercontent.com/kangtsang/dsh-worktree-space/ae7bb43…/client/client.js
SHA-256  F626FF55266DDEC472F4CA496ED05811C7F503B56302748C5F7717CAFBDB8B62  203777 字节
本地      同上                                                              203777 字节
```

两者一致（同一个提交下的 `package.json` 回读出来也是 `1.0.6`），说明这次验收装的包与推上去的那个提交是
同一份内容。再把 npm 上那份发出去的 tarball 也拉下来比对一次：

```
registry.npmjs.org/dsh-worktree-space/-/dsh-worktree-space-1.0.6.tgz
SHA-1    7469017d0c65cfcfc57edd81ac1fbe525e2d68b7   307904 字节
SHA-256  1670ACF59035DE0A640FF07B77B06C1E4936213E3FCCF3EE684CF0C28B327A2B
本地 pack 同上（逐字节相同）
```

npm 上的落点：`1.0.5` 是修复**之前**从 `88f8808` 发布出去的，版本号不能复用，所以这一轮修复以 **`1.0.6`**
发布——`dist-tags.latest = 1.0.6`，`gitHead = 5774c5f760790dbee99e24bd2b75f731eb779236`（就是本文件所在
提交），tarball 与本地 pack 逐字节相同。这些都在 `store-evidence.json` 的 `publicRelease` 里如实记录。

跑完后一次性 profile 与临时仓库都已删除，`remove` 之后 profile 回到 `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app` 两个 bundle。

### 3.3 两点如实说明

- **GUI 截图未附**：headless Chrome 面对开着长连接的 GUI 不会自行退出（跑满两分钟仍不返回），所以这一轮
  的可见性证据是上面那些机器可读输出（启动数据里的客户端条目、bundle 的实际字节数、RPC 的实际回答），
  **不是**插件列表与配置区的截图。截图请在带图形界面的机器上按 2.3 节补一次。
- **pnpm 的 peer 警告**：`add` 的输出里有 `[WARN] Issues with peer dependencies found`。这是 peer 依赖的
  常规提示（`@deepseek-ai/cordis` 等由 DSH profile 提供），**不是**版本不兼容警告；`incompatible` 一次
  都没有出现。

## 4. 与自动策略的关系

DSH STORE 的八小时自动策略要求「文件 / 网络 / 命令 / 凭据信号均为空」才自动批准。本插件的功能就是文件读写
与调用 `git`，因此**永远无法**满足该条件；它对这两类信号的正确姿态是**如实声明**（见
[`PERMISSIONS.md`](../PERMISSIONS.md)），并在人工复核里给出上面这份生命周期证据。
本次修复能清掉的是另外两项可清除的判定：**Node.js 兼容性未声明**（已补 `engines.node` / `engines.dsh` /
`dsh.manifestVersion`）与**运行期依赖需要单独供应链复核**（已把三个仅构建期使用的包移入
`devDependencies`，运行期第三方依赖归零）。

## 5. v1.0.7 兼容性声明与逐版本操作矩阵（2026-09-29）

`v1.0.7` 是**纯 manifest 修复**：`lib/index.js`、`client/client.js` 等运行产物逐字节未变——这句话只对
`v1.0.7` 成立，`v1.0.8` 改了客户端产物，见第 6 节——第 3 节的端到端功能证据继续适用。本节补的是上架
契约里「逐版本操作证据」那一项。

根因：旧 manifest 的 `dsh.compatibility.dshReleases` 只声明了 `0.1.7-rc.1`，而官方窗口（由
`official-dsh-releases.mjs` 从 GitHub Releases 与 npm 已发布版本双源解析，锁在活跃的 0.1.x 线）
已经把 `0.1.7-alpha.2`、`0.1.7-rc.2` 纳入其中；`dsh.compatibility.node` 缺失，
`dsh.compatibility.dsh` 写成了单个版本而非范围，`dsh.compatibility.dshOperations` 完全没有。

### 5.1 实测矩阵

每个版本各用**该版本自己的** `@deepseek-ai/dsh` CLI，在一次性 `$DSH_HOME` 下从官方 web 模板建
profile `acceptance`，装 `npm pack` 出来的 `dsh-worktree-space-1.0.7.tgz`，再按顺序验收四步。
全程不写真实 `~/.dsh`。

| DSH 版本 | install | start | uninstall | rollback |
| --- | --- | --- | --- | --- |
| `0.1.7-alpha.2` | **passed** | **passed** | **passed** | **passed** |
| `0.1.7-rc.1` | **passed** | **passed** | **passed** | **passed** |
| `0.1.7-rc.2` | **passed** | **passed** | **passed** | **passed** |

每一步的判定标准与实测结果：

| 步骤 | 判定标准 | 三个版本的结果 |
| --- | --- | --- |
| install | `dsh plugin --profile acceptance add <tarball>` 退出 0；输出 `+ dsh-worktree-space 1.0.7`；`incompatible` 出现 0 次；装上的 `package.json` 版本为 1.0.7 | 全部满足 |
| start | `--dump-config` 组合树里出现 `- id: worktree-space` / `name: dsh-worktree-space`；冷启动打印 URL 且无 `did not activate`；页面 200 并带 `dsh-worktree-space/client.js&rev=…`；`POST /api/dsh-worktree-space/task.preference` 返回 `ok:true` | alpha.2 与 rc.1 组合树各 1237 行、rc.2 1249 行，均含 worktree-space 行；启动日志只有 URL 一行，无任何警告 |
| uninstall | `remove dsh-worktree-space` 退出 0；`node_modules/dsh-worktree-space` 消失；`dsh.profile.bundles` 回到 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`；`--dump-config` 里 worktree-space 出现 0 次 | 全部满足（删除后 1234 / 1234 / 1246 行，0 次命中） |
| rollback | 卸载后再次冷启动：正常打印 URL、无警告，页面里 `dsh-worktree-space` 出现 0 次 | 全部满足 |

`alpha.2` 与 `rc.1` 组合树同为 1237 行、`rc.2` 为 1249 行，是各版本自带模板不同所致，与插件无关。
`add` 输出里三个版本都有一条 `[WARN] Issues with peer dependencies found`——这是 pnpm 对
`@deepseek-ai/cordis` 等由 profile 提供的 peer 的常规提示，`incompatible` 一次都没有出现。

### 5.2 声明内容

- `engines.dsh`：`>=0.1.7-rc.1` → `>=0.1.7-alpha.2`
- `dsh.compatibility.dsh`：`0.1.7-rc.1` → `>=0.1.7-alpha.2 <0.2.0`（0.1.x 范围）
- `dsh.compatibility.node`：新增 `>=22.19.0`（与 `engines.node` 一致）
- `dsh.compatibility.dshReleases` / `dsh.compatibility.dshOperations`：对窗口内三个版本逐项声明
  compatible 与四项操作 passed（见上表）

未实测的版本保持**不声明**（不写进 `dshReleases`，即按 `unknown` 处理），不用宽泛范围冒充精确证据。
Bundle Patch 只插入插件自有 entry ID `worktree-space`，未替换或遮蔽任何 `@deepseek-ai/*` 包与受保护
entry ID；manifest 无安装期生命周期脚本。

## 6. v1.0.8：归档默认收进容器根，任务空间加一层项目目录（2026-09-29）

`v1.0.8` 改了两件事：**归档文档落在哪里**，以及**任务空间建在哪一层**。两件都是行为变化，
下面分开说，逐条对上架声明的影响在最后。

### 6.1 归档文档位置：两档，默认落在容器根

以前只有一条写死的规则 —— 任务空间容器旁边的 `archived-docs`，且里面直接是 `<工作区名>-<时间戳>`。
现在由配置里的「归档文档位置」在两档中选择（下面例子里的任务空间是
`~/work/worktree-space/kratos-admin/demo`）：

| 档位 | 归档根 | 例 |
| --- | --- | --- |
| `container` 跟随容器根（**出厂默认**） | 任务空间的容器根 | `~/work/worktree-space/archived-docs/` |
| `custom` 指定目录 | 用户填的那个目录 | `~/my-archive/` |

（`custom` 档留空时回退到 `container`；不再有第三种「固定到盘符」的档位。）

两档都在各自的根目录下再建一层 `<项目名>/<任务名>-<时间戳>`：归档结构与任务空间结构同形，一个项目的
文档收在自己那一层里。默认档就落在容器根，于是整块盘只多出 `archived-docs` 这一个目录，不必再记住
第二处位置；不放心的用户可以自己指定一个目录。这么摆也更稳：容器本身跟着仓库目录走（会话因此不必提权），
归档根跟着容器放，两者在同一棵树下，不会散到别处去。

### 6.2 任务空间布局：加一层项目目录

1.0.7 及以前，插件建出的是**扁平**的任务空间 `<容器根>/<任务名>/<仓库名>`。同一个容器里跑两个项目时，
两边同名的任务（都叫 `hotfix`）会挤在同一层。1.0.8 在中间多插一层**项目**，名字取**源工作区目录名**，
由插件自动分层 —— 客户端不新增任何需要用户填的字段：

| 位置 | 1.0.7 及以前 | 1.0.8 |
| --- | --- | --- |
| 任务空间 | `<容器根>/<任务名>/` | `<容器根>/<项目>/<任务名>/` |
| 项目名 | 无 | 源工作区目录名（`basename(sourceRoot)`） |
| 推荐容器根 | 源根所在**盘根下一层**目录里的 `worktree-space` | **不变** |
| 归档目录 | `<归档根>/<工作区名>-<时间戳>/` | `<归档根>/<项目名>/<任务名>-<时间戳>/` |
| 容器根 `README.md` | 无 | 首次使用时写入，已存在则一个字都不改 |

- **旧布局不兼容、不迁移。** 只认新布局的深度：`listTasks` 走「容器根 → 项目 → 任务」两级目录，
  空的项目目录不出现；按「任务名」定位的调用方（`task.plan` / `task.done`、agent 侧 `done`）
  必须多给一个 `project`，或者给 `sourceRoot` 由插件推。旧布局下建出的任务空间不会再被列出。
- **容器根多两条校验。** 容器根本身是 git 仓库（下面有 `.git`）时创建被**拒绝**，而且拒绝发生在任何
  目录被建出来之前 —— 这条正好补上了「容器根就是源仓库」的情形（那一种先被 `assertIsolated` 拒）。
  容器根首次被使用时写一份中英两段的 `README.md`，声明这里是 Worktree 专用区、不要直接 `git init` /
  `clone`。
- **协议多一个坐标。** 宿主 RPC 的 `task.plan` / `task.done`、agent 侧 `task_worktree_space` 工具、
  客户端的类型与 `groupTasks` 都跟着多一个 `project`；`create` 仍不要调用方给（它自己从 `sourceRoot` 推）。
- **源根本身就是仓库**（工作区目录 = `~/workspace/repo-x`）时，项目层与仓库层同名，得到
  `<容器根>/repo-x/<任务>/repo-x`。这处重复是**有意接受**的：布局深度恒定为三层，客户端算容器根
  不需要额外信息。
- **同名仓库的路径碰撞**：默认推荐下容器跟着**根工作空间**走，同一个根工作空间下的项目共用一个容器，
  靠新加的项目层分开（`<容器根>/<项目 A>/<任务>/<仓库>` 与 `<容器根>/<项目 B>/<任务>/<仓库>`），不会撞；
  只有用户手动把两个不同位置的同名仓库指到同一个容器根、且项目名也相同时才可能算出同一路径。
  这一条不做额外处理，README 里点明了。

### 6.3 任务空间位置：两档，默认仍是推导出的推荐值

归档位置那一档做出来后，同一个形状被用在**新建的任务空间放哪**上：配置里新增「任务空间位置」
（默认 / 指定目录）与「指定任务空间根目录」（任意路径，只在「指定目录」这一档生效）。

| 档位 | 新任务的容器根 | 例（源根 `~/workspace/projects`） |
| --- | --- | --- |
| `default` 默认（**出厂默认**） | 按老规则推导 | `~/workspace/worktree-space` |
| `custom` 指定目录 | 用户填的那个目录；留空仍按老规则推导 | `~/my-spaces` |

- **只有一个解析点。** `resolveTasksRoot(sourceRoot, requestedRoot, configuredRoot)` 多了一个入参：调用方
  没点名容器根时用配置值，配置值为空再退回推荐值。`task.suggest-root`、`task.create` 以及 agent 工具的四条
  动作（`suggest-root` / `create`，和只给 `sourceRoot` 的 `list` / `done`）都走它，因此对话框预填的、创建
  落下的、模型提议的、模型去读的是同一个值，不会各算各的 —— `list` 尤其要跟着走，否则它会去报告一个
  没人往里建东西的目录。
- **没人配置过时行为与 1.0.7 完全一致**：`configuredTasksRoot()` 返回空串，一切照旧。
- **档位与目录是两个设置，写回有顺序。** 档位不是「指定目录」时目录一个字都不读（访问器直接返回空串），
  所以上一轮留下的目录不会在切回默认后继续生效。新建面板勾「设为默认任务空间根目录」时，宿主侧
  **先写目录、再写档位**：目录被拒时档位根本不会被写，于是不会出现「指定目录 + 一个宿主没收下的路径」
  这一对；档位写失败时只留下一个没人读的目录，而那一半在默认档下是惰性的。
- **显式指定的仍然优先。** 用户在新建面板里填的容器根、agent 传的 `tasksRoot` 都不受影响 —— 这是默认值，
  不是强制；`assertIsolated` 对配置来的路径同样执行，配置一个嵌在源码树里的目录会被拒绝而非被静默改写。
- **界面上的那条说明写明了代价。** 新建面板里「设为默认任务空间根目录」旁边、以及配置区这一行的说明，
  用的都是同一句：*默认配置即最佳实践，指定目录若与项目目录没有公共目录，agent 处理提交和冲突时会话
  需要手动授权*。这与 6.2 里「任务空间与源码树共有一个共同祖先」是同一条约束的另一种说法。
- **文案更正（不涉及行为）**：插件描述里 experiment 的那句改成「把提交和处理冲突交给 agent 处理的功能
  还可能调整」；配置区「授权 agent 处理入口」的说明覆盖两个入口并写明关闭后回到「手动处理提交和解决
  冲突，再继续结束任务」；「归档文档位置」默认档的说明改成「把文档收在任务空间容器根目录下的
  `archived-docs` 里，无需额外创建目录」。
- **插件描述整段改写（同样不涉及行为，但改了 bundle）**：主句从「为每个任务创建一个可包含多个仓库
  worktree 的独立工作目录」改成以**任务**为主语、「每个仓库各开一份同名 worktree 分支，并注册成一个
  Agent 工作区，可以独立创建会话执行任务，多任务可以并行处理互不干扰」的写法，收尾写明「任务完成后
  合并回主干分支并删除 worktree 分支和任务空间」。这一段同时出现在三处，改一处必须改三处：
  `locale/zh.json` 与 `locale/en.json` 的 `meta.description`（上架列表用，尾句 beta 提示原样保留）、
  `package.json` 的 `description`、以及客户端 `panelDescription`（插件面板里那张卡片）。
  `panelDescription` 在 `client/client.js` 里，所以本次客户端包**又一次**逐字节变化 —— 上面
  `clientBundleChanged` 里「不再与 1.0.6/1.0.7 逐字节相同」的说法继续成立，且这一次的差别里
  不止归档位置与任务空间位置两处逻辑。
- **文档里的目录写法统一成 `~/` 与正斜杠。** README、README.en、SKILL.md、本节与
  `store-evidence.json` 里原先写成 `E:\workspace\...` 的示例路径，一律改成 `~/workspace/...`
  这种「家目录 + 正斜杠」的写法，目录树里的反斜杠也全部换成 `/`。这不改变任何行为，只是示例
  不再假装插件只跑在 Windows 的某个盘上；SKILL.md 第 233 行那个 `\` 是「任务名不许含哪些字符」
  的列举，属于规则本身，保留不动。

**与上架声明的关系，逐条说明：**

- **归档那一半的宿主契约未变，布局那一半变了。** `task.done` 的 `documentsDirectory` 仍然只是一个字符串，
  `finishTask` 仍然用 `assertIsolated` 对着任务空间校验它，`archive.js` 的复制与清理路径逐字未改；宿主侧
  为归档新增的只有一个配置字段与一个访问器。**但 6.2 改了自家协议**：`task.plan` / `task.done` 的入参多一个
  `project`，任务元数据与 `create` 的结果多一个 `project`，agent 工具多一个参数 —— 这是对本插件自己客户端
  的破坏性改动，不涉及任何外部服务。
- **任务空间位置是纯宿主侧的新配置。** `task.create` / `task.suggest-root` 的入参形状没变（`tasksRoot`
  仍是那个字段），变的只是它为空的语义上多了一层配置兜底，所以 6.3 不改自家协议 —— 与 6.2 的破坏性
  改动不是一回事。新增的配置字段只有两个，加上归档那一对，配置区一共多出四项。
- **第 5 节那些数字属于 1.0.7，不能顺延到 1.0.8。** `lib/index.js` 与 `client/client.js` 又一次逐字节变化；
  `--dump-config` 的行数也可能因为多出这几个配置字段而变化，不能沿用 1237 / 1249。第 7.4 节给出的
  五组数就是为 1.0.8 重新测的（与第 5.1 节数值相同，但那是两次独立的测量）。
- **第 3 节的端到端功能证据属于 1.0.6，而且当时是扁平布局。** 那一节建的路径是
  `<容器根>/<任务名>/<仓库名>`，比现在少一层项目目录，所以它既不能当作 1.0.8 归档策略的证据，
  也不能当作项目层的证据。
- **一次性 Profile 的四步矩阵已在本文件第 7 节对 1.0.8 复跑**（窗口五个版本各一遍，
  install → start → uninstall → rollback 的结论与行数都在那里），但**四步之外的端到端功能验收
  仍然缺运行期证据**：两档归档只被单元测试（`test/documents.test.ts`）与结束对话框的测试
  （`test/task-finish.test.tsx`）覆盖；项目层、容器根 README 与「容器根是 git 仓库就拒绝」只被宿主侧
  单元测试（`test/task-operations.test.mjs`、`test/task-paths.test.mjs`、`test/task-naming.test.mjs`、
  `test/task-tool.test.mjs`）覆盖；任务空间位置被 `test/host.test.mjs`（访问器与 `task.suggest-root`
  端点）、`test/task-operations.test.mjs`（`suggestTaskRoot` / `createTask` 的兜底与拒绝）、
  `test/task-tool.test.mjs`、`test/plugin-config-card.test.tsx` 与 `test/create-flow.test.tsx`
  （配置区两行与面板勾选框的两笔写入）覆盖。要把这几批也升成运行期证据，应按第 2.3 节的方法在一次性
  Profile 里走一遍验收（容器根校验、任务空间位置那一档回写），本节不做这个声明。
- `docs/store-evidence.json` 的 `archiveStrategyRelease`、`projectLayerRelease` 与
  `tasksRootStrategyRelease` 里记着同样这几点。

## 7. v1.0.8 兼容 DSH 0.2.0 线：peer 范围放宽，窗口五个版本逐版复跑（2026-09-29）

### 7.1 现象：0.2.0 上被标成「异常」

把 DSH 升到 `0.2.0-rc.1` 后，插件列表里本插件被标为不兼容，原文：

> 原因: dsh-worktree-space@1.0.8 与 DSH 0.2.0-rc.1 不兼容（要求 @deepseek-ai/dsh-client-connection
> ^0.1.7-rc.1, @deepseek-ai/dsh-tools ^0.1.7-rc.1），运行它可能导致崩溃或数据丢失。请安装与当前 DSH
> 兼容的插件版本。

在一次性 Profile 里用 0.2.0 线自己的 CLI 复现，`dsh plugin add` 被拒，而且**什么都没装**：

> dsh: installation rejected: Plugin dsh-worktree-space@1.0.7 is incompatible with dsh 0.2.0-rc.1:
> peerDependencies {"@deepseek-ai/dsh-tools":"^0.1.7-rc.1","@deepseek-ai/dsh-client-connection":"^0.1.7-rc.1"}.
> Running it may cause crashes or data loss. … Exact-version exemption: not active.
> dsh: nothing was installed.
> dsh: to accept the risk, run: dsh plugin --profile acceptance allow-version dsh-worktree-space@1.0.7
> --dsh-version 0.2.0-rc.1 --accept-risk

复现用的是**线上已发布的 1.0.7**，不是 1.0.8 —— 1.0.8 还没发布，装不到 profile 里；两者的
`peerDependencies`、`engines.dsh` 与 `dsh.compatibility.dsh` 在这一轮之前逐字相同，所以被拒的原因
完全一样，0.2.0-rc.2 上也复现了同一段（运行时版本换成 `0.2.0-rc.2`）。

### 7.2 根因：peer 范围在 0.2.0 上从「声明」变成了「闸门」

判定逻辑在 `@deepseek-ai/dsh-app-boot` 的
`evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`：它遍历 `peerDependencies`，
只看名字等于 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的项，对每一项执行

```
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

不满足即记为不兼容，并给出精确版本豁免 `dsh plugin allow-version <pkg@ver> --dsh-version <runtime>
--accept-risk`。`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 不在这条判定的名字里，所以它们
照旧只是声明。

这条判定在 DSH 0.2.0 上有两个落点（下面第一点在本轮实测，第二点是读 DSH 自身实现得到的）：

- `@deepseek-ai/dsh-plugin-manager` 在**装一个带名字的 spec**（如 `dsh-worktree-space@1.0.7`）时，
  先取那个 spec 自己的 manifest 做校验，不通过就 `return rejected(preflight, "nothing was installed")`
  —— 这一句在它 `execa("pnpm", …)` **之前**，所以 pnpm 根本没被拉起来，profile 不会有任何改动。
  实测输出正是 `installation rejected: …` 加 `nothing was installed.`（原文见 7.1）。
- profile 里**已经装着**一个不兼容的包时，启动的 preflight 会把那一行 `disabled` 掉并打出
  `disabling profile plugin <label>: <reason>`，即启动时跳过加载；插件列表里那条「异常」提示
  对应的是同一个判定。

本插件的两个 DSH peer 一直写的是 `^0.1.7-rc.1`，它的 SemVer 上界是 `<0.2.0`，0.2.0 线任何一个
prerelease 都不满足。0.1.7 及更早的 DSH 只看 `dsh.compatibility` 这类纯声明字段，所以这个坑到
0.2.0 才现形 —— **插件代码没有跟着过期，是声明的口径过期了**：`lib/index.js` 与 `client/client.js`
一行都没改。用户截图里那句「运行它可能导致崩溃或数据丢失」是校验失败的固定话术，不是对产物
兼容性的实测结论。

### 7.3 改动：三处范围合成一处，上界收在 0.3.0 之前

| 字段 | 改动前 | 现在 |
| --- | --- | --- |
| `peerDependencies["@deepseek-ai/dsh-client-connection"]` | `^0.1.7-rc.1` | `>=0.1.7-alpha.2 <0.3.0-0` |
| `peerDependencies["@deepseek-ai/dsh-tools"]` | `^0.1.7-rc.1` | `>=0.1.7-alpha.2 <0.3.0-0` |
| `engines.dsh` | `>=0.1.7-alpha.2` | `>=0.1.7-alpha.2 <0.3.0-0` |
| `dsh.compatibility.dsh` | `>=0.1.7-alpha.2 <0.2.0` | `>=0.1.7-alpha.2 <0.3.0-0` |
| `dsh.compatibility.dshReleases` | 三个 0.1.7 版本 | 加上 `0.2.0-rc.1`、`0.2.0-rc.2`，共五个 |
| `dsh.compatibility.dshOperations` | 三个 0.1.7 版本 | 加上 `0.2.0-rc.1`、`0.2.0-rc.2` 的四项，共五块 |
| `devDependencies` 里 13 个 `@deepseek-ai/dsh-*` | 钉 `0.1.7-rc.1` | 钉 `0.2.0-rc.2` |

- **上界写 `<0.3.0-0` 而不是 `<0.3.0`**：`includePrerelease` 打开时 `<0.3.0` 会连 `0.3.0-alpha.1`
  一起放行；`-0` 这个 prerelease 下界把 0.3.0 线的 prerelease 一并挡住。用与 DSH 同一条
  `semver.satisfies(..., { includePrerelease: true })` 逐版本核过：`0.1.7-alpha.2`、`0.1.7-rc.1`、
  `0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.0`、`0.2.9` 为真；`0.1.6`、`0.3.0-0`、
  `0.3.0-alpha.1`、`0.3.0` 为假。
- **三处范围合并成同一个 `>=0.1.7-alpha.2 <0.3.0-0`**：改前 peer 的下界是 `0.1.7-rc.1`，比另两处窄，
  于是会出现「`dshReleases` 说 alpha.2 兼容、peer 又说至少要 rc.1」这种自相矛盾。窗口里的
  alpha.2 是实测过的（见 7.4），下界就跟着实测走，三处声明不再各说各的。
- **开发依赖钉到 `0.2.0-rc.2`**：类型定义与客户端契约按最新线编译，`tsc --noEmit` 与 415 个单元测试
  在它上面全绿。运行期代码没有跟着改：`defineTool` 仍在 `@deepseek-ai/dsh-tools` 的导出里，客户端模块
  注册契约 `window.__ModuleLoader__.load({ id, factory })` 未变，本插件的客户端产物只 `require`
  react 三件套（`@deepseek-ai/*` 都是类型导入，构建时擦除），所以 `dsh.client.external` 不需要列。
- **旧布局、旧协议与本轮无关**：6.2 的项目层与 6.3 的任务空间位置是 1.0.8 自己的改动，与本轮的
  兼容性修复互不影响；本轮只动声明（与 `package.json` 的 `devDependencies`），`src/` 无改动。

### 7.4 复跑的实测矩阵

五个版本各自用**该版本自己的** `@deepseek-ai/dsh` CLI，在全新的 `$DSH_HOME` 里从官方 web 模板建
一次性 profile，装本版 `npm pack` 出来的 `dsh-worktree-space-1.0.8.tgz`（以 `file:` 依赖进 profile），
再走 装机 → `--dump-config` → 冷启动 → 取页面与客户端产物 → 探 RPC → 卸载 → 再冷启动。
`--dump-config` 的行数（装前 → 装后 → 卸载后），插件行每次正好多 3 行：

| DSH | dump 行数 | install | start | uninstall | rollback |
| --- | --- | --- | --- | --- | --- |
| `0.1.7-alpha.2` | `1234 → 1237 → 1234` | passed | passed | passed | passed |
| `0.1.7-rc.1` | `1234 → 1237 → 1234` | passed | passed | passed | passed |
| `0.1.7-rc.2` | `1246 → 1249 → 1246` | passed | passed | passed | passed |
| `0.2.0-rc.1` | `1259 → 1262 → 1259` | passed | passed | passed | passed |
| `0.2.0-rc.2` | `1259 → 1262 → 1259` | passed | passed | passed | passed |

逐版本的运行期观察：

| 观察 | `0.1.7-alpha.2` | `0.1.7-rc.1` | `0.1.7-rc.2` | `0.2.0-rc.1` | `0.2.0-rc.2` |
| --- | --- | --- | --- | --- | --- |
| 冷启动输出 | 一行 URL，无警告 | 同左 | 同左 | 同左 | 同左 |
| 首页 | 200 / 33544 B | 200 / 33544 B | 200 / 34825 B | 200 / 35333 B | 200 / 35367 B |
| 首页里点到 `dsh-worktree-space/client.js` | 是 | 是 | 是 | 是 | 是 |
| 取回该模块组 | 200 / 5675475 B | 200 / 5712782 B | 200 / 490488 B | 200 / 600806 B | 200 / 600749 B |
| 组里含 `id: "dsh-worktree-space"` | 是 | 是 | 是 | 是 | 是 |
| `POST /api/dsh-worktree-space/task.preference` | 200 | 200 | 200 | 200 | 200 |
| 返回 | `ok:true` + 偏好值 | 同左 | 同左 | 同左 | 同左 |
| 未知端点 | 404 | 404 | 404 | 404 | 404 |
| 卸载后 dump 里 worktree-space | 0 次 | 0 次 | 0 次 | 0 次 | 0 次 |
| 卸载后再冷启动 | 干净，首页 0 次 | 同左 | 同左 | 同左 | 同左 |

（`task.preference` 在五个版本上都答
`{"ok":true,"value":{"defaultBranchPrefix":"task/","archiveDocumentsStrategy":"container","archiveDocumentsDirectory":"","handoffEntry":"show"}}`。）

本节自己也在这份 tarball 里，所以文档定稿后又重打包复跑过：`0.1.7-alpha.2` 与 `0.2.0-rc.1` 各跑过一遍
完整四步，`0.2.0-rc.1` 另跑过两次 —— 行数（1234 / 1237 / 1234 与 1259 / 1262 / 1259）、冷启动、
页面模块组、`id: "dsh-worktree-space"`、RPC 200/404、卸载归零、二次冷启动，以及 0.2.0-rc.1 上的
1.0.7 拒绝，每次都与上表逐条相同（0.2.0-rc.1 的首页 35333 字节、模块组 600806 字节也每次都一样）——
DSH 在安装与启动时只读 `package.json`、`cordis.patch.yml` 与两个 bundle，包里的文档正文动不了这些
结果。被测产物按名字与版本记（`dsh-worktree-space-1.0.8.tgz`），不记字节数：它自己的文档就在包里。

**0.2.0 线上的回滚那一步用的是「换一个版本装」这个方向**：在已经卸载干净的 profile 里执行
`dsh plugin add dsh-worktree-space@1.0.7`，`0.2.0-rc.1` 与 `0.2.0-rc.2` 都在 pnpm 之前拒绝；逐字比对
before/after，profile 的 `dependencies` 与 `dsh.profile.bundles` 一个字没变
（`["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`），`node_modules/dsh-worktree-space` 不存在，
随后的冷启动干净、首页 0 次命中 —— 拒绝是**干净**的，不留半截状态。7.1 引的那段报错就出自这里。
**0.1.7 线没有这道闸门**（这正是 0.1.7 那一轮漏掉这个问题的原因），所以那三个版本上不跑这个探针；
它们的回滚证据是「卸载 → 再冷启动干净」。

### 7.5 0.2.0 上「产物逐字节相等」这条判据不再适用

第 3 节的端到端证据里记过「取回的 bundle 字节数 = 本地 `client/client.js` + 包装字节数」。0.2.0 线起
这条不成立：客户端的承载端一次返回**一组**模块，URL 形如
`plugins/??<a>/client.js,<b>/client.js,…&rev=<hash>`，本插件的 `client.js` 只占其中一段，而且这一段
在 0.1.7 线上也不总是第一个（alpha.2 与 rc.1 上那一组以 `@deepseek-ai/dsh-client-ui-open-in-app`
打头，整组 5.6–5.7 MB，而 rc.2 与 0.2.0 线的组只有 0.49–0.6 MB）。所以这一轮的判据换成两条：
**页面的模块组里点名了 `dsh-worktree-space/client.js`**，且**取回的那组里能找到
`id: "dsh-worktree-space"`** —— 这是判据随 DSH 变化，不是产物退化；`build.mjs` 的包装与 external
清单一个字没动。

### 7.6 仍未覆盖的

- **第 2.3 节的端到端功能验收没有在这五次运行里做。** 容器根 README、容器根是 git 仓库就拒绝、
  任务空间位置那一档回写，仍然只有单元测试覆盖（见 6.2、6.3 的结尾）—— 本轮的矩阵只回答
  「装得上、起得来、卸得干净、回滚干净」。
- **`--dump-config` 的行数与宿主版本相关，也不能跨版本顺延。** 上表五组数是本轮的实测；
  第 5.1 节那些（1.0.7：装后 1237 / 1237 / 1249，卸载后 1234 / 1234 / 1246）属于 1.0.7 那一轮，
  数值与本轮相同但是两次独立的测量 —— 换 DSH 版本或再改配置字段都要重量。
- **`pnpm install` 每次都会打 `[WARN] Issues with peer dependencies found`**；`pnpm peers check` 给出的
  四条是「缺 peer」而不是版本冲突（这四个 peer 由 profile 自己提供），与 1.0.7 那一轮记的是同一条。
- **`0.2.0-rc.2` 是当前窗口上界。** 本节覆盖的是 npm 上最新的五个已发布版本
  （`npm view @deepseek-ai/dsh versions` 的尾部五个，`dist-tags.latest` = `0.2.0-rc.2`，
  `alpha` 仍指向 `0.1.7-alpha.2`）。官方一发新版，窗口就不再是这五个，本节结论不自动顺延。
- `docs/store-evidence.json` 的 `dsh020CompatibilityRelease` 里记着同样这几点。
